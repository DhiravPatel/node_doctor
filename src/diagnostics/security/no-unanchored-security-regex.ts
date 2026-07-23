import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode, Visitors, DiagnosticContext } from "../../core/types.ts";
import { getMethodName, unwrapChain } from "../../core/ast.ts";

/**
 * A regex with NO leading `^` anchor, used as a boolean allow/deny gate on a URL
 * or host, is an auth/redirect/SSRF bypass. Without `^` the pattern matches
 * ANYWHERE in the input, so a host allowlist written as
 * `/https:\/\/trusted\.com/.test(url)` also accepts
 * `https://evil.com/?x=https://trusted.com` — the attacker's host is the real
 * destination and `trusted.com` is just a query-string decoration the regex
 * happily finds. The missing `^` is the exact defect: the check believes it
 * pinned the start of the string when it did not.
 *
 * WHY THIS IS SO NARROW (precision-first; a false positive here is a release
 * blocker). A domain literal in a `.test()`/`.exec()`/`.match()` is, by itself, a
 * terrible signal: real code is full of *detection* and *extraction* that is not a
 * security decision — `/github\.com[:/]/.test(remote)` picking a CI provider,
 * `dockerfile.match(/https:\/\/github\.com\/(…)/)` pulling out a repo path. To
 * separate an auth GATE from detection we require all of:
 *   - a boolean gate: receiver of `.test()`/`.exec()`, or the argument of a
 *     non-global `.match()`;
 *   - the tested operand is named like a URL or host (`url`, `redirectUrl`,
 *     `origin`, `host`, `referer`, `href`, `domain`, …) — the thing an allowlist
 *     actually guards — and is NOT the current page's own `window.location`
 *     (self/environment detection, not untrusted-input validation);
 *   - the pattern names a CONCRETE host: a domain with a real TLD (`trusted\.com`),
 *     `localhost`, or a dotted IPv4. A bare `://` scheme is NOT enough —
 *     `/https?:\/\//` is an "is this absolute?" detector with no host to bypass;
 *   - the pattern is NOT start-anchored — no `^` (allowing for a wrapping group,
 *     `(?:^|…)` / `(^…)`).
 *   The regex may be inline (`/…/​.test(url)`) or a `const` the scope resolver
 *   follows back to a literal.
 *
 * DELIBERATE SILENCE (recall deliberately traded for precision):
 *   - Any start-anchored regex, including a legitimate prefix check
 *     `/^https?:\/\//.test(href)` ("is this absolute?") and a fully-anchored
 *     allowlist `/^https:\/\/trusted\.com$/`. A start anchor means the author
 *     pinned the start deliberately; we do not second-guess a missing END anchor,
 *     which is a much weaker and far noisier signal.
 *   - Extraction / tokenization / replacement (`str.replace(...)`, a global
 *     `text.match(/…/g)` collecting occurrences) — not a boolean decision.
 *   - Any operand not named like a URL/host, and any pattern with no URL/host
 *     content (`/^\d{4}$/`, `/[a-z]+/`) — too weak to be an `error`.
 *   - `new RegExp(dynamic, …)` — not a literal, so anchoring is unprovable.
 *
 * ❌ if (/https:\/\/trusted\.com/.test(redirectUrl)) location = redirectUrl;
 * ❌ const OK = /internal\.corp/; if (OK.test(host)) grantAccess();
 * ✅ if (/^https:\/\/trusted\.com$/.test(redirectUrl)) location = redirectUrl;
 * ✅ if (new URL(redirectUrl).host === "trusted.com") location = redirectUrl;
 */

// A domain with a real TLD / internal suffix. A concrete host is what an
// allowlist enumerates; a leftover word like `file.txt` (txt is not here) is not.
// Inside a regex literal the dot is usually escaped (`trusted\.com`).
const HOST_TLD =
  /[a-z0-9_-]\\?\.(com|net|org|io|dev|app|gov|edu|co|us|uk|de|fr|jp|cn|ru|info|biz|me|tv|cc|ly|ai|xyz|internal|local|intranet|corp|example|test|invalid)\b/i;

// A dotted IPv4 (loopback/link-local/private are the usual SSRF targets, but any
// literal IP written into a URL gate is an allowlist entry). In a regex literal
// the dots are usually escaped (`127\.0\.0\.1`).
const IPV4 = /\d{1,3}\\?\.\d{1,3}\\?\.\d{1,3}\\?\.\d{1,3}/;

/**
 * Does the pattern name a CONCRETE host — the thing an allowlist enumerates? A
 * real TLD (`trusted\.com`), a dotted IPv4, or `localhost`. A bare `://` scheme is
 * deliberately NOT enough: `/https?:\/\//` is an "is this an absolute URL?"
 * detector, not a host allowlist — it has no trusted host to smuggle past, so an
 * unanchored scheme check is not the redirect/SSRF bypass this rule is about
 * (`isAbsolute = url.match(/https?:\/\//)` pervades routing/serialization code).
 * Requiring a concrete host is what keeps this an `error`-worthy signal.
 */
const hasUrlHostContent = (pattern: string): boolean =>
  HOST_TLD.test(pattern) || IPV4.test(pattern) || /localhost/i.test(pattern);

// Substrings that mark the tested string as a URL / host — the value an allowlist
// guards. Kept deliberately narrow (no `path`/`role`/`route`, which pervade
// non-security detection) so this stays an `error`-worthy signal.
const URL_OPERAND_HINTS = [
  "url",
  "uri",
  "redirect",
  "origin",
  "host",
  "referer",
  "referrer",
  "href",
  "location",
  "domain",
  "endpoint",
  "callback",
  "returnto",
  "returnurl",
  "destination",
];

/** A RegExp literal node (`/…/flags`), or null. */
const regexLiteral = (node: AstNode | null | undefined): AstNode | null => {
  const n = unwrapChain(node);
  if (n && n.type === "Literal" && n.regex && typeof n.regex.pattern === "string") return n;
  return null;
};

/**
 * The regex a call site tests against: a direct literal, or an identifier the
 * scope resolver follows back to a `const re = /…/` initializer. We only trust a
 * binding whose initializer *is* a regex literal — never a `new RegExp(...)`,
 * whose value we cannot prove.
 */
const resolveRegex = (node: AstNode | null | undefined, ctx: DiagnosticContext): AstNode | null => {
  const direct = regexLiteral(node);
  if (direct) return direct;
  const n = unwrapChain(node);
  if (n && n.type === "Identifier") {
    const binding = ctx.scope.getBinding(n.name, n);
    if (binding && (binding.kind === "const" || binding.kind === "let" || binding.kind === "var")) {
      return regexLiteral(binding.initNode);
    }
  }
  return null;
};

/**
 * Is the pattern pinned to the start of the input? A literal `^`, allowing for a
 * wrapping group the author used to anchor (`(^…)`, `(?:^|/)…`). We err toward
 * "anchored" (silent): a start anchor is a deliberate act, and treating an
 * ambiguous prefix as anchored costs recall, never precision.
 */
const START_ANCHOR = /^\(*(?:\?:)?\^/;
const isStartAnchored = (pattern: string): boolean => START_ANCHOR.test(pattern);

/** The lowercased name of the tested operand (identifier or `x.prop`), or "". */
const operandName = (node: AstNode | null | undefined): string => {
  const n = unwrapChain(node);
  if (!n) return "";
  if (n.type === "Identifier") return n.name.toLowerCase();
  if (n.type === "MemberExpression" && !n.computed && n.property?.type === "Identifier") {
    return n.property.name.toLowerCase();
  }
  return "";
};

const isUrlOperand = (name: string): boolean =>
  name.length > 0 && URL_OPERAND_HINTS.some((h) => name.includes(h));

/**
 * Is the operand the CURRENT page's own location (`location.hostname`,
 * `window.location.href`, `document.location…`)? That is environment / self
 * detection — "am I running on host X?" — not validation of an untrusted input the
 * user is about to be redirected to or granted access from. The redirect/SSRF
 * bypass this rule targets is about an UNTRUSTED destination (`redirectUrl`,
 * `returnTo`, a request `referer`/`host`), never `window.location`, which the
 * browser controls. Matching an unanchored regex against your own location is a
 * common, benign feature-flag pattern, so it stays silent.
 */
const isSelfLocationOperand = (node: AstNode | null | undefined): boolean => {
  let n = unwrapChain(node);
  // Peel the trailing property (`location.hostname` → object `location`).
  if (n && n.type === "MemberExpression" && !n.computed) n = unwrapChain(n.object);
  while (n && n.type === "MemberExpression" && !n.computed) {
    if (n.property?.type === "Identifier" && n.property.name === "location") return true;
    n = unwrapChain(n.object);
  }
  return n?.type === "Identifier" && n.name === "location";
};

/**
 * Is this call's array result consumed as a BOOLEAN — an allow/deny decision —
 * rather than as data? `.exec()`/`.match()` return `RegExpMatchArray | null`, so
 * `const host = url.match(/…\/([^/]+)/)[1]` is EXTRACTION (pulling the host out),
 * not a gate, and must stay silent. It is a gate only when the result flows into a
 * boolean position: an `if`/`while`/`for`/ternary test, a `!`, or a `&&`/`||` that
 * itself lands in one. We climb through the optional-chaining and logical wrappers
 * that preserve that boolean role, and stop (not-a-gate) at anything that consumes
 * the value — assignment, `.prop`/`[i]` access, destructuring, `return`, a call arg.
 * `.test()` already returns a boolean, so it never needs this check.
 */
const isBooleanGate = (call: AstNode): boolean => {
  let cur: AstNode = call;
  let parent: AstNode | null | undefined = call.parent;
  while (parent) {
    switch (parent.type) {
      case "ChainExpression":
      case "LogicalExpression":
        // Value-preserving in a boolean role — climb to see where it lands.
        cur = parent;
        parent = parent.parent;
        continue;
      case "UnaryExpression":
        return parent.operator === "!";
      case "IfStatement":
      case "WhileStatement":
      case "DoWhileStatement":
      case "ForStatement":
      case "ConditionalExpression":
        return parent.test === cur;
      default:
        return false;
    }
  }
  return false;
};

export const noUnanchoredSecurityRegex = defineDiagnostic({
  id: "no-unanchored-security-regex",
  title: "Unanchored regex used in a URL/host security decision (auth/redirect bypass)",
  severity: "error",
  category: "Security",
  scope: "file",
  tags: ["injection", "auth"],
  defaultEnabled: true,
  confidence: "high",
  recommendation:
    "Anchor the pattern at the start (`/^https:\\/\\/trusted\\.com$/`) so it matches the whole input, not a substring — or, better, parse the value (`new URL(target).host`) and compare the host against an explicit allowlist instead of matching a regex.",
  create: (ctx): Visitors => ({
    CallExpression: (node) => {
      const method = getMethodName(node);
      if (method !== "test" && method !== "exec" && method !== "match") return;

      const callee = unwrapChain(node.callee);
      if (!callee || callee.type !== "MemberExpression") return;
      const args = (node.arguments as AstNode[]) ?? [];

      // `.exec()`/`.match()` return an array|null, so they are a security GATE only
      // when the result is consumed as a boolean — otherwise they are extraction
      // (`const host = url.match(/…\/([^/]+)/)[1]`), which is not a decision at all.
      // `.test()` already yields a boolean and needs no such check.
      if (method !== "test" && !isBooleanGate(node)) return;

      let regexNode: AstNode | null;
      let operandNode: AstNode | null | undefined;
      if (method === "match") {
        // `str.match(re)` — the regex is the argument, the receiver is the string.
        // A global `.match()` returns every occurrence: extraction, not a gate.
        regexNode = resolveRegex(args[0], ctx);
        operandNode = callee.object;
        if (regexNode && typeof regexNode.regex?.flags === "string" && regexNode.regex.flags.includes("g")) {
          return;
        }
      } else {
        // `re.test(str)` / `re.exec(str)` — the regex is the receiver.
        regexNode = resolveRegex(callee.object, ctx);
        operandNode = args[0];
      }
      if (!regexNode) return;

      const pattern = regexNode.regex.pattern as string;
      // Start-anchored → the author pinned the start deliberately; not our bug.
      if (isStartAnchored(pattern)) return;
      // The operand must be a URL/host — the value an allowlist guards.
      if (!isUrlOperand(operandName(operandNode))) return;
      // …but not the current page's own `window.location` — that is self/environment
      // detection, not validation of an untrusted redirect/request value.
      if (isSelfLocationOperand(operandNode)) return;
      // The pattern must carry URL/host content — otherwise it is not an allowlist.
      if (!hasUrlHostContent(pattern)) return;

      ctx.report(
        node,
        `Unanchored regex \`/${pattern}/\` used as a URL/host allow-or-deny check — with no \`^\` anchor it matches anywhere in the input, so an attacker's value passes (e.g. \`https://evil.com/?x=https://trusted.com\`). Anchor it at the start (\`/^…/\`) or compare a parsed \`new URL(...).host\` against an allowlist.`,
      );
    },
  }),
});
