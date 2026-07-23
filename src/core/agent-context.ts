/**
 * §158 — Agent Context Hygiene.
 *
 * THREAT MODEL. An AI coding agent reads the working-tree *filesystem*, not just
 * what git tracks. So a gitignored `.env` with live credentials is fully readable
 * by the agent and IS a leak risk — being gitignored protects it from a `git push`,
 * never from a `Read` tool call. This module therefore scans the on-disk tree
 * (including dotfiles and gitignored files) for content that must never enter an
 * agent's context, and reports which of those are not yet fenced off by an ignore
 * artifact the agent honors (`.aiignore`, `.cursorignore`, or a Claude Code `Read`
 * deny rule). git-tracked status is reported *informationally* only — it never
 * makes a file "covered".
 *
 * PRECISION. A false positive here is a release blocker: it would tell someone a
 * benign fixture is a leaked secret, or add a broad ignore glob that hides a file
 * they need in context. So classification is name-first and high-confidence:
 *   - env / key-material / credential files are recognized by name+extension, the
 *     unambiguous cases (a file called `.env` holds secrets by convention).
 *   - the two content detectors reused here (`PROVIDER_KEY_INLINE_RE`,
 *     `PEM_PRIVATE_KEY_RE`) are the same anchored, provider-prefixed patterns the
 *     text-scan uses — NOT the `looksSecretLike` entropy heuristic, which FPs on
 *     fixtures. A content match is skipped when its line reads as a placeholder.
 *   - data-dumps require row-carrying SQL (`INSERT INTO` / `COPY … FROM`) or a
 *     binary DB extension — never a bare `*.json`/`*.csv`, which are almost always
 *     benign test data and would flood the report with false positives.
 *
 * DETERMINISM. Every list is sorted; the module never reads the clock or randomness.
 * Identical input → byte-identical report and byte-identical generated artifacts.
 */

import { readFile, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
import { BUILTIN_IGNORES } from "./config.ts";
import type { NodeDoctorConfig } from "./config.ts";
import { PROVIDER_KEY_INLINE_RE, PEM_PRIVATE_KEY_RE, PLACEHOLDER_RE } from "./secret-patterns.ts";

const execFileAsync = promisify(execFile);

// A secret is never in a multi-megabyte blob; cap the content read so a large
// data file is skipped cheaply rather than slurped into memory.
const CONTENT_MAX_BYTES = 256 * 1024;

export type SensitiveCategory = "env" | "key-material" | "credentials" | "secret-content" | "data-dump";

export interface SensitiveFile {
  normalizedPath: string;
  category: SensitiveCategory;
  reason: string;
  /** Reported informationally only — tracked status never makes a file "covered". */
  gitTracked: boolean;
  /** Which of ["aiignore","cursorignore","claude-deny"] already match this path. */
  coveredBy: string[];
}

export interface ContextHygieneReport {
  root: string;
  files: SensitiveFile[];
  exposed: SensitiveFile[];
  summary: { total: number; exposed: number; byCategory: Record<string, number> };
}

// ---------------------------------------------------------------------------
// Classification tables
// ---------------------------------------------------------------------------

// `.env.example` and friends are shareable templates, not secrets. Exclude any
// `.env.*` whose suffix is a known placeholder marker.
const ENV_PLACEHOLDER_RE = /\.(example|sample|template|tmpl|dist|local\.example)$/i;
// A generic "this is a template, not the real thing" suffix, used to keep
// `foo.key.example` out of the key-material bucket.
const TEMPLATE_SUFFIX_RE = /\.(example|sample|template|tmpl)$/i;

// Unambiguous key/cert extensions, flagged by name alone. `key` is intentionally
// NOT here — the extension is heavily overloaded (Keynote `.key`, i18n key-lists,
// CSS-in-JS keyframe exports) so it is content-gated below (flagged only when the
// file actually contains a private-key block).
const KEY_EXTS = new Set(["pem", "p12", "pfx", "pkcs12", "keystore", "jks", "ppk"]);
const KEY_BASENAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
// Credential files that ARE credentials by definition (name alone is enough).
// `.npmrc` is intentionally NOT here — it is usually benign registry config and is
// only flagged when its content actually carries an auth token (see below).
const CRED_BASENAMES = new Set([".netrc", ".pgpass", ".dockercfg"]);
// Binary DB / dump extensions (unambiguous — content need not be read).
const DUMP_EXTS = new Set(["sqlite", "sqlite3", "db", "dump"]);
// Extensions a `dump`/`backup`-named file must carry to be a data export — so a
// source file like `dump.js` or `backup.ts` (code that performs a dump) is NOT
// mistaken for the dump itself.
const ARCHIVE_DATA_EXTS = new Set(["sql", "csv", "tsv", "gz", "tgz", "tar", "bak", "dat", "zip", "bz2", "xz"]);
// The ONLY file types whose CONTENT we scan for an embedded secret: structured
// config/data files, where a real key can hide and where fencing the file off is
// the right response. Source code is deliberately excluded — an agent is SUPPOSED
// to read source (you cannot `.aiignore` your own code), a secret literal in source
// is the AST scanner's job (`no-hardcoded-secret-literal`), and test/detector
// sources are full of example/synthetic keys that would flood this with FPs.
const CONTENT_SCAN_EXTS = new Set([
  "json", "json5", "jsonc", "yaml", "yml", "toml", "ini", "conf", "cfg", "config",
  "properties", "xml", "plist", "tfvars", "tf", "hcl", "csv", "tsv", "txt", "sql",
  "sh", "bash", "zsh", "ksh", "fish", "ps1", "bat", "cmd",
  // Overloaded key extensions: flagged only if their content is an actual PEM key.
  "key", "asc",
]);

const basenameOf = (normalizedPath: string): string =>
  normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);

/** Lowercased final extension (empty for `.env`, `id_rsa`, or a dotless name). */
const extOf = (base: string): string => {
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
};

interface Classification {
  category: SensitiveCategory;
  reason: string;
}

/**
 * Classify one file into at most one category. First match wins in the order
 * env → key-material → credentials → data-dump → content, so a `.env` full of
 * provider keys is reported as an env file (the actionable, whole-class fact),
 * not as a one-off content hit. `readContent` is a lazy, cached reader that
 * returns null for a binary, oversized, or unreadable file — only the
 * content-dependent branches pay the read cost.
 */
const classify = async (
  normalizedPath: string,
  readContent: () => Promise<string | null>,
): Promise<Classification | null> => {
  const base = basenameOf(normalizedPath);
  const ext = extOf(base);

  // env — a `.env` / `.env.<env>` file holds secrets by convention. Placeholders
  // (`.env.example`, `.env.sample`, …) are shareable templates, not secrets.
  if ((base === ".env" || /^\.env\..+/.test(base)) && !ENV_PLACEHOLDER_RE.test(base)) {
    return { category: "env", reason: "environment file (holds secrets by convention)" };
  }

  // key-material — private keys and keystores. A `*.pub` is a public key (safe),
  // and a `*.key.example` template is not the real key.
  if (
    !/\.pub$/i.test(base) &&
    !TEMPLATE_SUFFIX_RE.test(base) &&
    (KEY_EXTS.has(ext) || KEY_BASENAMES.has(base))
  ) {
    return { category: "key-material", reason: "private key / key material" };
  }

  // credentials (name-based) — well-known credential/auth files.
  if (
    CRED_BASENAMES.has(base) ||
    normalizedPath.endsWith(".aws/credentials") ||
    /(^|\/)kubeconfig$/.test(normalizedPath) ||
    /\.kubeconfig$/.test(normalizedPath)
  ) {
    return { category: "credentials", reason: "credential file" };
  }

  // data-dump (name-based) — binary DB files, and files named like a dump/backup
  // that carry a data/archive extension (so `dump.js` / `backup.ts` — code, not a
  // dump — never match).
  if (DUMP_EXTS.has(ext) || (/^(dump|backup)\b/i.test(base) && (ext === "" || ARCHIVE_DATA_EXTS.has(ext)))) {
    return { category: "data-dump", reason: "database dump / data export" };
  }

  // Everything below needs the file's content, and content is scanned ONLY for
  // config/data file types (never source code) plus a `.npmrc` that may hold a
  // registry auth token. Anything else needs no read and stays unclassified.
  const needsContent = CONTENT_SCAN_EXTS.has(ext) || base === ".npmrc";
  if (!needsContent) return null;
  const content = await readContent();
  if (content === null) return null;

  // credentials (content) — a `.npmrc` that actually carries a registry auth token
  // (a bare registry-config `.npmrc` is benign and stays silent). The canonical line
  // is `//registry.npmjs.org/:_authToken=…`, so the token name is preceded by `:` —
  // match the distinctive token name anywhere on a line, not only at a boundary.
  if (base === ".npmrc" && /_auth(token)?\s*=|_password\s*=/i.test(content)) {
    return { category: "credentials", reason: "npm registry auth token" };
  }

  // credentials (content) — a GCP service-account key is a JSON file carrying
  // BOTH the account marker and an embedded private key.
  if (
    ext === "json" &&
    /"type"\s*:\s*"service_account"/.test(content) &&
    /"private_key"/.test(content)
  ) {
    return { category: "credentials", reason: "credential file" };
  }

  // data-dump (content) — a `*.sql` that carries row data. Require `INSERT INTO`
  // or `COPY … FROM`; a schema-only file (just `CREATE TABLE`) is a migration,
  // not a data export, and is deliberately left silent.
  if (ext === "sql" && (/\bINSERT\s+INTO\b/i.test(content) || /\bCOPY\b[^\n]*\bFROM\b/i.test(content))) {
    return { category: "data-dump", reason: "database dump / data export" };
  }

  // secret-content — a config/data file carrying a real key. Uses the same
  // anchored, provider-prefixed detectors as the text-scan; a line that reads as a
  // placeholder is skipped so a template value never trips it.
  const providerLine = firstMatchingLine(content, PROVIDER_KEY_INLINE_RE);
  if (providerLine !== null && !looksPlaceholder(providerLine)) {
    return { category: "secret-content", reason: "contains a recognizable provider key" };
  }
  const pemLine = firstMatchingLine(content, PEM_PRIVATE_KEY_RE);
  if (pemLine !== null && !looksPlaceholder(pemLine)) {
    return { category: "secret-content", reason: "contains a private key block" };
  }

  return null;
};

/** The first line matching `re`, or null. */
const firstMatchingLine = (content: string, re: RegExp): string | null => {
  for (const line of content.split("\n")) {
    if (re.test(line)) return line;
  }
  return null;
};

/** True when a matching line (or the value after its `=`/`:`) reads as a placeholder. */
const looksPlaceholder = (line: string): boolean => {
  const trimmed = line.trim();
  if (PLACEHOLDER_RE.test(trimmed)) return true;
  const eq = trimmed.search(/[:=]/);
  if (eq !== -1) {
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (PLACEHOLDER_RE.test(value)) return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Coverage matching (gitignore-style + Claude Read() deny rules)
// ---------------------------------------------------------------------------

interface CompiledPattern {
  negated: boolean;
  re: RegExp;
}

/** Convert a glob body (single-star, double-star, double-star-slash, `?`) into a regex fragment. */
const globBody = (glob: string): string => {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          re += "(?:.*/)?"; // `**/` spans zero or more directories
          i++;
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\/".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return re;
};

/**
 * Compile one gitignore-style line into a matcher over a forward-slash relative
 * path. Supports a leading `!` (negation), a leading `/` (root-anchored), a
 * trailing `/` (directory), `**`, `*`, `?`, and a bare basename that matches at
 * any depth. A pattern with any interior slash is root-anchored, per gitignore.
 */
const compilePattern = (raw: string): CompiledPattern | null => {
  let p = raw.trim();
  if (p === "" || p.startsWith("#")) return null;
  let negated = false;
  if (p.startsWith("!")) {
    negated = true;
    p = p.slice(1);
  }
  let dirOnly = false;
  if (p.endsWith("/")) {
    dirOnly = true;
    p = p.slice(0, -1);
  }
  const leadingSlash = p.startsWith("/");
  if (leadingSlash) p = p.slice(1);
  if (p === "") return null;
  const anchored = leadingSlash || p.includes("/");
  const prefix = anchored ? "^" : "(?:^|/)";
  const suffix = dirOnly ? "/" : "(?:/|$)";
  return { negated, re: new RegExp(prefix + globBody(p) + suffix) };
};

/** Parse a gitignore-style file body into ordered matchers. */
const compilePatternList = (text: string): CompiledPattern[] => {
  const out: CompiledPattern[] = [];
  for (const line of text.split("\n")) {
    const c = compilePattern(line);
    if (c) out.push(c);
  }
  return out;
};

/**
 * Whether `path` is ignored by a gitignore-style pattern list. Later patterns win,
 * so a `!re-include` after an ignore un-covers the path (gitignore semantics).
 */
const isIgnored = (patterns: CompiledPattern[], path: string): boolean => {
  let ignored = false;
  for (const p of patterns) {
    if (p.re.test(path)) ignored = !p.negated;
  }
  return ignored;
};

/** Extract the inner glob of a Claude `Read(./glob)` deny rule (else null). */
const claudeReadGlob = (rule: string): string | null => {
  const m = /^Read\((.+)\)$/.exec(rule.trim());
  if (!m) return null;
  return m[1]!.replace(/^\.\//, "");
};

/** Compile the `Read(...)` deny rules into matchers (non-Read rules ignored). */
const compileClaudeDeny = (deny: readonly string[]): CompiledPattern[] => {
  const out: CompiledPattern[] = [];
  for (const rule of deny) {
    const glob = claudeReadGlob(rule);
    if (glob === null) continue;
    const c = compilePattern(glob);
    if (c) out.push(c);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/** git-tracked files as normalized relative paths (empty when not a git repo). */
const trackedFiles = async (rootDirectory: string): Promise<Set<string>> => {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], {
      cwd: rootDirectory,
      maxBuffer: 64 * 1024 * 1024,
    });
    return new Set(
      stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('"')),
    );
  } catch {
    return new Set();
  }
};

const readFileOr = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
};

/** A lazy, cached content reader that returns null for binary/oversized/unreadable. */
const makeContentReader = (absolutePath: string): (() => Promise<string | null>) => {
  let done = false;
  let value: string | null = null;
  return async () => {
    if (done) return value;
    done = true;
    try {
      const info = await stat(absolutePath);
      if (!info.isFile() || info.size > CONTENT_MAX_BYTES) return value;
      const buf = await readFile(absolutePath);
      // Binary sniff: a NUL byte in the head means "not text" — skip it.
      const head = buf.subarray(0, Math.min(buf.length, 8192));
      if (head.includes(0)) return value;
      value = buf.toString("utf8");
    } catch {
      value = null;
    }
    return value;
  };
};

export const scanAgentContext = async (
  rootDirectory: string,
  options?: { config?: NodeDoctorConfig },
): Promise<ContextHygieneReport> => {
  void options; // config is accepted for API symmetry; the sensitive-file walk is
  // deliberately NOT narrowed by config.ignore — a diagnostic ignore must not
  // silently drop a file from the leak check.

  const candidates = await fg(["**/*"], {
    cwd: rootDirectory,
    dot: true,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true,
    followSymbolicLinks: false,
    ignore: [...BUILTIN_IGNORES, "**/.git/**"],
  });

  const tracked = await trackedFiles(rootDirectory);

  // Existing coverage artifacts, read once.
  const aiignore = compilePatternList((await readFileOr(`${rootDirectory}/.aiignore`)) ?? "");
  const cursorignore = compilePatternList((await readFileOr(`${rootDirectory}/.cursorignore`)) ?? "");
  const claudeDeny = compileClaudeDeny(readClaudeDeny((await readFileOr(`${rootDirectory}/.claude/settings.json`)) ?? ""));

  const files: SensitiveFile[] = [];
  for (const absolutePath of candidates) {
    const normalizedPath = relative(rootDirectory, absolutePath).split(sep).join("/");
    const classification = await classify(normalizedPath, makeContentReader(absolutePath));
    if (!classification) continue;

    const coveredBy: string[] = [];
    if (isIgnored(aiignore, normalizedPath)) coveredBy.push("aiignore");
    if (isIgnored(cursorignore, normalizedPath)) coveredBy.push("cursorignore");
    if (isIgnored(claudeDeny, normalizedPath)) coveredBy.push("claude-deny");

    files.push({
      normalizedPath,
      category: classification.category,
      reason: classification.reason,
      gitTracked: tracked.has(normalizedPath),
      coveredBy: coveredBy.sort(),
    });
  }

  files.sort((a, b) => (a.normalizedPath < b.normalizedPath ? -1 : a.normalizedPath > b.normalizedPath ? 1 : 0));
  const exposed = files.filter((f) => f.coveredBy.length === 0);

  const byCategory: Record<string, number> = {};
  for (const key of [...new Set(files.map((f) => f.category))].sort()) {
    byCategory[key] = files.filter((f) => f.category === key).length;
  }

  return {
    root: rootDirectory,
    files,
    exposed,
    summary: { total: files.length, exposed: exposed.length, byCategory },
  };
};

/** Pull `permissions.deny` (a string array) out of a Claude settings JSON blob. */
const readClaudeDeny = (text: string): string[] => {
  if (text.trim() === "") return [];
  try {
    const parsed = JSON.parse(text) as { permissions?: { deny?: unknown } };
    const deny = parsed.permissions?.deny;
    return Array.isArray(deny) ? deny.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Artifact generation (pure)
// ---------------------------------------------------------------------------

export const AIIGNORE_START = "# >>> node-doctor agent-context-hygiene >>>";
export const AIIGNORE_END = "# <<< node-doctor agent-context-hygiene <<<";

interface CategoryGlobs {
  positives: string[];
  negations: string[];
}

/**
 * The ignore globs for a report, split into positive patterns and the
 * placeholder re-includes they require. Whole classes (env, key-material) map to
 * class globs; a one-off credential/dump/content-secret maps to its exact path,
 * so a benign sibling is never swept up by an over-broad glob.
 */
const categoryGlobs = (report: ContextHygieneReport): CategoryGlobs => {
  const positives = new Set<string>();
  const negations = new Set<string>();
  for (const file of report.files) {
    const base = basenameOf(file.normalizedPath);
    const ext = extOf(base);
    switch (file.category) {
      case "env":
        positives.add(".env");
        positives.add(".env.*");
        // Keep shareable templates in context — they are meant to be read. Mirrors
        // ENV_PLACEHOLDER_RE so the generated glob never hides a file the scan
        // itself treats as non-sensitive.
        negations.add("!.env.example");
        negations.add("!.env.sample");
        negations.add("!.env.template");
        negations.add("!.env.tmpl");
        negations.add("!.env.dist");
        break;
      case "key-material": {
        // Use the file's REAL-case extension in the glob — gitignore is
        // case-sensitive, so a lowercased `*.pem` glob would silently fail to fence
        // off `SERVER.PEM`. If the extension is not already lowercase, fall back to
        // the exact path so the generated ignore entry can never be a no-op.
        const realExt = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
        if (KEY_BASENAMES.has(base)) positives.add(base);
        else if (realExt && realExt === realExt.toLowerCase()) positives.add(`*.${realExt}`);
        else positives.add(file.normalizedPath);
        break;
      }
      case "credentials":
      case "data-dump":
      case "secret-content":
        // Specific files, not a whole class — emit the exact path so nothing else
        // is caught. (A `*.sql`/`*.json` glob would hide benign migrations/fixtures.)
        positives.add(file.normalizedPath);
        break;
    }
  }
  return { positives: [...positives].sort(), negations: [...negations].sort() };
};

/**
 * The sorted, de-duped list of gitignore-style patterns to add. Positives come
 * first, then negations — gitignore evaluates top-to-bottom, so a `!re-include`
 * must follow the pattern it re-includes to take effect. Derived from ALL
 * sensitive files (not just exposed ones) so re-running after a write reproduces
 * the same block byte-for-byte instead of shrinking it.
 */
export const buildIgnoreEntries = (report: ContextHygieneReport): string[] => {
  const { positives, negations } = categoryGlobs(report);
  return [...positives, ...negations];
};

/** The managed `.aiignore`/`.cursorignore` block (delimited, no trailing newline). */
export const renderManagedBlock = (entries: string[]): string =>
  [
    AIIGNORE_START,
    "# Files that must not enter an AI agent's context. Managed by `node-doctor context --write`.",
    ...entries,
    AIIGNORE_END,
  ].join("\n");

/** Sorted Claude Code `Read(./glob)` deny rules — one per class glob / exact path. */
export const claudeDenyRules = (report: ContextHygieneReport): string[] =>
  categoryGlobs(report)
    .positives.map((glob) => `Read(./${glob})`)
    .sort();

// ---------------------------------------------------------------------------
// Apply (idempotent, filesystem)
// ---------------------------------------------------------------------------

/** Splice the managed block into an existing ignore file (replace or append). */
const spliceManagedBlock = (existing: string, block: string): string => {
  const startIdx = existing.indexOf(AIIGNORE_START);
  if (startIdx !== -1) {
    const endIdx = existing.indexOf(AIIGNORE_END, startIdx);
    if (endIdx !== -1) {
      const merged = existing.slice(0, startIdx) + block + existing.slice(endIdx + AIIGNORE_END.length);
      return merged.endsWith("\n") ? merged : `${merged}\n`;
    }
  }
  if (existing.trim() === "") return `${block}\n`;
  return `${existing.replace(/\n+$/, "")}\n\n${block}\n`;
};

export const applyContextHygiene = async (
  rootDirectory: string,
  report: ContextHygieneReport,
  options?: { agents?: Array<"aiignore" | "cursorignore" | "claude"> },
): Promise<{ written: string[]; unchanged: string[] }> => {
  const agents = options?.agents ?? ["aiignore", "cursorignore", "claude"];
  const entries = buildIgnoreEntries(report);

  // Nothing sensitive → nothing to fence off. (No sensitive files ⟺ no entries.)
  if (entries.length === 0) return { written: [], unchanged: [] };

  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const written: string[] = [];
  const unchanged: string[] = [];
  const block = renderManagedBlock(entries);

  for (const [agent, filename] of [
    ["aiignore", ".aiignore"],
    ["cursorignore", ".cursorignore"],
  ] as const) {
    if (!agents.includes(agent)) continue;
    const path = join(rootDirectory, filename);
    const existing = (await readFileOr(path)) ?? "";
    const next = spliceManagedBlock(existing, block);
    if (next === existing) unchanged.push(path);
    else {
      await writeFile(path, next);
      written.push(path);
    }
  }

  if (agents.includes("claude")) {
    const dir = join(rootDirectory, ".claude");
    const path = join(dir, "settings.json");
    const existingText = await readFileOr(path);
    let settings: Record<string, unknown> = {};
    if (existingText !== null) {
      try {
        settings = JSON.parse(existingText) as Record<string, unknown>;
      } catch {
        settings = {};
      }
    }
    const permissions =
      settings.permissions && typeof settings.permissions === "object"
        ? (settings.permissions as Record<string, unknown>)
        : {};
    const existingDeny = Array.isArray(permissions.deny)
      ? (permissions.deny as unknown[]).filter((d): d is string => typeof d === "string")
      : [];
    const deny = [...new Set([...existingDeny, ...claudeDenyRules(report)])].sort();
    const merged = { ...settings, permissions: { ...permissions, deny } };
    const nextText = `${JSON.stringify(merged, null, 2)}\n`;
    if (existingText === nextText) unchanged.push(path);
    else {
      await mkdir(dir, { recursive: true });
      await writeFile(path, nextText);
      written.push(path);
    }
  }

  return { written: written.sort(), unchanged: unchanged.sort() };
};
