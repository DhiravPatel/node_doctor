/**
 * §181 — i18n & User-String Integrity (`node-doctor i18n`).
 *
 * The localization drift class. A key referenced in code with no entry in the
 * locale files ships a blank string — or the raw key — to a user, and nothing in
 * the build fails. A placeholder renamed in the translation but not at the call
 * site renders `Hello {{userName}}` verbatim in production. Neither is visible
 * in a code review of either file alone: the code is fine, the JSON is fine, and
 * the relationship between them is broken.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. §181 also names "hardcoded user-facing
 * strings in a codebase that otherwise translates". That is not shipped and will
 * not be: there is no static property that distinguishes a user-facing string
 * from a log message, an error code, a SQL fragment, an HTTP header, a route
 * path, a test fixture, or a developer-facing exception. Every candidate gate —
 * contains a space, starts with a capital, is passed to `res.send` — misfires in
 * both directions, and a mature localized codebase legitimately holds thousands
 * of untranslatable literals. Whether a string is user-facing is a
 * natural-language judgement, and the deterministic core does not guess.
 *
 * PRECISION MODEL. Three proof obligations before any key is called missing:
 *
 *   1. THE FILE MUST BE PROVEN i18n CODE. `t("x")` is the single most ambiguous
 *      call shape in JavaScript — a tagged template helper, a test tap, a Lodash
 *      chain. The calling file must import a recognized i18n package, and the
 *      translate function must be bound from that import.
 *   2. THE KEY MUST BE STATIC. A computed key (`t(\`errors.${code}\`)`) is not a
 *      key this can check, so it is skipped — and it sets a flag that suppresses
 *      unused-key detection for the whole run, because a dynamic key can reach
 *      any entry.
 *   3. THE LOCALE FILE MUST BE PROVEN A LOCALE FILE. `**\/*.json` is
 *      catastrophic — tsconfig, package.json, fixtures, OpenAPI specs. A file
 *      qualifies only with an i18n-shaped directory segment, a BCP-47-shaped
 *      name, and all-string leaves.
 *
 * UNUSED-KEY DETECTION IS NOT SHIPPED, and the report says so rather than
 * returning an empty list. An adversarial hunt settled it: a key is reachable
 * from `<Trans i18nKey="x">` in JSX, from a `.vue` / `.svelte` / `.hbs` template
 * this does not parse, from a `t` prop-drilled through three components, from
 * `$t(other.key)` nested INSIDE another translation, and from a `@:link`
 * reference. Every one of those is invisible here, and the action a reader takes
 * on "no code references this translation" is to delete a string a user sees.
 * A claim whose failure mode is deleting production copy has to be right every
 * time, and this one cannot be.
 *
 * Deterministic: files globbed and sorted, keys sorted, no clock.
 */

import { readFile } from "node:fs/promises";
import { relative, sep, basename, dirname } from "node:path";

import { BUILTIN_IGNORES, type NodeDoctorConfig } from "./config.ts";
import { parseSource } from "./parse.ts";
import { attachParents, collectDescendants } from "./walk.ts";
import { getStaticStringValue } from "./ast.ts";
import { createLocator } from "./location.ts";
import type { AstNode } from "./types.ts";

const SOURCE_GLOB = "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";
const LOCALE_GLOB = "**/*.json";

/** Packages whose translate function this understands. */
const I18N_SOURCES = new Set([
  "i18next",
  "react-i18next",
  "next-i18next",
  "i18next-http-backend",
  "vue-i18n",
  "next-intl",
  "react-intl",
  "node-polyglot",
  "@lingui/core",
  "@lingui/react",
  "svelte-i18n",
]);

/**
 * The ONE placeholder syntax compared: i18next's `{{name}}` / `{{name, format}}`.
 *
 * Single-brace `{name}` was dropped after the hunt. It is ICU/react-intl/vue-i18n
 * syntax, but it is also ordinary English prose — "choose a plan { basic, pro }",
 * a JSON example in a help string, a code sample — and there is no way to tell
 * a placeholder from a brace from the string alone. Comparing it produced
 * "placeholder never supplied" on plain sentences.
 */
const PLACEHOLDER_DOUBLE = /\{\{\s*([A-Za-z_$][\w$]*)\s*(?:,[^}]*)?\}\}/g;

/**
 * Option keys i18next and friends reserve for themselves. They are not
 * placeholders — they are FILTERED OUT OF THE REQUIRED SET. The first version
 * filtered them out of the SUPPLIED set instead, which is exactly backwards: it
 * made `{{count}}` — the single most common i18next placeholder — report as
 * never supplied on every plural string in every project.
 */
const RESERVED_OPTIONS = new Set([
  "count",
  "context",
  "ns",
  "lng",
  "lngs",
  "fallbackLng",
  "defaultValue",
  "replace",
  "returnObjects",
  "returnDetails",
  "interpolation",
  "keySeparator",
  "nsSeparator",
  "postProcess",
  "skipInterpolation",
  "escapeValue",
  "formatParams",
]);

/** Plural and context suffixes a key may carry at lookup time. */
const KEY_SUFFIX_RE = /_(?:zero|one|two|few|many|other|plural|male|female|\d+)$/;

export interface MissingKey {
  key: string;
  normalizedFilePath: string;
  line: number;
  column: number;
  /** A close key that does exist (edit distance ≤ 2), when there is one. */
  suggestion: string | null;
}

export interface PlaceholderMismatch {
  key: string;
  normalizedFilePath: string;
  line: number;
  column: number;
  /** Placeholders the translation needs that the call site does not supply. */
  missing: string[];
  /** The translation string, for context. */
  translation: string;
}

/**
 * Why no dead-translation list is offered. There is only one value: this is a
 * claim the analyzer refuses to make, not one it failed to compute today.
 */
export type UnusedKeyDetection = "not-attempted-unreachable-by-static-analysis";

export interface I18nReport {
  /** False when no locale files were found — every other list is then empty. */
  localesPresent: boolean;
  localeFiles: string[];
  /** The locale whose keys are treated as the source of truth. */
  defaultLocale: string | null;
  missingKeys: MissingKey[];
  placeholderMismatches: PlaceholderMismatch[];
  /**
   * Always empty. Kept in the shape so a consumer sees the field and its
   * reason rather than assuming the analysis found nothing.
   */
  unusedKeys: string[];
  unusedKeyDetection: UnusedKeyDetection;
  summary: {
    filesScanned: number;
    keysDefined: number;
    keysUsed: number;
    missing: number;
    mismatched: number;
    unused: number;
  };
}

// ---------------------------------------------------------------------------
// Locale-file discovery — the biggest false-positive risk in the whole feature.
// ---------------------------------------------------------------------------

/** A directory segment that marks a translation artifact. */
const LOCALE_DIR_RE = /(^|\/)(locales?|i18n|lang|langs|translations?|messages)(\/|$)/i;
/** A BCP-47-shaped tag: `en`, `en-US`, `pt-BR`, `zh-Hans-CN`. */
const BCP47_RE = /^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})*$/;

/**
 * Does this look like a translation catalogue? Every leaf must be a string, an
 * array of strings (i18next returns those for `returnObjects`), or an empty
 * object. The first version rejected both, and ONE array value anywhere threw
 * the whole file away — turning every key it defined into a hard "no
 * translation" claim.
 */
const looksLikeCatalogue = (value: unknown, depth = 0): boolean => {
  if (depth > 12) return false;
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.every((v) => typeof v === "string");
  if (value === null || typeof value !== "object") return false;
  const entries = Object.values(value as Record<string, unknown>);
  if (entries.length === 0) return depth > 0; // an empty nested object is fine; an empty file is not
  return entries.every((v) => looksLikeCatalogue(v, depth + 1));
};

/**
 * The locale tag this file is for, or null when it is not a locale file at all.
 * Requires a translation-shaped directory AND a BCP-47 name on the file or its
 * directory — `package.json` under `src/i18n/` must not qualify.
 */
const localeTagFor = (normalizedFilePath: string): string | null => {
  if (!LOCALE_DIR_RE.test(dirname(normalizedFilePath) + "/")) return null;
  const stem = basename(normalizedFilePath).replace(/\.json$/i, "");
  if (BCP47_RE.test(stem)) return stem;
  const parent = basename(dirname(normalizedFilePath));
  if (BCP47_RE.test(parent)) return parent;
  return null;
};

/** Flatten a nested catalogue to dotted keys → string. */
const flatten = (value: unknown, prefix: string, out: Map<string, string>): void => {
  if (typeof value === "string") {
    out.set(prefix, value);
    return;
  }
  if (Array.isArray(value)) {
    // An array value renders as a joined string; there is one key, not N.
    out.set(prefix, value.filter((v) => typeof v === "string").join(" "));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    flatten(v, prefix === "" ? k : `${prefix}.${k}`, out);
  }
};

// ---------------------------------------------------------------------------
// Call-site extraction.
// ---------------------------------------------------------------------------

/** Local names bound to a translate function, proven from an i18n import. */
const translateBindings = (program: AstNode): Set<string> => {
  const names = new Set<string>();
  let importsI18n = false;

  for (const stmt of (program.body as AstNode[] | undefined) ?? []) {
    if (stmt.type !== "ImportDeclaration") continue;
    const source = stmt.source?.value;
    if (typeof source !== "string" || !I18N_SOURCES.has(source)) continue;
    importsI18n = true;
  }
  if (!importsI18n) {
    // `const { t } = require("i18next")` and `const i18n = require("i18next")`.
    for (const call of collectDescendants(
      program,
      (n) =>
        n.type === "CallExpression" &&
        (n.callee as AstNode | undefined)?.type === "Identifier" &&
        (n.callee as AstNode).name === "require",
      undefined,
      true,
    )) {
      const spec = getStaticStringValue(((call.arguments as AstNode[] | undefined) ?? [])[0]);
      if (spec !== null && I18N_SOURCES.has(spec)) importsI18n = true;
    }
  }
  if (!importsI18n) return names;

  // With the file proven to be i18n code, the conventional translate bindings
  // are unambiguous: `t`, and `<x>.t` member calls.
  names.add("t");
  for (const decl of collectDescendants(program, (n) => n.type === "VariableDeclarator", undefined, true)) {
    const id = decl.id as AstNode | undefined;
    if (id?.type !== "ObjectPattern") continue;
    for (const prop of (id.properties as AstNode[] | undefined) ?? []) {
      if (prop.type !== "Property") continue;
      const key = prop.key as AstNode | undefined;
      const value = prop.value as AstNode | undefined;
      if (key?.type !== "Identifier" || value?.type !== "Identifier") continue;
      if (key.name === "t") names.add(value.name as string);
    }
  }
  return names;
};

interface KeyUse {
  key: string;
  normalizedFilePath: string;
  line: number;
  column: number;
  /** Statically-known option property names at the call site, or null if opaque. */
  optionKeys: string[] | null;
  /** True when the call supplies a default — it can never render blank. */
  hasDefault: boolean;
  /** True when the call names a namespace this cannot resolve to a catalogue. */
  namespaced: boolean;
}

/**
 * Receivers whose `.t(…)` is a translate call. Any `x.t(...)` was accepted at
 * first, which asserted that `db.t(...)`, `chai.t(...)` and a tagged-template
 * helper were all translation keys.
 */
const I18N_RECEIVERS = new Set(["i18n", "i18next", "intl", "$i18n", "translator", "polyglot"]);

/** Is this call a translate call whose function is one of `bindings`? */
const translateCallKey = (call: AstNode, bindings: ReadonlySet<string>): AstNode | null => {
  const callee = call.callee as AstNode | undefined;
  if (callee?.type === "Identifier" && bindings.has(callee.name as string)) {
    return ((call.arguments as AstNode[] | undefined) ?? [])[0] ?? null;
  }
  if (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    (callee.property as AstNode | undefined)?.type === "Identifier" &&
    ((callee.property as AstNode).name === "t" || (callee.property as AstNode).name === "$t")
  ) {
    // The receiver must be a recognized i18n object or `this`. `intl.formatMessage`
    // is deliberately not modelled — its key lives in an object.
    const object = callee.object as AstNode | undefined;
    const receiver =
      object?.type === "Identifier"
        ? (object.name as string)
        : object?.type === "ThisExpression"
          ? "this"
          : object?.type === "MemberExpression" &&
              (object.property as AstNode | undefined)?.type === "Identifier"
            ? ((object.property as AstNode).name as string)
            : null;
    if (receiver === null) return null;
    if (receiver !== "this" && !I18N_RECEIVERS.has(receiver) && !bindings.has(receiver)) return null;
    return ((call.arguments as AstNode[] | undefined) ?? [])[0] ?? null;
  }
  return null;
};

/**
 * Does this file scope its keys with `useTranslation(ns, { keyPrefix })`? Every
 * key in such a file is written WITHOUT the prefix, so cross-referencing them
 * against a catalogue reports the whole file as missing. Abstain.
 */
const usesKeyPrefix = (program: AstNode): boolean =>
  collectDescendants(
    program,
    (n) =>
      n.type === "Property" &&
      !n.computed &&
      (n.key as AstNode | undefined)?.type === "Identifier" &&
      ((n.key as AstNode).name === "keyPrefix" || (n.key as AstNode).name === "keySeparator"),
    undefined,
    true,
  ).length > 0;

/** Static property names of an options object, or null when it is opaque. */
const staticOptionKeys = (node: AstNode | undefined): string[] | null => {
  if (!node) return [];
  if (node.type !== "ObjectExpression") return null;
  const keys: string[] = [];
  for (const prop of (node.properties as AstNode[] | undefined) ?? []) {
    if (prop.type !== "Property") return null; // a spread — unknowable
    const key = prop.key as AstNode | undefined;
    if (key?.type === "Identifier" && !prop.computed) keys.push(key.name as string);
    else if (key?.type === "Literal" && typeof key.value === "string") keys.push(key.value);
    else return null;
  }
  return keys;
};

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
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
};

const suggestKey = (key: string, defined: ReadonlySet<string>): string | null => {
  let best: string | null = null;
  let bestD = 3;
  for (const candidate of defined) {
    const d = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = candidate;
    }
  }
  return bestD <= 2 ? best : null;
};

/**
 * Every form a key may take at lookup time: as written, without its namespace
 * prefix, and without a plural/context suffix. A key that matches ANY of these
 * exists; only a key matching none is missing.
 */
const lookupForms = (key: string): string[] => {
  const forms = new Set<string>([key]);
  const colon = key.indexOf(":");
  if (colon > 0) forms.add(key.slice(colon + 1));
  for (const form of [...forms]) {
    const stripped = form.replace(KEY_SUFFIX_RE, "");
    if (stripped !== form) forms.add(stripped);
  }
  return [...forms];
};

/**
 * Placeholders a translation requires. Reserved i18next options are removed
 * here, in the REQUIRED set — `{{count}}` is supplied by i18next's own plural
 * machinery, not by the caller naming it as an interpolation value.
 *
 * `unreadable` means the string carries something this must not reason about:
 * an ICU plural/select (whose inner tokens are not placeholders), a nested
 * `$t(...)` reference, or a vue-i18n `@:link`.
 */
const requiredPlaceholders = (translation: string): { names: Set<string>; unreadable: boolean } => {
  const unreadable =
    /\{\s*[A-Za-z_$][\w$]*\s*,\s*(?:plural|select|selectordinal|date|time|number)\b/.test(translation) ||
    /\$t\(/.test(translation) ||
    /@[.:]/.test(translation);
  const names = new Set<string>();
  if (unreadable) return { names, unreadable };

  let match: RegExpExecArray | null;
  const doubles = new RegExp(PLACEHOLDER_DOUBLE.source, "g");
  while ((match = doubles.exec(translation)) !== null) {
    if (!RESERVED_OPTIONS.has(match[1]!)) names.add(match[1]!);
  }
  return { names, unreadable };
};

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

export const buildI18nReport = async (
  rootDirectory: string,
  options: { config?: NodeDoctorConfig } = {},
): Promise<I18nReport> => {
  const config = options.config ?? {};
  const fg = (await import("fast-glob")).default;
  const ignore = [...BUILTIN_IGNORES, ...(config.ignore ?? [])];

  const empty = (): I18nReport => ({
    localesPresent: false,
    localeFiles: [],
    defaultLocale: null,
    missingKeys: [],
    placeholderMismatches: [],
    unusedKeys: [],
    unusedKeyDetection: "not-attempted-unreachable-by-static-analysis",
    summary: { filesScanned: 0, keysDefined: 0, keysUsed: 0, missing: 0, mismatched: 0, unused: 0 },
  });

  // --- locale catalogues -----------------------------------------------------
  const jsonFiles = (
    await fg([LOCALE_GLOB], {
      cwd: rootDirectory,
      ignore,
      absolute: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    })
  ).sort();

  /** locale tag → merged key map. */
  const catalogues = new Map<string, Map<string, string>>();
  const localeFiles: string[] = [];
  /** Bare keys defined by more than one namespace with different values. */
  const ambiguousKeys = new Set<string>();

  for (const filePath of jsonFiles) {
    const normalizedFilePath = relative(rootDirectory, filePath).split(sep).join("/");
    const tag = localeTagFor(normalizedFilePath);
    if (tag === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      continue; // unparseable JSON is not a catalogue we can reason about
    }
    if (!looksLikeCatalogue(parsed)) continue;

    localeFiles.push(normalizedFilePath);
    const keys = catalogues.get(tag) ?? new Map<string, string>();
    // A file inside `locales/en/common.json` namespaces its keys by file stem
    // the way i18next does; both the bare and namespaced forms are recorded so
    // either call style resolves.
    const stem = basename(normalizedFilePath).replace(/\.json$/i, "");
    const namespaced = !BCP47_RE.test(stem);
    const flat = new Map<string, string>();
    flatten(parsed, "", flat);
    for (const [k, v] of flat) {
      // The SAME bare key defined by two namespaces: a call site writing the
      // bare form could be resolving against either bundle's string, so its
      // placeholders cannot be compared. Record the collision rather than
      // letting the last file read win.
      if (namespaced && keys.has(k) && keys.get(k) !== v) ambiguousKeys.add(k);
      keys.set(k, v);
      if (namespaced) {
        keys.set(`${stem}.${k}`, v);
        keys.set(`${stem}:${k}`, v);
      }
    }
    catalogues.set(tag, keys);
  }

  if (localeFiles.length === 0) return empty();

  // The default locale is `en` when present, else the tag with the most keys —
  // ties broken alphabetically so the choice is deterministic.
  const tags = [...catalogues.keys()].sort();
  // The most complete catalogue is the source of truth. `en` is preferred only
  // as a tie-break: forcing it made a partial English translation of a
  // non-English source project report most of its own keys as missing.
  const defaultLocale = tags
    .slice()
    .sort(
      (a, b) =>
        catalogues.get(b)!.size - catalogues.get(a)!.size ||
        (a === "en" ? -1 : b === "en" ? 1 : 0) ||
        (a < b ? -1 : 1),
    )[0]!;
  const rawDefined = catalogues.get(defaultLocale)!;

  /**
   * The lookup table, with plural and context forms aliased BACK to their base.
   *
   * i18next v4 JSON — the default since v21 — defines `item_one` / `item_other`
   * and the call site writes `t("item")`. Without this alias every plural key in
   * every project reported as having no translation.
   */
  const defined = new Map(rawDefined);
  for (const [key, value] of rawDefined) {
    const base = key.replace(KEY_SUFFIX_RE, "");
    if (base !== key && !defined.has(base)) defined.set(base, value);
  }

  // --- call sites ------------------------------------------------------------
  const sourceFiles = (
    await fg([SOURCE_GLOB], {
      cwd: rootDirectory,
      ignore,
      absolute: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    })
  ).sort();

  const uses: KeyUse[] = [];
  let filesScanned = 0;

  for (const filePath of sourceFiles) {
    let sourceText: string;
    try {
      sourceText = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSource(filePath, sourceText);
    if (parsed.parseFailed) continue;
    attachParents(parsed.program);
    const bindings = translateBindings(parsed.program);
    if (bindings.size === 0) continue;
    // A `keyPrefix`/`keySeparator` file writes its keys in a scoped form this
    // cannot resolve; judging them would report the whole file as missing.
    if (usesKeyPrefix(parsed.program)) continue;

    filesScanned += 1;
    const locate = createLocator(sourceText);
    const normalizedFilePath = relative(rootDirectory, filePath).split(sep).join("/");

    for (const call of collectDescendants(
      parsed.program,
      (n) => n.type === "CallExpression",
      undefined,
      true,
    )) {
      const keyNode = translateCallKey(call, bindings);
      if (!keyNode) continue;
      const key = getStaticStringValue(keyNode);
      // A computed key is not a key this can check.
      if (key === null) continue;
      const args = (call.arguments as AstNode[] | undefined) ?? [];
      // i18next's second argument may be a STRING default (`t(key, "Fallback")`)
      // rather than an options object. Reading it as options made every such
      // call report as an untranslated key that renders blank.
      const stringDefault =
        args[1] !== undefined &&
        (args[1]!.type === "Literal" || args[1]!.type === "TemplateLiteral") &&
        getStaticStringValue(args[1]!) !== null;
      const optionsNode = stringDefault ? args[2] : args[1];
      const optionKeys = staticOptionKeys(optionsNode);
      const position = locate(keyNode.start as number);
      uses.push({
        key,
        normalizedFilePath,
        line: position.line,
        column: position.column,
        optionKeys,
        hasDefault: stringDefault || (optionKeys !== null && optionKeys.includes("defaultValue")),
        // An explicit `ns` names a bundle this cannot resolve to a file.
        namespaced: optionKeys !== null && optionKeys.includes("ns"),
      });
    }
  }

  // --- cross-reference -------------------------------------------------------
  const missingKeys: MissingKey[] = [];
  const placeholderMismatches: PlaceholderMismatch[] = [];

  for (const use of uses) {
    // A namespace this cannot resolve, or a default that always renders: no
    // claim is available either way.
    if (use.namespaced) continue;

    const forms = lookupForms(use.key);
    const resolved = forms.find((f) => defined.has(f));

    if (resolved === undefined) {
      if (use.hasDefault) continue;
      missingKeys.push({
        key: use.key,
        normalizedFilePath: use.normalizedFilePath,
        line: use.line,
        column: use.column,
        suggestion: suggestKey(use.key, new Set(defined.keys())),
      });
      continue;
    }

    // Placeholder comparison needs a fully static options object. It also needs
    // the translation to use ONE named syntax: an ICU plural/select carries
    // inner tokens that are not placeholders at all.
    if (use.optionKeys === null) continue;
    const translation = defined.get(resolved)!;
    const { names, unreadable } = requiredPlaceholders(translation);
    if (unreadable || names.size === 0) continue;
    // The same bare key defined in more than one namespace: the call site may
    // be resolving against a different bundle's string.
    if (ambiguousKeys.has(resolved)) continue;

    const supplied = new Set(use.optionKeys);
    const missing = [...names].filter((n) => !supplied.has(n)).sort();
    if (missing.length === 0) continue;

    placeholderMismatches.push({
      key: use.key,
      normalizedFilePath: use.normalizedFilePath,
      line: use.line,
      column: use.column,
      missing,
      translation,
    });
  }

  // Deliberately never computed — see the module header.
  const unusedKeyDetection: UnusedKeyDetection = "not-attempted-unreachable-by-static-analysis";
  const unusedKeys: string[] = [];

  const sortSites = <T extends { normalizedFilePath: string; line: number; key: string }>(rows: T[]): T[] =>
    rows
      .slice()
      .sort(
        (a, b) =>
          (a.normalizedFilePath < b.normalizedFilePath ? -1 : a.normalizedFilePath > b.normalizedFilePath ? 1 : 0) ||
          a.line - b.line ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      );

  return {
    localesPresent: true,
    localeFiles: localeFiles.sort(),
    defaultLocale,
    missingKeys: sortSites(missingKeys),
    placeholderMismatches: sortSites(placeholderMismatches),
    unusedKeys,
    unusedKeyDetection,
    summary: {
      filesScanned,
      keysDefined: defined.size,
      keysUsed: uses.length,
      missing: missingKeys.length,
      mismatched: placeholderMismatches.length,
      unused: unusedKeys.length,
    },
  };
};
