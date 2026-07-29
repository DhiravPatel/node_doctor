/**
 * §142 — Dead Schema & Schema Drift (`node-doctor schema-drift`).
 *
 * §20 finds dead *code*; this finds dead *data* — and its inverse. Cross the
 * Prisma schema against every statically-visible model access the codebase
 * performs and report, in both directions:
 *
 *   1. DRIFT — code referencing a field the schema does not have
 *      (`prisma.user.findMany({ where: { emial: x } })`): a runtime
 *      `PrismaClientValidationError` waiting on a code path, found at build time,
 *      with a did-you-mean suggestion.
 *   2. DEAD MODELS — a schema model no code path touches: migration debt, backup
 *      cost, and compliance surface (an unused `ssn` column is pure liability).
 *
 * CONSERVATIVE BY DESIGN (a wrong claim is a release blocker):
 *  - A drift finding requires a CONFIDENT Prisma call — a db-hint receiver, a
 *    property matching a schema model's client property, and a known Prisma
 *    method — plus a fully-static argument object: any spread or computed key
 *    silences the whole object. Operator keys (`AND`/`some`/`equals`/`set`/…),
 *    relation traversals (checked against the RELATED model's fields), compound
 *    where-unique aliases (`@@unique([a, b])` → `a_b`), and aggregate outputs
 *    (`_count`/`_sum`/…) are all understood, not flagged.
 *  - Dead-model claims are made ONLY when nothing in the project could hide a
 *    use: no dynamic model access (`prisma[expr]`), no unresolved raw SQL, and no
 *    resolved raw-SQL table matching the model. Otherwise the report says
 *    detection was degraded and claims nothing.
 *
 * Deterministic: files globbed sorted, findings ordered by (file, line, key),
 * models in schema order. Offline, dependency-free.
 */

import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";

import type { AstNode } from "./types.ts";
import type { NodeDoctorConfig } from "./config.ts";
import { getMethodName, getStaticStringValue, staticMemberPath, rootObjectName } from "./ast.ts";
import { collectDescendants, attachParents } from "./walk.ts";
import { parseSource } from "./parse.ts";
import { createLocator } from "./location.ts";
import { BUILTIN_IGNORES } from "./config.ts";
import { mapPool } from "./pool.ts";
import { queryTarget, taggedTemplateTarget, isDbReceiver } from "./data-map.ts";
import { parsePrismaSchema } from "./prisma-schema.ts";
import type { PrismaModel, PrismaSchema } from "./prisma-schema.ts";

// ---------------------------------------------------------------------------
// Public shape.
// ---------------------------------------------------------------------------

/** One code reference to a field the schema does not define. */
export interface DriftFinding {
  model: string;
  /** The unknown key as written in code. */
  key: string;
  /** The argument section it appeared in (where/select/data/orderBy/…). */
  section: string;
  normalizedFilePath: string;
  line: number;
  column: number;
  /** A close schema field (edit distance ≤ 2), when one exists. */
  suggestion: string | null;
}

export interface DeadModelEntry {
  model: string;
  tableName: string;
  fieldCount: number;
}

export interface SchemaDriftReport {
  /** False when no .prisma schema was found — every other field is then empty. */
  schemaPresent: boolean;
  schemaFiles: string[];
  models: number;
  enums: number;
  drift: DriftFinding[];
  /** Models with zero statically-visible uses — only populated when provable. */
  deadModels: DeadModelEntry[];
  /** Why dead-model detection was skipped, when it was. */
  deadModelDetection: "full" | "skipped-dynamic-access" | "skipped-unresolved-raw-sql";
  summary: {
    filesScanned: number;
    modelsUsed: number;
    driftFindings: number;
    deadModels: number;
  };
}

// ---------------------------------------------------------------------------
// Prisma argument vocabulary — keys that are OPERATORS, not field names.
// ---------------------------------------------------------------------------

/** Boolean combinators + relation quantifiers + aggregate outputs valid in `where`. */
const WHERE_OPERATORS = new Set([
  "AND", "OR", "NOT",
  "some", "every", "none", "is", "isNot",
  "_count", "_relevance",
]);

/** Nested write operations valid under a RELATION key in `data`. */
const DATA_RELATION_OPS = new Set([
  "create", "createMany", "connect", "connectOrCreate", "set", "disconnect",
  "delete", "update", "updateMany", "upsert", "deleteMany",
]);

/** Aggregate output selectors, valid at the top of aggregate/groupBy args. */
const AGGREGATE_KEYS = new Set(["_count", "_sum", "_avg", "_min", "_max"]);

/** Keys of the standard query-argument object, mapped to how their value is walked. */
type Section =
  | "where" | "select" | "include" | "omit" | "data" | "create" | "update"
  | "orderBy" | "cursor" | "distinct" | "by";

const ARG_SECTIONS = new Set<Section>([
  "where", "select", "include", "omit", "data", "create", "update",
  "orderBy", "cursor", "distinct", "by",
]);

/** Prisma model methods whose first argument is the standard shape above. */
const PRISMA_ARG_METHODS = new Set([
  "findMany", "findFirst", "findUnique", "findFirstOrThrow", "findUniqueOrThrow",
  "create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert",
  "delete", "deleteMany", "count", "aggregate", "groupBy",
]);

/** ANY method that marks a model as used (superset of the above). */
const PRISMA_USE_METHODS = new Set([...PRISMA_ARG_METHODS, "fields"]);

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

/** Levenshtein distance, bounded — for did-you-mean suggestions. */
const editDistance = (a: string, b: string): number => {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
};

const suggestField = (key: string, model: PrismaModel): string | null => {
  let best: string | null = null;
  let bestD = 3;
  for (const f of model.fields) {
    const d = editDistance(key.toLowerCase(), f.name.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = f.name;
    }
  }
  return bestD <= 2 ? best : null;
};

/** The literal key of a Property, or null for computed/unusual keys. */
const propertyKey = (prop: AstNode): string | null => {
  if (prop.type !== "Property" || prop.computed) return null;
  const key = prop.key as AstNode | undefined;
  if (key?.type === "Identifier") return key.name as string;
  if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
};

/** True when an object literal contains a spread or a computed key — bail out. */
const hasOpaqueParts = (obj: AstNode): boolean => {
  for (const p of (obj.properties as AstNode[] | undefined) ?? []) {
    if (p.type === "SpreadElement" || p.type === "SpreadProperty") return true;
    if (p.type === "Property" && p.computed) return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// The recursive argument walk.
// ---------------------------------------------------------------------------

interface WalkContext {
  modelsByName: Map<string, PrismaModel>;
  report: (model: PrismaModel, key: string, section: string, node: AstNode) => void;
  /** Credit a model as used — a relation traversal reads/writes the RELATED table too. */
  use: (modelName: string) => void;
}

/** The related model a relation field points at, when the schema knows it. Resolving
 *  one IS a use: `include: { posts: true }` reads Post rows, `data: { posts: { create } }`
 *  writes them — dropping Post would break this code, so it is never dead. */
const relatedModel = (model: PrismaModel, fieldName: string, wctx: WalkContext): PrismaModel | null => {
  const field = model.fields.find((f) => f.name === fieldName);
  if (!field || !field.isRelation) return null;
  const rel = wctx.modelsByName.get(field.type) ?? null;
  if (rel) wctx.use(rel.name);
  return rel;
};

const fieldNames = (model: PrismaModel): Set<string> => new Set(model.fields.map((f) => f.name));

const walkWhere = (model: PrismaModel, node: AstNode | undefined, wctx: WalkContext): void => {
  if (!node) return;
  if (node.type === "ArrayExpression") {
    for (const el of (node.elements as AstNode[] | undefined) ?? []) {
      if (el) walkWhere(model, el, wctx);
    }
    return;
  }
  if (node.type !== "ObjectExpression" || hasOpaqueParts(node)) return;
  const fields = fieldNames(model);
  for (const prop of (node.properties as AstNode[] | undefined) ?? []) {
    const key = propertyKey(prop);
    if (key === null) continue;
    const value = prop.value as AstNode;
    if (key === "AND" || key === "OR" || key === "NOT") {
      walkWhere(model, value, wctx);
      continue;
    }
    if (WHERE_OPERATORS.has(key)) continue;
    if (model.compoundAliases.includes(key)) continue;
    if (fields.has(key)) {
      // A relation key nests quantifiers or a where-shape for the RELATED model.
      const rel = relatedModel(model, key, wctx);
      if (rel && value?.type === "ObjectExpression" && !hasOpaqueParts(value)) {
        for (const sub of (value.properties as AstNode[] | undefined) ?? []) {
          const subKey = propertyKey(sub);
          if (subKey && (subKey === "some" || subKey === "every" || subKey === "none" || subKey === "is" || subKey === "isNot")) {
            walkWhere(rel, sub.value as AstNode, wctx);
          }
        }
      }
      continue;
    }
    wctx.report(model, key, "where", prop);
  }
};

const walkSelect = (model: PrismaModel, node: AstNode | undefined, section: string, wctx: WalkContext): void => {
  if (!node || node.type !== "ObjectExpression" || hasOpaqueParts(node)) return;
  const fields = fieldNames(model);
  for (const prop of (node.properties as AstNode[] | undefined) ?? []) {
    const key = propertyKey(prop);
    if (key === null) continue;
    // `_count` selects relation counts; `_all` is the count() aggregate column.
    if (key === "_count" || key === "_all") continue;
    if (!fields.has(key)) {
      wctx.report(model, key, section, prop);
      continue;
    }
    const rel = relatedModel(model, key, wctx);
    const value = prop.value as AstNode;
    if (rel && value?.type === "ObjectExpression" && !hasOpaqueParts(value)) {
      for (const sub of (value.properties as AstNode[] | undefined) ?? []) {
        const subKey = propertyKey(sub);
        if (subKey === "select" || subKey === "include" || subKey === "omit") {
          walkSelect(rel, sub.value as AstNode, subKey, wctx);
        } else if (subKey === "where") {
          walkWhere(rel, sub.value as AstNode, wctx);
        } else if (subKey === "orderBy") {
          walkOrderBy(rel, sub.value as AstNode, wctx);
        }
      }
    }
  }
};

const walkData = (model: PrismaModel, node: AstNode | undefined, wctx: WalkContext): void => {
  if (!node) return;
  if (node.type === "ArrayExpression") {
    for (const el of (node.elements as AstNode[] | undefined) ?? []) {
      if (el) walkData(model, el, wctx);
    }
    return;
  }
  if (node.type !== "ObjectExpression" || hasOpaqueParts(node)) return;
  const fields = fieldNames(model);
  for (const prop of (node.properties as AstNode[] | undefined) ?? []) {
    const key = propertyKey(prop);
    if (key === null) continue;
    if (!fields.has(key)) {
      wctx.report(model, key, "data", prop);
      continue;
    }
    const rel = relatedModel(model, key, wctx);
    const value = prop.value as AstNode;
    if (rel && value?.type === "ObjectExpression" && !hasOpaqueParts(value)) {
      for (const sub of (value.properties as AstNode[] | undefined) ?? []) {
        const subKey = propertyKey(sub);
        if (!subKey || !DATA_RELATION_OPS.has(subKey)) continue;
        const subValue = sub.value as AstNode;
        if (subKey === "create") {
          walkData(rel, subValue, wctx);
        } else if (subKey === "createMany") {
          // Envelope: { data: […], skipDuplicates?: boolean } — only `data`
          // holds related-model fields; the envelope keys are Prisma API.
          walkData(rel, envelopeValue(subValue, "data"), wctx);
        } else if (subKey === "update" || subKey === "updateMany" || subKey === "upsert") {
          // To-many (and modern to-one) forms are envelopes — objects or arrays
          // of `{ where?, data?, create?, update? }`. A bare to-one shorthand
          // (fields directly) is walked as data only when NO envelope key is
          // present, so the one valid spelling is never flagged.
          walkRelationEnvelopes(rel, subValue, wctx);
        } else if (subKey === "connect" || subKey === "connectOrCreate" || subKey === "disconnect" || subKey === "delete" || subKey === "deleteMany" || subKey === "set") {
          walkConnectLike(rel, subKey, subValue, wctx);
        }
      }
    }
  }
};

/** The value of one named property of an object expression, or undefined. */
const envelopeValue = (node: AstNode | undefined, key: string): AstNode | undefined => {
  if (!node || node.type !== "ObjectExpression" || hasOpaqueParts(node)) return undefined;
  for (const prop of (node.properties as AstNode[] | undefined) ?? []) {
    if (propertyKey(prop) === key) return prop.value as AstNode;
  }
  return undefined;
};

const ENVELOPE_KEYS = new Set(["where", "data", "create", "update"]);

/** Nested relation `update`/`updateMany`/`upsert` values: `{ where?, data?, create?,
 *  update? }` envelopes (single or array). Each envelope part is walked against the
 *  section it actually is; an object with NO envelope keys is the to-one shorthand
 *  and is walked as bare data. */
const walkRelationEnvelopes = (rel: PrismaModel, node: AstNode | undefined, wctx: WalkContext): void => {
  if (!node) return;
  if (node.type === "ArrayExpression") {
    for (const el of (node.elements as AstNode[] | undefined) ?? []) {
      if (el) walkRelationEnvelopes(rel, el, wctx);
    }
    return;
  }
  if (node.type !== "ObjectExpression" || hasOpaqueParts(node)) return;
  const props = (node.properties as AstNode[] | undefined) ?? [];
  const isEnvelope = props.some((p) => {
    const k = propertyKey(p);
    return k !== null && ENVELOPE_KEYS.has(k);
  });
  if (!isEnvelope) {
    walkData(rel, node, wctx);
    return;
  }
  for (const p of props) {
    const k = propertyKey(p);
    const v = p.value as AstNode;
    if (k === "where") walkWhere(rel, v, wctx);
    else if (k === "data" || k === "create") walkData(rel, v, wctx);
    else if (k === "update") walkRelationEnvelopes(rel, v, wctx);
  }
};

/** `connect`/`disconnect`/`set`/`delete` take where-unique inputs (single or array);
 *  `connectOrCreate` takes `{ where, create }` envelopes; `deleteMany` takes a
 *  plain where filter. */
const walkConnectLike = (rel: PrismaModel, op: string, node: AstNode | undefined, wctx: WalkContext): void => {
  if (!node) return;
  if (node.type === "ArrayExpression") {
    for (const el of (node.elements as AstNode[] | undefined) ?? []) {
      if (el) walkConnectLike(rel, op, el, wctx);
    }
    return;
  }
  if (op === "connectOrCreate") {
    walkWhere(rel, envelopeValue(node, "where"), wctx);
    walkData(rel, envelopeValue(node, "create"), wctx);
    return;
  }
  // `disconnect: true` / `delete: true` (to-one boolean forms) walk nothing.
  if (node.type !== "ObjectExpression") return;
  walkWhere(rel, node, wctx);
};

const walkOrderBy = (model: PrismaModel, node: AstNode | undefined, wctx: WalkContext): void => {
  if (!node) return;
  if (node.type === "ArrayExpression") {
    for (const el of (node.elements as AstNode[] | undefined) ?? []) {
      if (el) walkOrderBy(model, el, wctx);
    }
    return;
  }
  if (node.type !== "ObjectExpression" || hasOpaqueParts(node)) return;
  const fields = fieldNames(model);
  for (const prop of (node.properties as AstNode[] | undefined) ?? []) {
    const key = propertyKey(prop);
    if (key === null) continue;
    if (key === "_count" || key === "_relevance") continue;
    if (!fields.has(key)) {
      wctx.report(model, key, "orderBy", prop);
      continue;
    }
    const rel = relatedModel(model, key, wctx);
    if (rel) walkOrderBy(rel, prop.value as AstNode, wctx);
  }
};

/** `distinct: ["a", "b"]` / `by: ["a"]` — every string element must be a field. */
const walkFieldList = (model: PrismaModel, node: AstNode | undefined, section: string, wctx: WalkContext): void => {
  if (!node) return;
  const elements =
    node.type === "ArrayExpression" ? ((node.elements as AstNode[] | undefined) ?? []) : [node];
  const fields = fieldNames(model);
  for (const el of elements) {
    if (!el || el.type !== "Literal" || typeof el.value !== "string") continue;
    if (!fields.has(el.value)) wctx.report(model, el.value, section, el);
  }
};

/** Walk one standard Prisma argument object for the given model. */
const walkArgs = (model: PrismaModel, arg: AstNode | undefined, wctx: WalkContext): void => {
  if (!arg || arg.type !== "ObjectExpression" || hasOpaqueParts(arg)) return;
  for (const prop of (arg.properties as AstNode[] | undefined) ?? []) {
    const key = propertyKey(prop);
    if (key === null) continue;
    const value = prop.value as AstNode;
    if (!ARG_SECTIONS.has(key as Section) && !AGGREGATE_KEYS.has(key)) continue;
    switch (key as Section | "_count") {
      case "where":
      case "cursor":
        walkWhere(model, value, wctx);
        break;
      case "select":
      case "include":
      case "omit":
        walkSelect(model, value, key, wctx);
        break;
      case "data":
      case "create":
      case "update":
        walkData(model, value, wctx);
        break;
      case "orderBy":
        walkOrderBy(model, value, wctx);
        break;
      case "distinct":
      case "by":
        walkFieldList(model, value, key, wctx);
        break;
      default:
        // _count/_sum/_avg/_min/_max: an object keyed by fields (or `true`).
        if (AGGREGATE_KEYS.has(key) && value?.type === "ObjectExpression" && !hasOpaqueParts(value)) {
          const fields = fieldNames(model);
          for (const sub of (value.properties as AstNode[] | undefined) ?? []) {
            const subKey = propertyKey(sub);
            if (subKey && subKey !== "_all" && !fields.has(subKey)) {
              wctx.report(model, subKey, key, sub);
            }
          }
        }
        break;
    }
  }
};

// ---------------------------------------------------------------------------
// The per-file scan.
// ---------------------------------------------------------------------------

interface FileScan {
  normalizedFilePath: string;
  drift: DriftFinding[];
  usedModels: Set<string>;
  dynamicAccess: boolean;
  unresolvedRaw: number;
  rawTables: Set<string>;
}

const SOURCE_GLOB = "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";

const scanFile = (
  sourceText: string,
  normalizedFilePath: string,
  schema: PrismaSchema,
  filePath: string,
): FileScan | null => {
  const parsed = parseSource(filePath, sourceText);
  if (parsed.parseFailed) return null;
  const program = parsed.program;
  attachParents(program);
  const locate = createLocator(sourceText);

  const modelsByProperty = new Map<string, PrismaModel>();
  for (const m of schema.models) modelsByProperty.set(m.clientProperty, m);
  const modelsByName = new Map<string, PrismaModel>();
  for (const m of schema.models) modelsByName.set(m.name, m);

  const scan: FileScan = {
    normalizedFilePath,
    drift: [],
    usedModels: new Set(),
    dynamicAccess: false,
    unresolvedRaw: 0,
    rawTables: new Set(),
  };

  const wctx: WalkContext = {
    modelsByName,
    report: (model, key, section, node) => {
      const loc = locate(node.start as number);
      scan.drift.push({
        model: model.name,
        key,
        section,
        normalizedFilePath,
        line: loc.line,
        column: loc.column,
        suggestion: suggestField(key, model),
      });
    },
    use: (modelName) => scan.usedModels.add(modelName),
  };

  /**
   * Local names that hold a derived Prisma client — `const enhanced =
   * prisma.$extends(…)` (Prisma's documented extension idiom) or a similar
   * client-producing call rooted at a db hint. Calls through such a name are
   * Prisma calls even when the name itself carries no db hint.
   */
  const localClientAliases = new Set<string>();
  for (const decl of collectDescendants(program, (n) => n.type === "VariableDeclarator", undefined, true)) {
    const init = decl.init as AstNode | undefined;
    const id = decl.id as AstNode | undefined;
    if (!init || id?.type !== "Identifier") continue;
    if (init.type !== "CallExpression" && init.type !== "AwaitExpression") continue;
    const call = init.type === "AwaitExpression" ? (init.argument as AstNode) : init;
    if (!call || call.type !== "CallExpression") continue;
    const calleePath = staticMemberPath(call.callee as AstNode);
    if (!calleePath) continue;
    const segments = calleePath.split(".");
    const last = segments[segments.length - 1] ?? "";
    const root = segments.slice(0, -1).join(".");
    if ((last === "$extends" || last === "withExtensions") && root && isDbReceiver(root)) {
      localClientAliases.add(id.name as string);
    }
  }
  // A RENAMED import of a client (`import { prisma as store } from "./client"`)
  // hides the db hint behind the local alias — the IMPORTED name carries the
  // hint, so the local name is a client too.
  for (const stmt of (program.body as AstNode[] | undefined) ?? []) {
    if (stmt.type !== "ImportDeclaration") continue;
    for (const spec of (stmt.specifiers as AstNode[] | undefined) ?? []) {
      if (spec.type !== "ImportSpecifier") continue;
      const imported = (spec.imported as AstNode | undefined)?.name as string | undefined;
      const local = (spec.local as AstNode | undefined)?.name as string | undefined;
      if (imported && local && imported !== local && isDbReceiver(imported)) {
        localClientAliases.add(local);
      }
    }
  }
  const isClientReceiver = (path: string): boolean =>
    isDbReceiver(path) || localClientAliases.has(path.split(".")[0] ?? path);

  const nodes = collectDescendants(
    program,
    (n) =>
      n.type === "CallExpression" ||
      n.type === "TaggedTemplateExpression" ||
      n.type === "MemberExpression" ||
      n.type === "VariableDeclarator",
    undefined,
    true,
  );

  for (const node of nodes) {
    // Aliasing a model handle credits the model as used, so
    // `const u = prisma.user; u.findMany()` and `const { user } = prisma` never
    // yield a wrong dead-model claim (the alias's later calls are opaque to us —
    // usage is the conservative interpretation).
    if (node.type === "VariableDeclarator") {
      const init = node.init as AstNode | undefined;
      if (init?.type === "MemberExpression" && !init.computed) {
        const prop = (init.property as AstNode | undefined)?.type === "Identifier"
          ? ((init.property as AstNode).name as string)
          : null;
        const objPath = staticMemberPath(init.object as AstNode) ?? rootObjectName(init.object as AstNode);
        if (prop && objPath && isDbReceiver(objPath)) {
          const aliased = modelsByProperty.get(prop);
          if (aliased) scan.usedModels.add(aliased.name);
        }
      }
      if (init?.type === "Identifier" && isDbReceiver(init.name as string) && node.id?.type === "ObjectPattern") {
        for (const p of ((node.id as AstNode).properties as AstNode[] | undefined) ?? []) {
          const key = p.type === "Property" && !p.computed && (p.key as AstNode)?.type === "Identifier"
            ? ((p.key as AstNode).name as string)
            : null;
          const destructured = key ? modelsByProperty.get(key) : undefined;
          if (destructured) scan.usedModels.add(destructured.name);
        }
      }
      continue;
    }

    if (node.type === "MemberExpression") {
      const obj = node.object as AstNode | undefined;
      const objPath = staticMemberPath(obj) ?? (obj?.type === "Identifier" ? (obj.name as string) : null);
      if (node.computed) {
        const propNode = node.property as AstNode | undefined;
        const staticKey =
          propNode?.type === "Literal" && typeof propNode.value === "string" ? propNode.value : null;
        if (objPath && isClientReceiver(objPath)) {
          if (staticKey !== null) {
            // client["user"] with a STATIC key reaches the model just like
            // client.user — credit it (assignment/call/delete alike).
            const accessed = modelsByProperty.get(staticKey);
            if (accessed) scan.usedModels.add(accessed.name);
          } else {
            // Truly dynamic model access — degrades the dead-model proof.
            scan.dynamicAccess = true;
          }
        }
        continue;
      }
      // ANY bare `client.<model>` access credits the model — the handle may be
      // assigned (`u = prisma.user`), returned, or passed along, and each of those
      // reaches the table at runtime. Crediting usage is always the conservative
      // direction for dead-model claims.
      const propNode = node.property as AstNode | undefined;
      const prop = propNode?.type === "Identifier" ? (propNode.name as string) : null;
      if (prop && objPath && isClientReceiver(objPath)) {
        const accessed = modelsByProperty.get(prop);
        if (accessed) scan.usedModels.add(accessed.name);
      }
      continue;
    }

    if (node.type === "TaggedTemplateExpression") {
      const t = taggedTemplateTarget(node);
      if (t) {
        if (t.entity !== null) scan.rawTables.add(t.entity.toLowerCase());
        else scan.unresolvedRaw++;
      }
      continue;
    }

    if (node.type !== "CallExpression") continue;

    // Raw-SQL usage (db.query / $queryRawUnsafe / knex) via the shared classifier.
    const target = queryTarget(node);
    if (target) {
      if (target.entity !== null) scan.rawTables.add(target.entity.toLowerCase());
      else scan.unresolvedRaw++;
    }

    // Confident Prisma model calls: <db-hint>.<clientProperty>.<method>(args).
    const method = getMethodName(node);
    if (!method || !PRISMA_USE_METHODS.has(method)) continue;
    const calleeExpr = node.callee as AstNode | undefined;
    if (!calleeExpr || calleeExpr.type !== "MemberExpression") continue;
    const receiverExpr = calleeExpr.object as AstNode | undefined;
    if (!receiverExpr || receiverExpr.type !== "MemberExpression" || receiverExpr.computed) continue;
    const propNode = receiverExpr.property as AstNode | undefined;
    const modelProp = propNode?.type === "Identifier" ? (propNode.name as string) : null;
    if (!modelProp) continue;
    const model = modelsByProperty.get(modelProp);
    if (!model) continue;
    const clientExpr = receiverExpr.object as AstNode | undefined;
    const clientPath = staticMemberPath(clientExpr) ?? rootObjectName(clientExpr ?? null);
    if (!clientPath || !isClientReceiver(clientPath)) continue;

    scan.usedModels.add(model.name);
    if (PRISMA_ARG_METHODS.has(method)) {
      walkArgs(model, ((node.arguments as AstNode[] | undefined) ?? [])[0], wctx);
    }
  }

  return scan;
};

// ---------------------------------------------------------------------------
// Assembly.
// ---------------------------------------------------------------------------

export const buildSchemaDriftReport = async (
  rootDirectory: string,
  options?: { config?: NodeDoctorConfig },
): Promise<SchemaDriftReport> => {
  const config = options?.config ?? {};
  const fg = (await import("fast-glob")).default;

  const schemaFiles = (
    await fg(["**/*.prisma"], {
      cwd: rootDirectory,
      ignore: [...BUILTIN_IGNORES, ...(config.ignore ?? [])],
      absolute: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    })
  ).sort();

  const empty: SchemaDriftReport = {
    schemaPresent: false,
    schemaFiles: [],
    models: 0,
    enums: 0,
    drift: [],
    deadModels: [],
    deadModelDetection: "full",
    summary: { filesScanned: 0, modelsUsed: 0, driftFindings: 0, deadModels: 0 },
  };
  if (schemaFiles.length === 0) return empty;

  const sources: string[] = [];
  for (const f of schemaFiles) {
    try {
      sources.push(await readFile(f, "utf8"));
    } catch {
      /* unreadable schema file — skip */
    }
  }
  const schema = parsePrismaSchema(sources);
  if (schema.models.length === 0) {
    return {
      ...empty,
      schemaPresent: true,
      schemaFiles: schemaFiles.map((f) => relative(rootDirectory, f).split(sep).join("/")),
      enums: schema.enums.length,
    };
  }

  const files = (
    await fg([SOURCE_GLOB], {
      cwd: rootDirectory,
      ignore: [...BUILTIN_IGNORES, ...(config.ignore ?? [])],
      absolute: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    })
  ).sort();

  const scans = (
    await mapPool(files, 8, async (filePath) => {
      let sourceText: string;
      try {
        sourceText = await readFile(filePath, "utf8");
      } catch {
        return null;
      }
      const normalizedFilePath = relative(rootDirectory, filePath).split(sep).join("/");
      return scanFile(sourceText, normalizedFilePath, schema, filePath);
    })
  ).filter((s): s is FileScan => s !== null);

  const drift: DriftFinding[] = scans
    .flatMap((s) => s.drift)
    .sort(
      (a, b) =>
        a.normalizedFilePath.localeCompare(b.normalizedFilePath) ||
        a.line - b.line ||
        a.key.localeCompare(b.key),
    );

  const usedModels = new Set<string>();
  const rawTables = new Set<string>();
  let dynamicAccess = false;
  let unresolvedRaw = 0;
  for (const s of scans) {
    for (const m of s.usedModels) usedModels.add(m);
    for (const t of s.rawTables) rawTables.add(t);
    dynamicAccess ||= s.dynamicAccess;
    unresolvedRaw += s.unresolvedRaw;
  }
  // A raw-SQL table naming a model (by table name, model name, or client property)
  // marks that model used.
  for (const model of schema.models) {
    if (
      rawTables.has(model.tableName.toLowerCase()) ||
      rawTables.has(model.name.toLowerCase()) ||
      rawTables.has(model.clientProperty.toLowerCase())
    ) {
      usedModels.add(model.name);
    }
  }

  const deadModelDetection: SchemaDriftReport["deadModelDetection"] = dynamicAccess
    ? "skipped-dynamic-access"
    : unresolvedRaw > 0
      ? "skipped-unresolved-raw-sql"
      : "full";

  const deadModels: DeadModelEntry[] =
    deadModelDetection === "full"
      ? schema.models
          .filter((m) => !usedModels.has(m.name))
          .map((m) => ({
            model: m.name,
            tableName: m.tableName,
            fieldCount: m.fields.filter((f) => !f.isRelation).length,
          }))
      : [];

  return {
    schemaPresent: true,
    schemaFiles: schemaFiles.map((f) => relative(rootDirectory, f).split(sep).join("/")),
    models: schema.models.length,
    enums: schema.enums.length,
    drift,
    deadModels,
    deadModelDetection,
    summary: {
      filesScanned: scans.length,
      modelsUsed: usedModels.size,
      driftFindings: drift.length,
      deadModels: deadModels.length,
    },
  };
};
