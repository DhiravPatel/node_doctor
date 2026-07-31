/**
 * §77 — OpenAPI Generation From Code (`node-doctor openapi`).
 *
 * Hand-written API docs rot the moment someone edits a route, and nobody notices
 * until an integrator does. This generates the spec FROM the routes themselves,
 * so it is correct by construction: run it in CI and the spec cannot drift from
 * the code that serves it.
 *
 * WHAT IT DERIVES. Route registrations are captured with the same collector the
 * data-map uses (so `openapi`, `surface` and `data-map` agree on what a route
 * is), then each handler is mined for the facts a spec needs:
 *
 *   - PATH PARAMETERS from the route path itself (`/users/:id` → `{id}`), which
 *     is a pure syntactic rewrite.
 *   - QUERY PARAMETERS from `req.query.<name>` reads and `const { a } =
 *     req.query` destructuring inside the handler.
 *   - A REQUEST BODY when the handler reads `req.body` and the method can carry
 *     one. Only its PRESENCE is claimed — never its shape.
 *   - RESPONSE STATUS CODES from `res.status(N)` / `res.sendStatus(N)` numeric
 *     literals, plus the implicit 200 when the handler responds without one.
 *   - SECURITY from the middleware chain: a route behind an auth guard gets a
 *     `bearerAuth` requirement.
 *
 * PRECISION MODEL — the spec never asserts anything it cannot read from source.
 * A dynamic route path is skipped and counted rather than guessed at; a request
 * body is described as a free-form object (`additionalProperties: true`) instead
 * of an invented schema; a `res.status(variable)` contributes nothing. The
 * result is an honest spec: everything in it is provable, and what could not be
 * proven is reported as a coverage gap rather than filled in with fiction.
 *
 * Deterministic: paths sorted, methods in a fixed order, parameters sorted —
 * byte-identical output for identical input, so it can be committed and diffed.
 */

import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { AstNode } from "./types.ts";
import type { NodeDoctorConfig } from "./config.ts";
import { getMethodName, getStaticStringValue, staticMemberPath } from "./ast.ts";
import { collectDescendants, attachParents } from "./walk.ts";
import { resolveScopes } from "./scope.ts";
import { parseSource } from "./parse.ts";
import { createLocator } from "./location.ts";
import { collectRouteHandlers } from "./data-map.ts";
import { extractRoutes } from "./api-surface.ts";
import { BUILTIN_IGNORES } from "./config.ts";
import { mapPool } from "./pool.ts";

// ---------------------------------------------------------------------------
// Public shape.
// ---------------------------------------------------------------------------

export interface OpenApiParameter {
  name: string;
  in: "path" | "query";
  required: boolean;
  schema: { type: string };
}

export interface OpenApiOperation {
  operationId: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    required: boolean;
    content: Record<string, { schema: { type: string; additionalProperties: boolean } }>;
  };
  responses: Record<string, { description: string }>;
  security?: Array<Record<string, string[]>>;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { securitySchemes: Record<string, { type: string; scheme: string }> };
}

export interface OpenApiResult {
  document: OpenApiDocument;
  summary: {
    /** Routes written into the spec. */
    operations: number;
    /** Routes skipped because their path was not statically known. */
    dynamicRoutesSkipped: number;
    /** Operations whose handler yielded no status code (documented as 200). */
    inferredResponses: number;
    securedOperations: number;
  };
}

// ---------------------------------------------------------------------------
// Handler mining.
// ---------------------------------------------------------------------------

/** Express/Koa-style response objects, by the handler's second parameter name. */
const paramName = (fn: AstNode, index: number): string | null => {
  const p = ((fn.params as AstNode[] | undefined) ?? [])[index];
  return p?.type === "Identifier" ? (p.name as string) : null;
};

/**
 * Query-parameter names read inside a handler: `req.query.page`,
 * `req.query["page"]`, and `const { page, size } = req.query`.
 */
const queryParams = (fn: AstNode, reqName: string): Set<string> => {
  const names = new Set<string>();
  const body = (fn.body as AstNode) ?? fn;

  for (const member of collectDescendants(body, (n) => n.type === "MemberExpression", undefined, true)) {
    const objectPath = staticMemberPath(member.object as AstNode);
    if (objectPath !== `${reqName}.query`) continue;
    const property = member.property as AstNode | undefined;
    if (!member.computed && property?.type === "Identifier") {
      names.add(property.name as string);
    } else if (member.computed && property?.type === "Literal" && typeof property.value === "string") {
      names.add(property.value);
    }
  }

  for (const decl of collectDescendants(body, (n) => n.type === "VariableDeclarator", undefined, true)) {
    const init = decl.init as AstNode | undefined;
    if (!init || staticMemberPath(init) !== `${reqName}.query`) continue;
    const id = decl.id as AstNode | undefined;
    if (id?.type !== "ObjectPattern") continue;
    for (const prop of (id.properties as AstNode[] | undefined) ?? []) {
      if (prop.type !== "Property" || prop.computed) continue;
      const key = (prop.key as AstNode | undefined)?.name as string | undefined;
      if (key) names.add(key);
    }
  }
  return names;
};

/** Does the handler read `req.body`? (presence only — never the shape) */
const readsBody = (fn: AstNode, reqName: string): boolean => {
  const body = (fn.body as AstNode) ?? fn;
  for (const member of collectDescendants(body, (n) => n.type === "MemberExpression", undefined, true)) {
    if (staticMemberPath(member) === `${reqName}.body`) return true;
  }
  return false;
};

/** Numeric status codes the handler sets: `res.status(404)` / `res.sendStatus(204)`. */
const statusCodes = (fn: AstNode, resName: string): Set<number> => {
  const codes = new Set<number>();
  const body = (fn.body as AstNode) ?? fn;
  for (const call of collectDescendants(body, (n) => n.type === "CallExpression", undefined, true)) {
    const method = getMethodName(call);
    if (method !== "status" && method !== "sendStatus" && method !== "code") continue;
    const callee = call.callee as AstNode | undefined;
    const receiver = staticMemberPath(callee?.object as AstNode | undefined);
    if (receiver !== resName) continue;
    const arg = ((call.arguments as AstNode[] | undefined) ?? [])[0];
    if (arg?.type === "Literal" && typeof arg.value === "number" && Number.isInteger(arg.value)) {
      codes.add(arg.value);
    }
  }
  return codes;
};

// ---------------------------------------------------------------------------
// Spec assembly.
// ---------------------------------------------------------------------------

/** `/users/:id/posts/:postId` → `/users/{id}/posts/{postId}` + the param names. */
const convertPath = (routePath: string): { path: string; params: string[] } => {
  const params: string[] = [];
  const converted = routePath.replace(/:([A-Za-z_$][\w$]*)\??/g, (_m, name: string) => {
    params.push(name);
    return `{${name}}`;
  });
  // An already-brace-style path (Fastify/Hapi write `{id}` directly).
  for (const m of converted.matchAll(/\{([A-Za-z_$][\w$]*)\}/g)) {
    if (!params.includes(m[1]!)) params.push(m[1]!);
  }
  return { path: converted, params };
};

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  410: "Gone",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** A deterministic, readable operationId: `getUsersById`. */
const operationIdFor = (method: string, specPath: string): string => {
  const segments = specPath
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      const param = /^\{(.+)\}$/.exec(s);
      if (param) return "By" + param[1]!.charAt(0).toUpperCase() + param[1]!.slice(1);
      return s.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ""));
    });
  const tail = segments
    .map((s, i) => (i === 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s.charAt(0).toUpperCase() + s.slice(1)))
    .join("");
  return method.toLowerCase() + (tail || "Root");
};

/** Methods that may carry a request body. */
const BODY_METHODS = new Set(["post", "put", "patch", "delete"]);
/** Fixed emission order so the document is byte-stable. */
const METHOD_ORDER = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

const SOURCE_GLOB = "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";

export const buildOpenApiDocument = async (
  rootDirectory: string,
  options?: { config?: NodeDoctorConfig; title?: string; version?: string },
): Promise<OpenApiResult> => {
  const config = options?.config ?? {};
  const fg = (await import("fast-glob")).default;
  const files = (
    await fg([SOURCE_GLOB], {
      cwd: rootDirectory,
      ignore: [...BUILTIN_IGNORES, ...(config.ignore ?? [])],
      absolute: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    })
  ).sort();

  interface Mined {
    method: string;
    path: string;
    authenticated: boolean;
    query: string[];
    body: boolean;
    codes: number[];
  }

  const perFile = await mapPool(files, 8, async (filePath): Promise<Mined[]> => {
    let sourceText: string;
    try {
      sourceText = await readFile(filePath, "utf8");
    } catch {
      return [];
    }
    if (!/\.(get|post|put|patch|delete|del|options|head|all|route)\s*\(/.test(sourceText)) return [];
    const parsed = parseSource(filePath, sourceText);
    if (parsed.parseFailed) return [];
    attachParents(parsed.program);
    const scope = resolveScopes(parsed.program);
    const locate = createLocator(sourceText);
    const normalizedFilePath = relative(rootDirectory, filePath).split(sep).join("/");

    // Auth posture comes from the surface extractor, keyed by method+path.
    const authByKey = new Map<string, boolean>();
    for (const route of extractRoutes(parsed.program, normalizedFilePath, locate)) {
      authByKey.set(`${route.method} ${route.path}`, route.authenticated);
    }

    const mined: Mined[] = [];
    for (const route of collectRouteHandlers(parsed.program, scope, normalizedFilePath, filePath, locate)) {
      const fn = route.handler;
      const reqName = paramName(fn, 0);
      const resName = paramName(fn, 1);
      mined.push({
        method: route.method,
        path: route.path,
        authenticated: authByKey.get(`${route.method} ${route.path}`) ?? false,
        query: reqName ? [...queryParams(fn, reqName)].sort() : [],
        body: reqName ? readsBody(fn, reqName) : false,
        codes: resName ? [...statusCodes(fn, resName)].sort((a, b) => a - b) : [],
      });
    }
    return mined;
  });

  // Merge duplicate (method, path) registrations across files, unioning facts.
  const merged = new Map<string, Mined>();
  let dynamicRoutesSkipped = 0;
  for (const list of perFile) {
    for (const m of list) {
      if (!m.path.startsWith("/") || m.path.includes("<dynamic>")) {
        dynamicRoutesSkipped++;
        continue;
      }
      const key = `${m.method} ${m.path}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...m });
        continue;
      }
      existing.authenticated = existing.authenticated || m.authenticated;
      existing.body = existing.body || m.body;
      existing.query = [...new Set([...existing.query, ...m.query])].sort();
      existing.codes = [...new Set([...existing.codes, ...m.codes])].sort((a, b) => a - b);
    }
  }

  const paths: OpenApiDocument["paths"] = {};
  let operations = 0;
  let inferredResponses = 0;
  let securedOperations = 0;

  for (const m of [...merged.values()].sort((a, b) =>
    a.path === b.path ? (a.method < b.method ? -1 : 1) : a.path < b.path ? -1 : 1,
  )) {
    const method = m.method.toLowerCase();
    if (method === "all" || !METHOD_ORDER.includes(method)) continue;
    const { path: specPath, params: pathParams } = convertPath(m.path);

    const parameters: OpenApiParameter[] = [
      ...pathParams.map((name) => ({
        name,
        in: "path" as const,
        required: true,
        schema: { type: "string" },
      })),
      ...m.query.map((name) => ({
        name,
        in: "query" as const,
        required: false,
        schema: { type: "string" },
      })),
    ];

    const responses: OpenApiOperation["responses"] = {};
    if (m.codes.length === 0) {
      responses["200"] = { description: STATUS_TEXT[200]! };
      inferredResponses++;
    } else {
      for (const code of m.codes) {
        responses[String(code)] = { description: STATUS_TEXT[code] ?? "Response" };
      }
    }

    // Keys are assigned in the conventional OpenAPI order so the emitted JSON
    // reads naturally (and stays byte-stable).
    const operation = { operationId: operationIdFor(method, specPath) } as OpenApiOperation;
    const tag = specPath.split("/").find((s) => s.length > 0 && !s.startsWith("{"));
    if (tag) operation.tags = [tag];
    if (parameters.length > 0) operation.parameters = parameters;
    if (m.body && BODY_METHODS.has(method)) {
      operation.requestBody = {
        required: true,
        // Presence is provable; the SHAPE is not, so it stays free-form rather
        // than inventing properties that would then be wrong.
        content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
      };
    }
    operation.responses = responses;
    if (m.authenticated) {
      operation.security = [{ bearerAuth: [] }];
      securedOperations++;
    }

    paths[specPath] ??= {};
    paths[specPath]![method] = operation;
    operations++;
  }

  // Re-key with methods in a fixed order so the JSON is byte-stable.
  const orderedPaths: OpenApiDocument["paths"] = {};
  for (const specPath of Object.keys(paths).sort()) {
    const ops = paths[specPath]!;
    const ordered: Record<string, OpenApiOperation> = {};
    for (const method of METHOD_ORDER) {
      if (ops[method]) ordered[method] = ops[method]!;
    }
    orderedPaths[specPath] = ordered;
  }

  let title = options?.title ?? "API";
  let version = options?.version ?? "0.0.0";
  if (!options?.title || !options?.version) {
    try {
      const pkg = JSON.parse(await readFile(join(rootDirectory, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (!options?.title && typeof pkg.name === "string" && pkg.name.length > 0) title = pkg.name;
      if (!options?.version && typeof pkg.version === "string" && pkg.version.length > 0) version = pkg.version;
    } catch {
      /* no package.json — the defaults stand */
    }
  }

  const document: OpenApiDocument = {
    openapi: "3.1.0",
    info: { title, version },
    paths: orderedPaths,
  };
  if (securedOperations > 0) {
    document.components = { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } };
  }

  return {
    document,
    summary: { operations, dynamicRoutesSkipped, inferredResponses, securedOperations },
  };
};
