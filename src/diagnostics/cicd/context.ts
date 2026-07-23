/**
 * Shared line-scanner for GitHub Actions workflow YAML.
 *
 * A workflow is the one config file that is also a *program*: `${{ }}` is
 * textual substitution performed before the shell ever sees the command, so the
 * difference between a safe workflow and remote code execution is which key the
 * expression sits under. That means these diagnostics cannot grep — they need
 * to know whether a line is YAML structure or the body of a `run:` block, and
 * where each step begins and ends.
 *
 * No YAML parser is allowed (zero new dependencies), so this is a tolerant
 * indentation scanner in the spirit of `iac/context.ts`: it understands block
 * scalars, sequence items and nesting, and gives up quietly on anything it does
 * not recognise. Giving up quietly is the correct failure mode — every caller
 * treats "not understood" as "say nothing".
 */

/** A workflow must look like one; the glob alone would trust any stray YAML. */
const WORKFLOW_MARKER_RE = /^(?:jobs|on|"on"|'on')\s*:/m;

export const isWorkflowFile = (content: string): boolean => WORKFLOW_MARKER_RE.test(content);

/** Split on newlines, dropping the `\r` a CRLF checkout leaves on every line. */
export const splitLines = (content: string): string[] =>
  content.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));

/** Leading-whitespace width. YAML forbids tabs for indentation; count them as 1. */
export const indentOf = (line: string): number => {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  return i;
};

const ITEM_PREFIX_RE = /^([ \t]*)((?:-[ \t]+)*)/;

/**
 * The column at which this line's mapping key starts — i.e. past any `- `
 * sequence markers. Sibling keys of a step share this column, which is what
 * makes step boundaries detectable without a parser.
 */
export const keyColumnOf = (line: string): number => {
  const m = ITEM_PREFIX_RE.exec(line)!;
  return m[1]!.length + m[2]!.length;
};

export const isSequenceItem = (line: string): boolean => /^[ \t]*-[ \t]/.test(line);

/**
 * A blank or comment-only line. Structural scanning must step over these:
 * outside a block scalar a `#` line carries no nesting, so letting its column
 * close a step would silently truncate the step's `with:` block.
 */
export const isIgnorableLine = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("#");
};

const KEY_LINE_RE = /^([ \t]*)((?:-[ \t]+)*)("[^"]*"|'[^']*'|[A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t]|$)/;

export interface KeyLine {
  /** Key name, unquoted and lower-cased (`"on"` and `on` are the same key). */
  key: string;
  keyColumn: number;
  /** Everything after `key:`, verbatim (may be empty). */
  value: string;
  /** 0-based offset of `value` within the original line. */
  valueColumn: number;
}

/** Parse `  - run: echo hi` into its key and value, or null if it is not a key line. */
export const parseKeyLine = (line: string): KeyLine | null => {
  const m = KEY_LINE_RE.exec(line);
  if (!m) return null;
  const keyEnd = m[1]!.length + m[2]!.length + m[3]!.length;
  const colon = line.indexOf(":", keyEnd);
  if (colon < 0) return null;
  let v = colon + 1;
  while (v < line.length && (line[v] === " " || line[v] === "\t")) v++;
  const rawKey = m[3]!;
  const key = (rawKey.startsWith('"') || rawKey.startsWith("'") ? rawKey.slice(1, -1) : rawKey).toLowerCase();
  return { key, keyColumn: m[1]!.length + m[2]!.length, value: line.slice(v), valueColumn: v };
};

/** `|`, `>`, `|-`, `>+`, `|2` … optionally followed by a YAML comment. */
const BLOCK_INDICATOR_RE = /^[|>][+-]?\d*[ \t]*(?:#.*)?$/;

/**
 * Which lines are *inside* a block scalar (`run: |`) and therefore free text
 * rather than YAML structure. Without this mask a shell line such as
 * `echo "uses: evil/action@v1"` would be read as a step key.
 */
export const blockScalarMask = (lines: string[]): boolean[] => {
  const mask = new Array<boolean>(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    const parsed = parseKeyLine(lines[i]!);
    if (!parsed || !BLOCK_INDICATOR_RE.test(parsed.value)) {
      i++;
      continue;
    }
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      // Blank lines never close a block scalar; a dedent to the key's column does.
      if (line.trim().length === 0) {
        mask[j] = true;
        continue;
      }
      if (indentOf(line) <= parsed.keyColumn) break;
      mask[j] = true;
    }
    i = j;
  }
  return mask;
};

/** The content lines of the block scalar opened at `keyIndex` (exclusive of the key line). */
export const blockScalarBody = (lines: string[], keyIndex: number, keyColumn: number): number[] => {
  const body: number[] = [];
  for (let j = keyIndex + 1; j < lines.length; j++) {
    const line = lines[j]!;
    if (line.trim().length === 0) continue;
    if (indentOf(line) <= keyColumn) break;
    body.push(j);
  }
  return body;
};

/**
 * The half-open extent of the step containing `index`: from its `- ` marker up
 * to (but excluding) the next sibling step or the dedent that ends the list.
 * Used to tie a `with: ref:` back to the `uses:` it configures.
 */
export const stepRange = (lines: string[], mask: boolean[], index: number): { start: number; end: number } => {
  const column = keyColumnOf(lines[index]!);
  let start = index;
  for (let j = index; j >= 0; j--) {
    if (mask[j] || isIgnorableLine(lines[j]!)) continue;
    if (isSequenceItem(lines[j]!) && keyColumnOf(lines[j]!) === column) {
      start = j;
      break;
    }
    if (keyColumnOf(lines[j]!) < column) break;
  }
  for (let j = start + 1; j < lines.length; j++) {
    if (mask[j] || isIgnorableLine(lines[j]!)) continue;
    const col = keyColumnOf(lines[j]!);
    if (isSequenceItem(lines[j]!) ? col <= column : col < column) return { start, end: j - 1 };
  }
  return { start, end: lines.length - 1 };
};

/**
 * The key of the nearest enclosing mapping — the first key line above `index`
 * at a shallower column. Callers use it to tell a step's own `run:`/`uses:`
 * from an action *input* that happens to share the name (`with: { run: … }`),
 * which is data the action interprets, not something the runner executes.
 */
export const parentKeyOf = (lines: string[], mask: boolean[], index: number): string | null => {
  const column = keyColumnOf(lines[index]!);
  for (let j = index - 1; j >= 0; j--) {
    if (mask[j] || isIgnorableLine(lines[j]!)) continue;
    if (keyColumnOf(lines[j]!) >= column) continue;
    return parseKeyLine(lines[j]!)?.key ?? null;
  }
  return null;
};

/** Strip a trailing YAML comment and surrounding quotes from a scalar value. */
export const scalarValue = (value: string): string => {
  let v = value.replace(/\s+#.*$/, "").trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1);
  }
  return v;
};

const TRIGGER_NAME_RE = /^[ \t]*(?:-[ \t]+)?([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:?/;

/**
 * The event names under the top-level `on:` key, covering all three spellings
 * GitHub accepts: `on: push`, `on: [a, b]`, and a nested mapping or list.
 * Returned sorted so callers can log it deterministically.
 */
export const workflowTriggers = (lines: string[], mask: boolean[]): string[] => {
  const found = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (mask[i] || indentOf(lines[i]!) !== 0) continue;
    const parsed = parseKeyLine(lines[i]!);
    if (!parsed || parsed.key !== "on" || parsed.keyColumn !== 0) continue;

    const inline = scalarValue(parsed.value);
    if (inline.length > 0) {
      const items = inline.startsWith("[") ? inline.replace(/^\[|\]$/g, "").split(",") : [inline];
      for (const item of items) {
        const name = scalarValue(item);
        if (name.length > 0) found.add(name.toLowerCase());
      }
      continue;
    }

    // Block form: only the shallowest nesting level names events; anything
    // deeper is a filter (`types:`, `branches:`).
    let baseIndent = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (mask[j] || isIgnorableLine(lines[j]!)) continue;
      const indent = indentOf(lines[j]!);
      if (indent === 0) break;
      if (baseIndent === -1) baseIndent = indent;
      if (indent !== baseIndent) continue;
      const m = TRIGGER_NAME_RE.exec(lines[j]!);
      if (m) found.add(m[1]!.toLowerCase());
    }
  }
  return [...found].sort();
};
