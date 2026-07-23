/**
 * Shared tolerant Dockerfile reader for the container diagnostics.
 *
 * There is no Dockerfile parser dependency and there will never be one, so this
 * hand-rolls the two things every check in this bucket needs: logical
 * instructions (line continuations joined, comment lines dropped) and stage
 * boundaries.
 *
 * Stages are the whole game. A builder stage that runs as root or pulls an
 * unpinned base behaves nothing like the stage that actually ships, so getting
 * `FROM … AS name` — and `FROM <earlier-stage>` inheritance — right is worth
 * doing once, here, rather than three slightly-different times.
 */

/** File names that are a container build recipe (used by every diagnostic here). */
export const DOCKERFILE_GLOBS = [
  "**/Dockerfile",
  "**/Dockerfile.*",
  "**/*.Dockerfile",
  "**/Containerfile",
];

export interface DockerInstruction {
  /** Upper-cased keyword, e.g. `FROM`, `USER`, `ENV`. */
  keyword: string;
  /** Everything after the keyword, continuations joined with a single space. */
  args: string;
  /** 1-based line of the keyword itself. */
  line: number;
  /** The first physical line, verbatim — the only sound basis for a column. */
  raw: string;
}

export interface DockerStage {
  /** Image reference as written, `--flags` stripped (`node:20-alpine`, `builder`, `${BASE}`). */
  image: string;
  /** Lower-cased `AS` name, or null for an anonymous stage. */
  name: string | null;
  /** The `FROM` instruction that opened the stage. */
  from: DockerInstruction;
  /** Instructions belonging to this stage (the `FROM` itself excluded). */
  instructions: DockerInstruction[];
}

const ESCAPE_DIRECTIVE_RE = /^#\s*escape\s*=\s*(\S)/i;
const isComment = (line: string): boolean => line.trimStart().startsWith("#");
const isBlank = (line: string): boolean => line.trim().length === 0;

/**
 * A `# escape=` parser directive redefines what a line continuation looks like.
 * Rather than model the alternative, we refuse to read the file at all — a
 * misread continuation would merge two instructions and invent findings.
 */
const usesDefaultEscape = (lines: string[]): boolean => {
  for (const raw of lines) {
    if (isBlank(raw)) continue;
    if (!isComment(raw)) return true;
    const m = ESCAPE_DIRECTIVE_RE.exec(raw.trim());
    if (m) return m[1] === "\\";
  }
  return true;
};

/** Logical instructions in file order, or null when the file cannot be read soundly. */
export const parseDockerfile = (content: string): DockerInstruction[] | null => {
  const lines = content.split("\n").map((l) => l.replace(/\r$/, ""));
  if (!usesDefaultEscape(lines)) return null;

  const out: DockerInstruction[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    const line = i + 1;
    i++;
    if (isBlank(raw) || isComment(raw)) continue;

    let text = raw;
    // A trailing `\` carries the instruction onto the next line; blank and
    // comment lines inside a continuation are ignored by the real parser too.
    while (/\\\s*$/.test(text) && i < lines.length) {
      text = text.replace(/\\\s*$/, " ");
      let next = lines[i]!;
      i++;
      while ((isBlank(next) || isComment(next)) && i < lines.length) {
        next = lines[i]!;
        i++;
      }
      if (isBlank(next) || isComment(next)) break;
      text += next;
    }

    const m = /^\s*([A-Za-z][A-Za-z0-9_]*)\s+([\s\S]*)$/.exec(text);
    if (!m) continue;
    out.push({ keyword: m[1]!.toUpperCase(), args: m[2]!.trim(), line, raw });
  }
  return out;
};

/** Split instructions into build stages. Anything before the first `FROM` is dropped. */
export const parseStages = (instructions: DockerInstruction[]): DockerStage[] => {
  const stages: DockerStage[] = [];
  for (const instruction of instructions) {
    if (instruction.keyword === "FROM") {
      const tokens = instruction.args.split(/\s+/).filter((t) => t.length > 0);
      let index = 0;
      while (index < tokens.length && tokens[index]!.startsWith("--")) index++;
      const image = tokens[index] ?? "";
      const name =
        tokens[index + 1]?.toLowerCase() === "as" && tokens[index + 2] ? tokens[index + 2]!.toLowerCase() : null;
      stages.push({ image, name, from: instruction, instructions: [] });
      continue;
    }
    stages[stages.length - 1]?.instructions.push(instruction);
  }
  return stages;
};

export interface ImageRef {
  /** Repository path with registry host and `library/` intact. */
  repository: string;
  tag: string | null;
  digest: string | null;
}

/** Split `registry:5000/org/img:tag@sha256:…` without mistaking a port for a tag. */
export const parseImageRef = (image: string): ImageRef => {
  let rest = image;
  let digest: string | null = null;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag: string | null = null;
  const colon = rest.indexOf(":", rest.lastIndexOf("/") + 1);
  if (colon >= 0) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  return { repository: rest, tag, digest };
};

/** `docker.io/library/node` → `node`, so an allowlist can be written once. */
export const canonicalRepository = (repository: string): string => {
  const parts = repository.split("/");
  if (parts.length > 1 && (parts[0]!.includes(".") || parts[0]!.includes(":") || parts[0] === "localhost")) {
    parts.shift();
  }
  if (parts.length > 1 && parts[0] === "library") parts.shift();
  return parts.join("/").toLowerCase();
};

/** A `${BASE}`/`$BASE` reference resolves at build time — we cannot know its value. */
export const isTemplated = (value: string): boolean => value.includes("$");

/** Index of the stage `image` names, or -1 when it is a real registry reference. */
export const stageIndexByName = (stages: DockerStage[], image: string): number => {
  const wanted = image.toLowerCase();
  return stages.findIndex((s) => s.name !== null && s.name === wanted);
};

/** 1-based column of `needle` within an instruction's first physical line. */
export const columnOf = (instruction: DockerInstruction, needle: string): number => {
  const index = needle.length > 0 ? instruction.raw.indexOf(needle) : -1;
  return index >= 0 ? index + 1 : 1;
};
