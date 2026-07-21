import { defineTextDiagnostic } from "../../core/text-scan.ts";
import { PROVIDER_KEY_INLINE_RE, PEM_PRIVATE_KEY_RE } from "../../core/secret-patterns.ts";

/**
 * A recognizable provider key or private key hardcoded in a config, CI, or IaC
 * file (YAML, JSON, TOML, Dockerfile, `*.tfvars`, …). Only unambiguous provider
 * shapes fire (`sk_live_…`, `AKIA…`, `ghp_…`, `AIza…`, a PEM block), so a
 * `${{ secrets.X }}` reference or an env placeholder never trips it.
 *
 * ❌ docker-compose.yml:  AWS_SECRET_ACCESS_KEY: AKIAIOSFODNN7EXAMPLE…
 * ❌ config.yml:          apiKey: sk_live_<24-char live key>
 * ✅ ci.yml:              token: ${{ secrets.NPM_TOKEN }}
 */
export const noSecretInConfigFile = defineTextDiagnostic({
  id: "no-secret-in-config-file",
  title: "Hardcoded secret in a config or CI file",
  severity: "error",
  category: "Security",
  tags: ["secrets"],
  files: [
    "**/*.yml",
    "**/*.yaml",
    "**/*.json",
    "**/*.toml",
    "**/*.ini",
    "**/*.tfvars",
    "**/*.conf",
    "**/Dockerfile",
    "**/Dockerfile.*",
  ],
  maxBytes: 256 * 1024,
  recommendation:
    "Move the secret out of the committed config into an injected secret (CI secret store, environment variable, or secret manager) and reference it. Never commit a provider key or private key.",
  scan: (ctx) => {
    const lines = ctx.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const m = PROVIDER_KEY_INLINE_RE.exec(line);
      if (m) {
        ctx.report({
          line: i + 1,
          column: (m.index ?? 0) + 1,
          message: "A recognizable provider key is hardcoded in this config/CI file — inject it as a secret instead.",
        });
        continue;
      }
      if (PEM_PRIVATE_KEY_RE.test(line)) {
        ctx.report({ line: i + 1, message: "A PEM private key is embedded in this config file — remove and rotate it." });
      }
    }
  },
});
