/**
 * Hand-rolled argument parsing (no commander/yargs — dependency policy §4).
 * Recognizes subcommands, boolean flags, value flags, and the repeatable
 * `--ignore-tag`.
 */

export type Command =
  | "scan"
  | "diagnostics"
  | "delta"
  | "install"
  | "deslop"
  | "explain"
  | "init"
  | "mcp"
  | "fix"
  | "ci"
  | "conventions"
  | "ratchet"
  | "surface"
  | "sbom"
  | "lsp"
  | "modernize"
  | "impact"
  | "paths"
  | "context"
  | "version";

// "rules" is accepted as a legacy alias for "diagnostics".
const COMMAND_ALIASES: Record<string, Command> = { rules: "diagnostics" };

const COMMANDS = new Set<string>([
  "scan",
  "diagnostics",
  "delta",
  "install",
  "deslop",
  "explain",
  "init",
  "mcp",
  "fix",
  "ci",
  "conventions",
  "ratchet",
  "surface",
  "sbom",
  "lsp",
  "modernize",
  "impact",
  "paths",
  "context",
  "version",
  "rules",
]);

/**
 * Flags removed during CLI evolution (or borrowed from sibling tools). We fail
 * loudly with migration guidance instead of silently ignoring an unknown option
 * that a user reasonably expects to work.
 */
const REMOVED_FLAGS: Record<string, string> = {
  "--fail-on": "use --blocking <error|warning|none> instead",
  "--format": "use --json (and --json-out / --sarif-out / --html-out) instead",
  "--quiet": "use --score for a score-only summary instead",
};

const CATEGORY_BY_LOWER = new Map<string, string>([
  ["security", "Security"],
  ["reliability", "Reliability"],
  ["bugs", "Bugs"],
  ["performance", "Performance"],
  ["maintainability", "Maintainability"],
]);

export interface ParsedArgs {
  command: Command;
  positionals: string[];
  json: boolean;
  jsonOut?: string;
  sarifOut?: string;
  htmlOut?: string;
  mdOut?: string;
  annotations: boolean;
  fix: boolean;
  cache: boolean;
  watch: boolean;
  // agent-fix flow
  yes: boolean;
  print: boolean;
  review: boolean;
  verify: boolean; // (fix) re-scan and machine-verify after the agent runs
  agent?: string;
  verbose: boolean;
  blocking: "error" | "warning" | "none";
  ignoreTags: string[];
  only?: string;
  diff?: string; // "" means "--diff with no base"
  staged: boolean;
  /** Run type-aware diagnostics (needs a TypeScript compiler in the project). */
  typed: boolean;
  config?: string;
  offline: boolean;
  help: boolean;
  version: boolean;
  // display filters (never change the score or CI gate)
  categories: string[];
  warnings: boolean;
  // `diagnostics` list filters
  tags: string[];
  framework?: string;
  configured: boolean;
  // scope
  scope?: "lines" | "files";
  changedFilesFrom?: string;
  includeUntracked: boolean;
  // output shaping
  scoreOnly: boolean;
  jsonCompact: boolean;
  color?: boolean; // undefined = auto (TTY + NO_COLOR aware)
  // engine controls
  audit: boolean;
  maxDuration?: number; // seconds
  deadCode?: boolean; // undefined = default (off in scan)
  parallel: boolean; // false disables the concurrency pool
  secrets: boolean; // false disables the whole-tree secret/config-file scan
  // monorepo / workspaces
  workspaces: boolean; // false forces a single-project scan of the root
  projectFilter: string[]; // --project <name|path> (repeatable)
  // delta
  baseline?: string;
  current?: string;
  // install
  client?: string;
  gitHook: boolean; // `install --git-hook`
  agentHooks: boolean; // `install --agent-hooks`
  packageScript: boolean; // `install --package-script`
  skill?: string; // `install --skill improve-node`
  fixDiff: boolean; // emit safe autofixes as a unified diff instead of writing
  overwrite: boolean; // (conventions) overwrite an existing file
  write: boolean; // (context) generate the ignore artifacts on disk
  history: boolean; // (scan) also scan git history for secrets
  owners: boolean; // (scan) group findings by CODEOWNERS team
  risk: boolean; // (delta) print a PR risk score
  errors: string[];
}

const VALUE_FLAGS = new Set([
  "--json-out",
  "--sarif-out",
  "--html-out",
  "--md-out",
  "--blocking",
  "--ignore-tag",
  "--only",
  "--config",
  "--baseline",
  "--current",
  "--client",
  "--skill",
  "--agent",
  "--category",
  "--scope",
  "--changed-files-from",
  "--max-duration",
  "--tag",
  "--framework",
  "--project",
]);

const asBlocking = (value: string, errors: string[]): "error" | "warning" | "none" => {
  if (value === "error" || value === "warning" || value === "none") return value;
  errors.push(`--blocking must be one of: error, warning, none (got "${value}")`);
  return "error";
};

const asScope = (value: string, errors: string[]): "lines" | "files" | undefined => {
  if (value === "lines" || value === "files") return value;
  errors.push(`--scope must be one of: lines, files (got "${value}")`);
  return undefined;
};

/** Validate + canonicalize a `--category` value (comma-separated allowed). */
const addCategories = (value: string, into: string[], errors: string[]): void => {
  for (const raw of value.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const canonical = CATEGORY_BY_LOWER.get(token.toLowerCase());
    if (!canonical) {
      errors.push(`--category "${token}" is not valid. Choose from: ${[...CATEGORY_BY_LOWER.values()].join(", ")}`);
      continue;
    }
    if (!into.includes(canonical)) into.push(canonical);
  }
};

const asPositiveSeconds = (value: string, errors: string[]): number | undefined => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    errors.push(`--max-duration must be a positive number of seconds (got "${value}")`);
    return undefined;
  }
  return n;
};

export const parseArgs = (argv: string[]): ParsedArgs => {
  const result: ParsedArgs = {
    command: "scan",
    positionals: [],
    json: false,
    annotations: false,
    fix: false,
    cache: false,
    watch: false,
    yes: false,
    print: false,
    review: false,
    verify: false,
    verbose: false,
    blocking: "error",
    ignoreTags: [],
    staged: false,
    typed: false,
    offline: true,
    help: false,
    version: false,
    categories: [],
    warnings: true,
    tags: [],
    configured: false,
    includeUntracked: false,
    scoreOnly: false,
    jsonCompact: false,
    audit: false,
    parallel: true,
    secrets: true,
    workspaces: true,
    projectFilter: [],
    gitHook: false,
    agentHooks: false,
    packageScript: false,
    fixDiff: false,
    overwrite: false,
    write: false,
    history: false,
    owners: false,
    risk: false,
    errors: [],
  };

  let commandLocked = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "--help" || token === "-h") {
      result.help = true;
      continue;
    }
    if (token === "--version" || token === "-V") {
      result.version = true;
      continue;
    }
    if (token === "--json") {
      result.json = true;
      continue;
    }
    if (token === "--annotations") {
      result.annotations = true;
      continue;
    }
    if (token === "--fix") {
      result.fix = true;
      continue;
    }
    if (token === "--cache") {
      result.cache = true;
      continue;
    }
    if (token === "--watch") {
      result.watch = true;
      continue;
    }
    if (token === "--yes" || token === "-y") {
      result.yes = true;
      continue;
    }
    if (token === "--print") {
      result.print = true;
      continue;
    }
    if (token === "--review") {
      result.review = true;
      continue;
    }
    if (token === "--verify") {
      result.verify = true;
      continue;
    }
    if (token === "--verbose" || token === "-v") {
      result.verbose = true;
      continue;
    }
    if (token === "--typed") {
      result.typed = true;
      continue;
    }
    if (token === "--staged") {
      result.staged = true;
      continue;
    }
    if (token === "--offline") {
      result.offline = true;
      continue;
    }
    if (token === "--score") {
      result.scoreOnly = true;
      continue;
    }
    if (token === "--audit" || token === "--no-respect-inline-disables") {
      result.audit = true;
      continue;
    }
    if (token === "--json-compact") {
      result.json = true;
      result.jsonCompact = true;
      continue;
    }
    if (token === "--include-untracked") {
      result.includeUntracked = true;
      continue;
    }
    if (token === "--configured") {
      result.configured = true;
      continue;
    }
    if (token === "--parallel") {
      result.parallel = true;
      continue;
    }
    if (token === "--no-parallel") {
      result.parallel = false;
      continue;
    }
    if (token === "--secrets") {
      result.secrets = true;
      continue;
    }
    if (token === "--no-secrets") {
      result.secrets = false;
      continue;
    }
    if (token === "--git-hook") {
      result.gitHook = true;
      continue;
    }
    if (token === "--agent-hooks") {
      result.agentHooks = true;
      continue;
    }
    if (token === "--package-script") {
      result.packageScript = true;
      continue;
    }
    if (token === "--fix-diff") {
      result.fixDiff = true;
      continue;
    }
    if (token === "--overwrite") {
      result.overwrite = true;
      continue;
    }
    if (token === "--write") {
      result.write = true;
      continue;
    }
    if (token === "--history") {
      result.history = true;
      continue;
    }
    if (token === "--owners") {
      result.owners = true;
      continue;
    }
    if (token === "--risk") {
      result.risk = true;
      continue;
    }
    if (token === "--workspaces") {
      result.workspaces = true;
      continue;
    }
    if (token === "--no-workspaces") {
      result.workspaces = false;
      continue;
    }
    if (token === "--lines") {
      result.scope = "lines";
      continue;
    }
    if (token === "--warnings") {
      result.warnings = true;
      continue;
    }
    if (token === "--no-warnings") {
      result.warnings = false;
      continue;
    }
    if (token === "--color") {
      result.color = true;
      continue;
    }
    if (token === "--no-color") {
      result.color = false;
      continue;
    }
    if (token === "--dead-code") {
      result.deadCode = true;
      continue;
    }
    if (token === "--no-dead-code") {
      result.deadCode = false;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(REMOVED_FLAGS, token)) {
      result.errors.push(`${token} was removed — ${REMOVED_FLAGS[token]}`);
      continue;
    }
    if (token === "--diff") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        result.diff = next;
        i++;
      } else {
        result.diff = "";
      }
      continue;
    }

    if (VALUE_FLAGS.has(token)) {
      const value = argv[i + 1];
      if (value === undefined) {
        result.errors.push(`${token} requires a value`);
        continue;
      }
      i++;
      switch (token) {
        case "--json-out":
          result.jsonOut = value;
          break;
        case "--sarif-out":
          result.sarifOut = value;
          break;
        case "--html-out":
          result.htmlOut = value;
          break;
        case "--md-out":
          result.mdOut = value;
          break;
        case "--blocking":
          result.blocking = asBlocking(value, result.errors);
          break;
        case "--ignore-tag":
          result.ignoreTags.push(value);
          break;
        case "--only":
          result.only = value;
          break;
        case "--config":
          result.config = value;
          break;
        case "--baseline":
          result.baseline = value;
          break;
        case "--current":
          result.current = value;
          break;
        case "--client":
          result.client = value;
          break;
        case "--skill":
          result.skill = value;
          break;
        case "--agent":
          result.agent = value;
          break;
        case "--category":
          addCategories(value, result.categories, result.errors);
          break;
        case "--scope":
          result.scope = asScope(value, result.errors);
          break;
        case "--changed-files-from":
          result.changedFilesFrom = value;
          break;
        case "--max-duration":
          result.maxDuration = asPositiveSeconds(value, result.errors);
          break;
        case "--tag":
          if (!result.tags.includes(value)) result.tags.push(value);
          break;
        case "--framework":
          result.framework = value;
          break;
        case "--project":
          if (!result.projectFilter.includes(value)) result.projectFilter.push(value);
          break;
      }
      continue;
    }

    if (token.startsWith("-")) {
      result.errors.push(`unknown option: ${token}`);
      continue;
    }

    // Positional. The first positional may be a subcommand (or a legacy alias).
    if (!commandLocked && result.positionals.length === 0 && COMMANDS.has(token)) {
      result.command = COMMAND_ALIASES[token] ?? (token as Command);
      commandLocked = true;
      continue;
    }
    result.positionals.push(token);
  }

  return result;
};
