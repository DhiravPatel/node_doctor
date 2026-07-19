/**
 * Hand-rolled argument parsing (no commander/yargs — dependency policy §4).
 * Recognizes subcommands, boolean flags, value flags, and the repeatable
 * `--ignore-tag`.
 */

export type Command = "scan" | "diagnostics" | "delta" | "install" | "deslop" | "explain" | "init" | "mcp";

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
  "rules",
]);

export interface ParsedArgs {
  command: Command;
  positionals: string[];
  json: boolean;
  jsonOut?: string;
  sarifOut?: string;
  htmlOut?: string;
  annotations: boolean;
  fix: boolean;
  cache: boolean;
  watch: boolean;
  verbose: boolean;
  blocking: "error" | "warning" | "none";
  ignoreTags: string[];
  only?: string;
  diff?: string; // "" means "--diff with no base"
  staged: boolean;
  config?: string;
  offline: boolean;
  help: boolean;
  version: boolean;
  // delta
  baseline?: string;
  current?: string;
  // install
  client?: string;
  errors: string[];
}

const VALUE_FLAGS = new Set([
  "--json-out",
  "--sarif-out",
  "--html-out",
  "--blocking",
  "--ignore-tag",
  "--only",
  "--config",
  "--baseline",
  "--current",
  "--client",
]);

const asBlocking = (value: string, errors: string[]): "error" | "warning" | "none" => {
  if (value === "error" || value === "warning" || value === "none") return value;
  errors.push(`--blocking must be one of: error, warning, none (got "${value}")`);
  return "error";
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
    verbose: false,
    blocking: "error",
    ignoreTags: [],
    staged: false,
    offline: true,
    help: false,
    version: false,
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
    if (token === "--verbose" || token === "-v") {
      result.verbose = true;
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
