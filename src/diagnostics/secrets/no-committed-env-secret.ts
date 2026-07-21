import { defineTextDiagnostic } from "../../core/text-scan.ts";
import { secretInAssignment, cleanValue } from "../../core/secret-patterns.ts";

/**
 * A real secret committed in a `.env` file. `.env` holds live credentials; once
 * committed they are in git history forever and ship in every clone. Gated to
 * git-tracked files, so a gitignored local `.env` is never flagged, and skips
 * `.env.example`/`.sample`/`.template` (placeholder files meant to be committed).
 *
 * ❌ .env:          STRIPE_SECRET_KEY=sk_live_<24-char live key>
 * ✅ .env.example:  STRIPE_SECRET_KEY=your_stripe_key_here
 */

const EXAMPLE_RE = /\.(example|sample|template|tmpl|dist)$/i;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const noCommittedEnvSecret = defineTextDiagnostic({
  id: "no-committed-env-secret",
  title: "Committed secret in an env file",
  severity: "error",
  category: "Security",
  tags: ["secrets"],
  files: ["**/.env", "**/.env.*"],
  committedFilesOnly: true,
  maxBytes: 128 * 1024,
  recommendation:
    "Remove the secret from the committed .env and rotate it (it's in git history). Keep only a `.env.example` with placeholder values, gitignore the real `.env`, and load secrets from the environment or a secret manager.",
  scan: (ctx) => {
    if (EXAMPLE_RE.test(ctx.normalizedFilePath)) return; // placeholder file, meant to be committed
    const lines = ctx.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trimStart();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim().replace(/^export[ \t]+/, "");
      if (!ENV_KEY_RE.test(key)) continue;
      const rawValue = line.slice(eq + 1);
      const value = cleanValue(rawValue);
      if (value.length === 0 || value.startsWith("$")) continue; // empty or an env-var reference
      const reason = secretInAssignment(key, value);
      if (reason) {
        ctx.report({
          line: i + 1,
          column: eq + 2,
          message: `\`${key}\` in a committed env file holds ${reason} — this credential is in your git history.`,
        });
      }
    }
  },
});
