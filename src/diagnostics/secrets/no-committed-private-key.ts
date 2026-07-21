import { defineTextDiagnostic } from "../../core/text-scan.ts";
import { PEM_PRIVATE_KEY_RE } from "../../core/secret-patterns.ts";

/**
 * A PEM private key committed to the repository. A committed key is compromised
 * the moment it lands — it's in history and in every clone. Gated to git-tracked
 * files; fires only when the file actually contains a `PRIVATE KEY` block, so a
 * `.key` file that isn't a key stays silent.
 *
 * ❌ server.key:  -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA…
 * ✅ keep keys out of the repo — load from a secret manager or a gitignored path.
 */
export const noCommittedPrivateKey = defineTextDiagnostic({
  id: "no-committed-private-key",
  title: "Committed private key",
  severity: "error",
  category: "Security",
  tags: ["secrets"],
  files: ["**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa", "**/id_dsa", "**/id_ecdsa", "**/id_ed25519"],
  committedFilesOnly: true,
  maxBytes: 128 * 1024,
  recommendation:
    "Remove the key from the repo and rotate it now — a committed key is compromised. Store keys outside the repo (a secret manager, or an untracked gitignored path) and load them at runtime.",
  scan: (ctx) => {
    const lines = ctx.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (PEM_PRIVATE_KEY_RE.test(lines[i]!)) {
        ctx.report({
          line: i + 1,
          message: "A PEM private key is committed to the repository — rotate it now; a committed key is compromised.",
        });
        return;
      }
    }
  },
});
