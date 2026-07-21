/**
 * Shared secret-detection patterns, used by both the AST diagnostic
 * (`no-hardcoded-secret-literal`) and the whole-tree text scan (env/config
 * files). Keeping them in one place means the two surfaces agree on what a
 * secret looks like and share the same false-positive guards.
 */

// Secret-shaped binding/key names (distinct segments to avoid matching "tokenizer").
export const SECRET_NAME_RE =
  /(^|[._-])(secret|password|passwd|pwd|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token|credentials?)([._-]|$)/i;

// Known provider key prefixes anchored to the start of a value — unambiguous.
export const KEY_PREFIX_RE =
  /^(sk_live_|sk_test_|sk-[A-Za-z0-9]|rk_live_|AKIA[0-9A-Z]{4}|ghp_|gho_|github_pat_|xox[baprs]-|AIza[0-9A-Za-z_-]{4}|-----BEGIN )/;

export const PLACEHOLDER_RE =
  /^(changeme|change-me|placeholder|example|dummy|sample|redacted|your[-_.]|<.*>|\{.*\}|x{3,}|\.{3,})/i;

/** A value with enough entropy/shape to plausibly be a real secret. */
export const looksSecretLike = (v: string): boolean =>
  /[0-9]/.test(v) || /[^A-Za-z0-9]/.test(v) || v.length >= 20 || (/[a-z]/.test(v) && /[A-Z]/.test(v));

// Provider-shaped tokens that can appear anywhere in a line of text (with length
// bounds so a short prefix alone doesn't match). Used for whole-file text scans.
export const PROVIDER_KEY_INLINE_RE =
  /(sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20})/;

/** A PEM private-key header — an unambiguous committed-key signal. */
export const PEM_PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/;

/** Strip surrounding quotes and a trailing `# comment` from an env/yaml value. */
export const cleanValue = (raw: string): string => {
  let v = raw.trim();
  // Drop an inline comment only when the value isn't quoted.
  if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, "").trim();
  v = v.replace(/^["']|["']$/g, "").trim();
  return v;
};

/**
 * Decide whether a `name = value` assignment (from source, env, or config) is a
 * committed secret. Returns a short reason, or null when it's safe/placeholder.
 */
export const secretInAssignment = (name: string | null, value: string): string | null => {
  if (value.length < 8) return null;
  if (KEY_PREFIX_RE.test(value) || PROVIDER_KEY_INLINE_RE.test(value)) {
    return "a recognizable provider key";
  }
  if (PLACEHOLDER_RE.test(value)) return null;
  if (!looksSecretLike(value)) return null;
  if (name && SECRET_NAME_RE.test(name)) return `a secret-shaped key (\`${name}\`)`;
  return null;
};
