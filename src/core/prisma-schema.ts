/**
 * §142 — Prisma schema parsing (the deterministic half of dead-schema detection).
 *
 * `schema.prisma` is a small, regular DSL: `model X { field Type @attr … }`,
 * `enum E { A B }`, block attributes (`@@map`, `@@unique`, `@@id`, `@@index`).
 * This parser extracts exactly what the drift report needs — model names, their
 * client properties (`model User` → `prisma.user`), table names (`@@map`), field
 * names (+ `@map` column names), relation fields (a field whose type is another
 * model), compound-unique aliases (`@@unique([a, b])` → the `a_b` where-unique
 * key, or its custom `name:`), and enums — and nothing else. No dependency, no
 * schema-engine: a text scan with a tiny state machine for comments/strings.
 *
 * Deterministic: models, fields, and enums are returned in source order.
 */

export interface PrismaField {
  name: string;
  type: string;
  /** `@map("column")` when present, else the field name. */
  columnName: string;
  isList: boolean;
  isOptional: boolean;
  /** The field's type is another model (or it carries `@relation`) — not a column. */
  isRelation: boolean;
}

export interface PrismaModel {
  name: string;
  /** The Prisma client property: `model User` → `user` (lowered first letter). */
  clientProperty: string;
  /** `@@map("users")` when present, else the model name. */
  tableName: string;
  fields: PrismaField[];
  /** Compound where-unique keys: `@@unique([a, b])` → `a_b` (or its custom `name:`). */
  compoundAliases: string[];
}

export interface PrismaEnum {
  name: string;
  values: string[];
}

export interface PrismaSchema {
  models: PrismaModel[];
  enums: PrismaEnum[];
}

/** Strip `//` line comments outside of double-quoted strings (schema-safe). */
const stripSchemaComments = (text: string): string => {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') inString = !inString;
    if (!inString && c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
};

const lowerFirst = (s: string): string => (s.length > 0 ? s[0]!.toLowerCase() + s.slice(1) : s);

/** `@@map("users")` → `users`; also handles `@@map(name: "users")`. */
const blockMapName = (body: string): string | null => {
  const m = /@@map\(\s*(?:name\s*:\s*)?"([^"]+)"\s*\)/.exec(body);
  return m ? m[1]! : null;
};

/** `@map("col")` on a field line. */
const fieldMapName = (line: string): string | null => {
  const m = /@map\(\s*(?:name\s*:\s*)?"([^"]+)"\s*\)/.exec(line);
  return m ? m[1]! : null;
};

/**
 * Compound keys from `@@unique([a, b])` / `@@id([a, b])`, honoring a custom
 * `name: "alias"` in ANY argument position (`@@unique(name: "k", fields: […])`
 * and `@@unique([…], map: "x", name: "k")` both work). Field references may
 * carry argument lists (`email(sort: Desc, length: 10)`), which are stripped
 * before the default `a_b` alias is joined.
 */
const compoundAliases = (body: string): string[] => {
  const aliases: string[] = [];
  const attrRe = /@@(?:unique|id)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(body)) !== null) {
    // Walk to the matching close paren, string-aware.
    let depth = 1;
    let inString = false;
    let i = m.index + m[0].length;
    const start = i;
    while (i < body.length && depth > 0) {
      const c = body[i]!;
      if (c === '"') inString = !inString;
      else if (!inString && c === "(") depth++;
      else if (!inString && c === ")") depth--;
      i++;
    }
    const args = body.slice(start, i - 1);
    const named = /\bname\s*:\s*"([^"]+)"/.exec(args);
    if (named) {
      aliases.push(named[1]!);
      continue;
    }
    const bracket = /\[([^\]]*)\]/.exec(args);
    if (!bracket) continue;
    const parts = bracket[1]!
      .replace(/\([^)]*\)/g, "") // email(sort: Desc) → email
      .split(",")
      .map((p) => p.trim())
      .filter((p) => /^[A-Za-z_]\w*$/.test(p));
    if (parts.length >= 2) aliases.push(parts.join("_"));
  }
  return aliases;
};

/**
 * Extract `model`/`enum` blocks with a string-aware brace walk — a `}` inside a
 * string literal (`@default("{}")`, `dbgenerated("'{}'::jsonb")`) must not close
 * the block, which a `[^}]*` regex would silently do, truncating the model and
 * "losing" every field after it.
 */
const extractBlocks = (text: string): Array<{ kind: string; name: string; body: string }> => {
  const blocks: Array<{ kind: string; name: string; body: string }> = [];
  const headRe = /\b(model|enum)\s+([A-Za-z_]\w*)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = headRe.exec(text)) !== null) {
    let depth = 1;
    let inString = false;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      const c = text[i]!;
      if (c === '"') inString = !inString;
      else if (!inString && c === "{") depth++;
      else if (!inString && c === "}") depth--;
      i++;
    }
    blocks.push({ kind: m[1]!, name: m[2]!, body: text.slice(start, i - 1) });
    headRe.lastIndex = i;
  }
  return blocks;
};

/**
 * Parse one or more `.prisma` sources (Prisma supports multi-file schemas; pass
 * every file's text) into the model/enum shape above.
 */
export const parsePrismaSchema = (sources: string[]): PrismaSchema => {
  const models: PrismaModel[] = [];
  const enums: PrismaEnum[] = [];

  for (const raw of sources) {
    const text = stripSchemaComments(raw);
    for (const block of extractBlocks(text)) {
      const kind = block.kind;
      const name = block.name;
      const body = block.body;
      if (kind === "enum") {
        const values = body
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^[A-Za-z_]\w*$/.test(l));
        enums.push({ name, values });
        continue;
      }
      const fields: PrismaField[] = [];
      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("@@")) continue;
        const fm = /^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(\[\])?(\?)?/.exec(trimmed);
        if (!fm) continue;
        fields.push({
          name: fm[1]!,
          type: fm[2]!,
          columnName: fieldMapName(trimmed) ?? fm[1]!,
          isList: fm[3] === "[]",
          isOptional: fm[4] === "?",
          isRelation: /@relation\b/.test(trimmed), // completed against model names below
        });
      }
      models.push({
        name,
        clientProperty: lowerFirst(name),
        tableName: blockMapName(body) ?? name,
        fields,
        compoundAliases: compoundAliases(body),
      });
    }
  }

  // A field whose TYPE is another model is a relation even without `@relation`
  // (the non-owning side of a 1-n carries no attribute).
  const modelNames = new Set(models.map((mo) => mo.name));
  for (const model of models) {
    for (const field of model.fields) {
      if (modelNames.has(field.type)) field.isRelation = true;
    }
  }

  return { models, enums };
};
