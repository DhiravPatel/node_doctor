import { defineTextDiagnostic } from "../../core/text-scan.ts";
import { KEY_PREFIX_RE, PLACEHOLDER_RE, PROVIDER_KEY_INLINE_RE, SECRET_NAME_RE } from "../../core/secret-patterns.ts";
import { DOCKERFILE_GLOBS, columnOf, parseDockerfile } from "./dockerfile.ts";

/**
 * A credential baked into an image layer by `ENV` or `ARG`.
 *
 * Layers are not private. Every instruction is recorded in the image metadata,
 * so `docker history --no-trunc` hands the value to anyone who can pull the
 * image, and deleting the file in a later layer does not remove it. A registry
 * that is "internal" today is a supply-chain leak the moment the image is
 * mirrored, exported, or made public — and the credential is live the whole time.
 *
 * Both halves must line up before this fires: a secret-shaped NAME and a value
 * that is real key material. A build arg declared without a value is the correct
 * pattern and stays silent, as do placeholders and `${…}` references.
 *
 * ❌ ENV AWS_SECRET_ACCESS_KEY=AKIA…            // in the layer forever
 * ❌ ARG NPM_TOKEN=npm_…                        // and in `docker history`
 * ✅ ARG NPM_TOKEN                              // supplied at build time
 * ✅ RUN --mount=type=secret,id=npm  npm ci     // never lands in a layer
 * ✅ ENV NODE_ENV=production
 */

/** npm automation tokens, which the shared provider list does not cover. */
const NPM_TOKEN_RE = /^npm_[A-Za-z0-9]{20,}$/;

/** Names the shared pattern misses but that are unambiguous in a Dockerfile. */
const EXTRA_SECRET_NAME_RE = /(^|[._-])(passphrase|apikey|accesskey|secretkey)([._-]|$)/i;

/**
 * Values that announce themselves as fake. `django-insecure-` and friends carry
 * high-entropy tails, so entropy alone would happily flag a framework's own
 * "replace me in production" default.
 */
const FAKE_VALUE_RE =
  /^(django-insecure-|not[-_]?a[-_]?secret|no[-_]?secret|fake|test|testing|dev|development|local|localhost|none|null|undefined|todo|tbd|secret|password|abc123|foobar)/i;

/**
 * A contiguous run of key-alphabet characters. Real key material has one; header
 * names, hyphenated identifiers, versions, and paths (`x-auth-token`,
 * `1.2.3`, `/run/secrets/api_key`) do not, which is what keeps this quiet.
 */
const KEY_MATERIAL_RUN_RE = /[A-Za-z0-9+/=_]{20,}/;

/** A run long enough to be a key, mixing letters and digits as key material does. */
const hasKeyMaterial = (value: string): boolean => {
  const run = KEY_MATERIAL_RUN_RE.exec(value)?.[0];
  // A run of only letters or only digits is a word or a number, not a key.
  return run !== undefined && /[0-9]/.test(run) && /[A-Za-z]/.test(run);
};

/**
 * Is this value real key material? Returns null for anything we would be
 * guessing about — the default answer, and the reason this rule can ship on.
 */
const keyMaterialKind = (value: string): "provider" | "entropy" | null => {
  if (value.length < 8) return null;
  // `$FOO`/`${FOO}` is a reference; the value lives wherever the arg is set.
  if (value.includes("$")) return null;
  // A path or URL is configuration, not a credential, however secret its name.
  if (value.startsWith("/") || value.includes("://")) return null;
  if (/\s/.test(value)) return null;

  // The length-bounded provider shapes are unambiguous on their own.
  if (PROVIDER_KEY_INLINE_RE.test(value) || NPM_TOKEN_RE.test(value)) return "provider";
  if (PLACEHOLDER_RE.test(value) || FAKE_VALUE_RE.test(value)) return null;
  // A bare provider *prefix* is not enough: `sk_test_placeholder` is a stub.
  if (!hasKeyMaterial(value)) return null;
  // A lower_snake_case word list is a configuration enum, not key material:
  // `OIDC_TOKEN_AUTH_METHOD=client_secret_post_v2` names an OAuth client
  // authentication method, and its name legitimately contains both TOKEN and
  // SECRET. Real generated key material is mixed-case or non-alphabetic.
  if (/^[a-z][a-z0-9_]*$/.test(value) && value.includes("_")) return null;
  return KEY_PREFIX_RE.test(value) ? "provider" : "entropy";
};

const isSecretName = (name: string): boolean => SECRET_NAME_RE.test(name) || EXTRA_SECRET_NAME_RE.test(name);

/** Split an ENV/ARG argument list on whitespace, honouring quotes and escapes. */
const tokenize = (args: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let quoted = false;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (quote !== null) {
      if (c === "\\" && i + 1 < args.length) {
        current += args[i + 1];
        i++;
      } else if (c === quote) {
        quote = null;
      } else {
        current += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      quoted = true;
    } else if (/\s/.test(c)) {
      if (current.length > 0 || quoted) tokens.push(current);
      current = "";
      quoted = false;
    } else {
      current += c;
    }
  }
  if (current.length > 0 || quoted) tokens.push(current);
  return tokens;
};

/** The `name=value` assignments an ENV/ARG instruction bakes into the layer. */
const assignments = (keyword: string, args: string): Array<{ name: string; value: string }> => {
  const tokens = tokenize(args);
  if (tokens.length === 0) return [];
  // Legacy `ENV KEY value with spaces` — one variable, value is the remainder.
  if (keyword === "ENV" && tokens.length >= 2 && !tokens[0]!.includes("=")) {
    return [{ name: tokens[0]!, value: tokens.slice(1).join(" ") }];
  }
  const out: Array<{ name: string; value: string }> = [];
  for (const token of tokens) {
    const eq = token.indexOf("=");
    // `ARG NPM_TOKEN` with no value is the correct build-arg pattern.
    if (eq <= 0) continue;
    out.push({ name: token.slice(0, eq), value: token.slice(eq + 1) });
  }
  return out;
};

export const dockerfileSecretInBuildStage = defineTextDiagnostic({
  id: "dockerfile-secret-in-build-stage",
  title: "Secret baked into an image layer",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["container", "docker", "secrets"],
  files: DOCKERFILE_GLOBS,
  maxBytes: 128 * 1024,
  recommendation:
    "Remove the value from the Dockerfile and rotate the credential — it is already in the image history and in git. Feed build-time credentials through BuildKit secrets (`RUN --mount=type=secret,id=…`), which never land in a layer, and inject runtime credentials from the orchestrator's secret store rather than `ENV`.",
  scan: (ctx) => {
    const instructions = parseDockerfile(ctx.content);
    if (!instructions) return;

    for (const instruction of instructions) {
      if (instruction.keyword !== "ENV" && instruction.keyword !== "ARG") continue;
      for (const { name, value } of assignments(instruction.keyword, instruction.args)) {
        if (!isSecretName(name)) continue;
        const kind = keyMaterialKind(value);
        if (!kind) continue;
        const detail =
          kind === "provider" ? "a recognizable provider key" : "what looks like real key material";
        ctx.report({
          line: instruction.line,
          column: columnOf(instruction, name),
          // The value is never echoed: findings travel through logs and CI output.
          message: `\`${instruction.keyword} ${name}\` hardcodes ${detail} into an image layer — \`docker history\` shows it to anyone who can pull the image.`,
        });
      }
    }
  },
});
