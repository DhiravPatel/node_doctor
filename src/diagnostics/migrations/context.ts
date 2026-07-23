/**
 * Shared parsing context for the migration diagnostics.
 *
 * Migrations are the one place where a text diagnostic beats an AST one: the
 * dangerous statement is usually raw SQL in a `.sql` file that never reaches the
 * ESTree walker, and the blast radius is production data rather than a request.
 * But "a line containing DROP TABLE" is far too crude to ship — the same text is
 * a release blocker in an up migration, the entire point of a down migration,
 * and meaningless in a comment. So everything here exists to buy *context*
 * before a diagnostic is allowed to speak:
 *
 *  - `maskSql` blanks comments and string bodies in place (length preserved), so
 *    a commented-out example and a DDL statement inside a plpgsql function body
 *    are both invisible while every byte offset still maps to its real line.
 *  - `splitStatements` reconstructs whole statements up to the `;`, because a
 *    real ALTER TABLE spans lines and a per-line regex would miss the DEFAULT
 *    two lines down and fire falsely.
 *  - down/rollback regions are resolved for both SQL section markers and JS/TS
 *    `down()` bodies, and when that resolution fails we return nothing at all.
 *
 * Sound toward silence: any file we cannot confidently classify as a migration,
 * and any JS/TS migration whose `down` we cannot brace-match, yields no units
 * and therefore no findings.
 */

/** One contiguous half-open byte range of the original file. */
export interface Region {
  start: number;
  end: number;
}

/** A masked SQL fragment plus the absolute offset of its first byte in the file. */
export interface SqlUnit {
  text: string;
  base: number;
}

/** A single reconstructed statement, offsets relative to its unit's `text`. */
export interface SqlStatement {
  text: string;
  start: number;
  end: number;
}

/** A knex/objection-style destructive builder call found in a JS/TS migration. */
export interface BuilderCall {
  name: string;
  /** Absolute offset of the method name. */
  offset: number;
}

export interface MigrationFile {
  kind: "sql" | "js";
  /** Masked SQL to analyse: the whole file for `.sql`, each SQL literal for JS/TS. */
  units: SqlUnit[];
  builderCalls: BuilderCall[];
  /** Absolute ranges that are a down/rollback path. */
  downRegions: Region[];
  /** Byte offset of the start of every line, for offset -> line/column. */
  lineStarts: number[];
  /** Original file text (unmasked) — only for whole-file heuristics. */
  raw: string;
}

const SQL_EXT_RE = /\.sql$/i;
const JS_EXT_RE = /\.[mc]?[jt]s$/i;
/** A `migrations/` or `migrate/` path segment covers knex, TypeORM, Prisma, Rails-style `db/migrate`. */
const MIGRATION_SEGMENT_RE = /(^|\/)(migrations|migrate)(\/|$)/i;
/** Tests, type declarations and generated barrels are not migrations. */
const NON_MIGRATION_RE = /(^|\/)[^/]*\.(d|test|spec)\.[mc]?[jt]s$|(^|\/)index\.[mc]?[jt]s$/i;

/**
 * Every migration runner (knex, TypeORM, umzug, node-pg-migrate) requires an
 * `up`. Without one, a module under `migrate/` is the *runner*, not a migration
 * — and a runner is exactly the kind of file that legitimately contains the
 * string `DROP TABLE`.
 */
const UP_DECL_RES: readonly RegExp[] = [
  /\bexports\s*\.\s*up\s*=/,
  /\bexport\s+(?:async\s+)?function\s+up\b/,
  /\bexport\s+(?:const|let|var)\s+up\b/,
  /(?:^|[^\w$.])(?:public\s+|protected\s+|private\s+)?(?:async\s+)?up\s*\(/,
  /(?:^|[^\w$.])up\s*[:=]\s*(?:async\s*)?(?:function\b|\()/,
];

const DOWN_DECL_RES: readonly RegExp[] = [
  /\bexports\s*\.\s*down\s*=/g,
  /\bexport\s+(?:async\s+)?function\s+down\b/g,
  /\bexport\s+(?:const|let|var)\s+down\b/g,
  /(?:^|[^\w$.])(?:public\s+|protected\s+|private\s+)?(?:async\s+)?down\s*\(/g,
  /(?:^|[^\w$.])down\s*[:=]\s*(?:async\s*)?(?:function\b|\()/g,
];

/**
 * Section markers used by the SQL-file runners: `-- +migrate Down` (sql-migrate),
 * `-- +goose Down`, `-- migrate:down` (dbmate), a bare `-- Down`, and
 * `--rollback` (liquibase).
 */
const DOWN_MARKER_RE = /^[ \t]*(?:--+|#)[ \t]*(?:\+?(?:migrate|goose)[ \t:]+)?(?:down|rollback)\b/i;
const UP_MARKER_RE = /^[ \t]*(?:--+|#)[ \t]*(?:\+?(?:migrate|goose)[ \t:]+)?up\b/i;
/** `20240101_add_x.down.sql`, `down.sql`, `down/0001.sql` — the whole file is a rollback. */
const DOWN_FILENAME_RE = /(^|\/)down(\/|\.)|[._-]down\.[^/]+$|(^|\/)(rollback|undo)(\/|\.)/i;

/** Is this path a migration we are willing to reason about at all? */
export const isMigrationPath = (normalizedFilePath: string): boolean => {
  if (!MIGRATION_SEGMENT_RE.test(normalizedFilePath)) return false;
  if (SQL_EXT_RE.test(normalizedFilePath)) return true;
  if (!JS_EXT_RE.test(normalizedFilePath)) return false;
  return !NON_MIGRATION_RE.test(normalizedFilePath);
};

/**
 * Blank out SQL comments and the *bodies* of quoted literals, preserving both
 * length and newlines so every offset still maps to its original line. Delimiters
 * are kept so tokens either side never merge into one word.
 *
 * Dollar-quoted bodies are blanked wholesale: a plpgsql function body is code we
 * are not executing, and a DROP inside one is not a migration step.
 */
export const maskSql = (sql: string): string => {
  const out = sql.split("");
  const n = sql.length;
  const blank = (from: number, to: number): void => {
    for (let i = Math.max(0, from); i < Math.min(to, n); i++) if (out[i] !== "\n") out[i] = " ";
  };

  let i = 0;
  let atLineStart = true;
  while (i < n) {
    const c = sql[i]!;
    if (c === "\n") {
      atLineStart = true;
      i++;
      continue;
    }
    // `--` line comment.
    if (c === "-" && sql[i + 1] === "-") {
      let j = i;
      while (j < n && sql[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    // MySQL `#` comment, only at the start of a line: `#` is also a Postgres operator.
    if (c === "#" && atLineStart) {
      let j = i;
      while (j < n && sql[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    // Block comment; Postgres nests them.
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    // Single-quoted literal (`''` is the escape).
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      blank(i + 1, Math.max(i + 1, j - 1));
      i = j;
      atLineStart = false;
      continue;
    }
    // Dollar-quoted body: `$$ … $$` or `$tag$ … $tag$`. `$1` is a placeholder, not a quote.
    if (c === "$") {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const end = close === -1 ? n : close + tag[0].length;
        blank(i + tag[0].length, close === -1 ? n : close);
        i = end;
        atLineStart = false;
        continue;
      }
    }
    if (c !== " " && c !== "\t" && c !== "\r") atLineStart = false;
    i++;
  }
  return out.join("");
};

/**
 * Reconstruct whole statements up to the `;`. Safe on masked text: every `;`
 * that survives masking is a real statement terminator.
 */
export const splitStatements = (masked: string): SqlStatement[] => {
  const out: SqlStatement[] = [];
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== ";") continue;
    if (masked.slice(start, i).trim().length > 0) out.push({ text: masked.slice(start, i), start, end: i });
    start = i + 1;
  }
  if (masked.slice(start).trim().length > 0) out.push({ text: masked.slice(start), start, end: masked.length });
  return out;
};

/** Byte offsets of the start of every line. */
export const computeLineStarts = (text: string): number[] => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
};

/** 1-based line and column for an absolute offset. */
export const positionOf = (lineStarts: number[], offset: number): { line: number; column: number } => {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo]! + 1 };
};

export const inRegions = (regions: readonly Region[], offset: number): boolean =>
  regions.some((r) => offset >= r.start && offset < r.end);

/** Strip quoting/schema from an identifier and case-fold it. */
export const normalizeIdentifier = (raw: string): string => {
  let id = raw.trim().replace(/[;,()]+$/, "");
  const dot = id.lastIndexOf(".");
  // Only split on a dot that is not inside quotes — good enough for `public.users`.
  if (dot !== -1 && !/["`\]]/.test(id.slice(dot))) id = id.slice(dot + 1);
  id = id.replace(/^[`"[]/, "").replace(/[`"\]]$/, "");
  return id.toLowerCase();
};

/**
 * The end of the clause starting at `from`: the next top-level comma, or the end
 * of the text. Parenthesised type modifiers (`numeric(10,2)`) and CHECK bodies
 * must not be mistaken for a clause boundary.
 */
export const clauseEnd = (text: string, from: number): number => {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) return i;
      depth--;
    } else if (c === "," && depth === 0) return i;
  }
  return text.length;
};

/** Split a parenthesised body on top-level commas. */
export const splitTopLevel = (body: string): string[] => {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.filter((p) => p.trim().length > 0);
};

/** Index of the `)` matching the `(` at `open`, or -1. */
export const matchParen = (text: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** Blank JS/TS comments in place (length preserved). */
const maskJsComments = (src: string): string => {
  const out = src.split("");
  const n = src.length;
  const blank = (from: number, to: number): void => {
    for (let i = from; i < Math.min(to, n); i++) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  let quote = "";
  while (i < n) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i += 2;
      else {
        if (c === quote) quote = "";
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*" + "/", i + 2);
      const end = close === -1 ? n : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    i++;
  }
  return out.join("");
};

/** A string/template literal body found in JS/TS source, with interpolations blanked. */
interface Literal {
  start: number;
  end: number;
  text: string;
}

const extractLiterals = (src: string): Literal[] => {
  const found: Literal[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c !== '"' && c !== "'" && c !== "`") {
      i++;
      continue;
    }
    const chars: string[] = [];
    const start = i + 1;
    let j = start;
    let closed = false;
    let depth = 0; // template interpolation nesting
    while (j < n) {
      const d = src[j]!;
      if (d === "\\") {
        chars.push(" ", " ");
        j += 2;
        continue;
      }
      if (c === "`" && depth === 0 && d === "$" && src[j + 1] === "{") {
        depth = 1;
        chars.push(" ", " ");
        j += 2;
        continue;
      }
      if (depth > 0) {
        if (d === "{") depth++;
        else if (d === "}") depth--;
        chars.push(d === "\n" ? "\n" : " ");
        j++;
        continue;
      }
      if (d === c) {
        closed = true;
        break;
      }
      if (c !== "`" && d === "\n") break; // unterminated single-line string
      chars.push(d);
      j++;
    }
    if (closed) found.push({ start, end: j, text: chars.join("") });
    i = j + 1;
  }
  return found;
};

/** Does this literal read as SQL DDL rather than a message or a path? */
const SQL_DDL_RE = /\b(?:ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX|CREATE\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/i;

/** Destructive schema-builder methods (knex, objection). */
const BUILDER_CALL_RE =
  /\.\s*(dropTableIfExists|dropTable|dropSchemaIfExists|dropSchema|dropColumns|dropColumn|truncate)\s*\(/g;

/**
 * Resolve the body `{ … }` of a function whose declaration matched at
 * `declEnd`: skip the parameter list, then brace-match the first `{` at paren
 * depth zero. Returns null when the shape is not what we expected — the caller
 * must then stay silent for the whole file rather than guess.
 */
const functionBodyAfter = (src: string, declStart: number): Region | null => {
  let depth = 0;
  let i = declStart;
  const limit = Math.min(src.length, declStart + 600);
  while (i < limit) {
    const c = src[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "{" && depth === 0) {
      const end = matchBrace(src, i);
      return end === -1 ? null : { start: declStart, end: end + 1 };
    } else if (c === ";" && depth === 0) return null;
    i++;
  }
  return null;
};

const matchBrace = (src: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** Down/rollback sections of a `.sql` migration, as absolute ranges. */
const sqlDownRegions = (content: string, lineStarts: number[]): Region[] => {
  const regions: Region[] = [];
  const lines = content.split("\n");
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (open === -1 && DOWN_MARKER_RE.test(line)) open = lineStarts[i]!;
    else if (open !== -1 && UP_MARKER_RE.test(line)) {
      regions.push({ start: open, end: lineStarts[i]! });
      open = -1;
    }
  }
  if (open !== -1) regions.push({ start: open, end: content.length });
  return regions;
};

let cacheKey = "";
let cacheValue: MigrationFile | null = null;

/**
 * Parse a candidate migration file into the shape the diagnostics consume, or
 * null when we should not speak about this file at all.
 *
 * Results are memoised for the immediately preceding call because all three
 * migration diagnostics run back-to-back over the same file.
 */
export const analyzeMigration = (normalizedFilePath: string, content: string): MigrationFile | null => {
  const key = `${normalizedFilePath} ${content.length} ${content}`;
  if (key === cacheKey) return cacheValue;
  cacheKey = key;
  cacheValue = build(normalizedFilePath, content);
  return cacheValue;
};

const build = (normalizedFilePath: string, content: string): MigrationFile | null => {
  if (!isMigrationPath(normalizedFilePath)) return null;
  const lineStarts = computeLineStarts(content);
  const wholeFileIsDown = DOWN_FILENAME_RE.test(normalizedFilePath);

  if (SQL_EXT_RE.test(normalizedFilePath)) {
    const downRegions = wholeFileIsDown
      ? [{ start: 0, end: content.length }]
      : sqlDownRegions(content, lineStarts);
    return {
      kind: "sql",
      units: [{ text: maskSql(content), base: 0 }],
      builderCalls: [],
      downRegions,
      lineStarts,
      raw: content,
    };
  }

  // JS/TS: only a file that actually declares an `up` is a migration.
  const masked = maskJsComments(content);
  if (!UP_DECL_RES.some((re) => re.test(masked))) return null;

  const downRegions: Region[] = wholeFileIsDown ? [{ start: 0, end: content.length }] : [];
  if (!wholeFileIsDown) {
    for (const source of DOWN_DECL_RES) {
      const re = new RegExp(source.source, source.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(masked)) !== null) {
        const body = functionBodyAfter(masked, m.index);
        // A `down` we cannot bracket means we cannot tell up from down. Say nothing.
        if (!body) return null;
        downRegions.push(body);
      }
    }
  }

  const units: SqlUnit[] = [];
  for (const lit of extractLiterals(masked)) {
    if (!SQL_DDL_RE.test(lit.text)) continue;
    units.push({ text: maskSql(lit.text), base: lit.start });
  }

  const builderCalls: BuilderCall[] = [];
  const callRe = new RegExp(BUILDER_CALL_RE.source, BUILDER_CALL_RE.flags);
  let call: RegExpExecArray | null;
  while ((call = callRe.exec(masked)) !== null) {
    builderCalls.push({ name: call[1]!, offset: call.index + call[0].indexOf(call[1]!) });
  }

  return { kind: "js", units, builderCalls, downRegions, lineStarts, raw: content };
};

/**
 * The glob prefilter for migration files. Deliberately wider than
 * `isMigrationPath`, which is the real authority — these only decide which files
 * are read off disk.
 */
export const MIGRATION_FILE_GLOBS: string[] = [
  "**/migrations/*.sql",
  "**/migrations/**/*.sql",
  "**/migrate/*.sql",
  "**/migrate/**/*.sql",
  "**/migrations/*.js",
  "**/migrations/**/*.js",
  "**/migrations/*.cjs",
  "**/migrations/**/*.cjs",
  "**/migrations/*.mjs",
  "**/migrations/**/*.mjs",
  "**/migrations/*.ts",
  "**/migrations/**/*.ts",
  "**/migrate/*.js",
  "**/migrate/**/*.js",
  "**/migrate/*.ts",
  "**/migrate/**/*.ts",
];
