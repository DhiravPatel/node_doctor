import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import {
  findAncestor,
  findEnclosingFunction,
  getStaticStringValue,
  isUrlOperand,
  namesConcreteHost,
  operandName,
  unwrapChain,
} from "../../core/ast.ts";
import { findDescendant } from "../../core/walk.ts";

/**
 * A host allowlist written as a SUBSTRING test. `startsWith`, `includes` and
 * `endsWith` all answer a question about the text of a URL, and the browser and
 * `fetch` answer a question about its parsed host — so the two disagree, and the
 * attacker picks the gap.
 *
 *   ❌ if (!url.startsWith("https://trusted.com")) throw new Error("bad host");
 *   ❌ if (url.includes("trusted.com")) redirect(url);
 *   ✅ if (new URL(url).hostname !== "trusted.com") throw new Error("bad host");
 *   ✅ const h = new URL(url).hostname;
 *      if (h !== "trusted.com" && !h.endsWith(".trusted.com")) throw …
 *
 * MEASURED with Node's own `URL` parser — the same one `fetch` and every redirect
 * follow — against `ALLOW = "https://trusted.com"`:
 *
 *   url                                       startsWith includes endsWith  real hostname
 *   https://trusted.com/ok                    true       true     false     trusted.com
 *   https://trusted.com.evil.com/steal        TRUE       TRUE     false     trusted.com.evil.com
 *   https://trusted.com@evil.com/steal        TRUE       TRUE     false     evil.com
 *   https://evil.com/?next=https://trusted.com false     TRUE     TRUE      evil.com
 *
 * Every attack passes at least one of the three. `startsWith` falls to the
 * subdomain suffix `trusted.com.evil.com` and, worse, to `trusted.com@evil.com` —
 * where everything before the `@` is USERINFO and the real host is `evil.com`.
 * `includes` falls to anything at all, including a query parameter. `endsWith` on
 * a full URL is answered by the query string.
 *
 * A parsed hostname is safer but not automatically safe. Measured on the
 * hostname alone, against `"trusted.com"`:
 *
 *   hostname               ===     endsWith("trusted.com")  endsWith(".trusted.com")  startsWith
 *   trusted.com            true    true                     false                     true
 *   trusted.com.evil.com   false   false                    false                     TRUE
 *   nottrusted.com         false   TRUE                     false                     false
 *   api.trusted.com        false   true                     true                      false
 *
 * So `hostname.endsWith("trusted.com")` accepts `nottrusted.com`, and
 * `hostname.startsWith("trusted.com")` accepts `trusted.com.evil.com`. Only `===`
 * and a **dot-prefixed** suffix (`.trusted.com`) hold.
 *
 * WHY THIS MATTERS MORE THAN AN ORDINARY GAP. `no-ssrf-unvalidated-url` and
 * `no-open-redirect` both count `startsWith` as evidence that validation exists,
 * and go quiet when they see it. That is correct for their purpose — they ask
 * whether a check is present — but it means a developer who writes the bypassable
 * check gets SILENCE from this analyzer today, which reads as approval. This rule
 * is what makes that silence honest.
 *
 * PRECISION MODEL, and it is narrow, because a substring test on a string is one
 * of the most common operations in any program. All of these must hold:
 *
 *   - The method is `startsWith`, `includes`, `endsWith`, or an `indexOf`
 *     compared against `0` / `-1` — the hand-written spelling of the same test.
 *   - The receiver is named like a URL or a host, using the same vocabulary
 *     `no-unanchored-security-regex` uses, now shared rather than duplicated.
 *   - The argument is a STRING LITERAL naming a concrete host: a real TLD, a
 *     dotted IPv4, or `localhost`. A bare scheme (`url.startsWith("https://")`)
 *     is an "is this absolute?" detector with no trusted host to smuggle past,
 *     and is never reported. Neither is a non-literal argument.
 *   - The call is a BOOLEAN GATE — an `if`/`while`/ternary test, an operand of
 *     `&&`/`||`, under `!`, or returned — rather than a value being computed.
 *   - The branch does not REWRITE the value it just tested.
 *     `if (url.startsWith("git@github.com:")) url = …` is normalization: a
 *     dispatch on which spelling arrived, with no trust decision in it. That
 *     exclusion was not designed in advance — node.doctor's own self-scan
 *     reported its `normalizeRepoUrl`, which rewrites an SSH remote read out of
 *     the project's package.json, and the branch's EFFECT is what separates a
 *     rewrite from an allowlist.
 *
 * And the receiver's shape decides which spellings are wrong, because the two
 * tiers are measured separately: on a raw URL string every one of the four is
 * bypassable, while on a parsed hostname (`new URL(x).hostname`, or a binding
 * initialized from one) only `includes`, `startsWith` and a **dotless**
 * `endsWith` are — a dot-prefixed `endsWith` is the documented correct check and
 * is silent.
 */

/**
 * The substring tests this rule judges. `search`/`match` take a regex and belong
 * to `no-unanchored-security-regex`, which already models anchoring.
 */
const SUBSTRING_METHODS = new Set(["startsWith", "includes", "endsWith", "indexOf"]);

/** Is this expression a parsed hostname — `new URL(x).hostname` / `.host`? */
const isParsedHostExpression = (node: AstNode | null | undefined): boolean => {
  const n = unwrapChain(node);
  if (!n || n.type !== "MemberExpression" || n.computed) return false;
  const property = n.property as AstNode | undefined;
  if (property?.type !== "Identifier") return false;
  if (String(property.name) !== "hostname" && String(property.name) !== "host") return false;
  const object = unwrapChain(n.object as AstNode);
  if (object?.type === "NewExpression") {
    const callee = object.callee as AstNode | undefined;
    return callee?.type === "Identifier" && String(callee.name) === "URL";
  }
  return false;
};

/**
 * Does the receiver hold a PARSED hostname? Either written inline, or a binding
 * initialized from one in the same scope — `const host = new URL(u).hostname`.
 */
const receiverIsParsedHost = (receiver: AstNode, scope: AstNode): boolean => {
  if (isParsedHostExpression(receiver)) return true;
  const name = unwrapChain(receiver);
  if (!name || name.type !== "Identifier") return false;
  const binding = String(name.name);
  return (
    findDescendant(scope, (n) => {
      if (n.type !== "VariableDeclarator") return false;
      const id = n.id as AstNode | undefined;
      return id?.type === "Identifier" && String(id.name) === binding && isParsedHostExpression(n.init as AstNode);
    }) !== null
  );
};

/** Is this call used as a boolean gate rather than as a computed value? */
const isBooleanGate = (node: AstNode): boolean => {
  let current: AstNode = node;
  let parent = node.parent as AstNode | undefined;
  while (parent) {
    switch (parent.type) {
      case "UnaryExpression":
        if (parent.operator !== "!") return false;
        current = parent;
        parent = parent.parent as AstNode | undefined;
        continue;
      case "LogicalExpression":
        return true;
      case "BinaryExpression": {
        // `indexOf(…) === 0` / `!== -1` is the hand-written spelling.
        const operator = String(parent.operator);
        if (operator !== "===" && operator !== "!==" && operator !== "==" && operator !== "!=") return false;
        current = parent;
        parent = parent.parent as AstNode | undefined;
        continue;
      }
      case "IfStatement":
      case "WhileStatement":
      case "DoWhileStatement":
      case "ConditionalExpression":
        return parent.test === current;
      case "ReturnStatement":
      case "ArrowFunctionExpression":
        return true;
      default:
        return false;
    }
  }
  return false;
};

/**
 * Is the enclosing branch REWRITING the value it just tested, rather than
 * admitting or refusing it? `if (url.startsWith("git@github.com:")) url = …` is
 * normalization — a dispatch on which spelling arrived, with no trust decision in
 * it and no attacker to smuggle anything past.
 *
 * This exclusion was not designed in advance. node.doctor's self-scan reported
 * its own `normalizeRepoUrl`, which rewrites an SSH remote read out of the
 * project's own package.json — a false positive, and the shape a gate check alone
 * cannot tell from an allowlist. The branch's EFFECT is what separates them.
 */
const isNormalizingBranch = (node: AstNode, receiver: AstNode): boolean => {
  const root = unwrapChain(receiver);
  if (!root || root.type !== "Identifier") return false;
  const name = String(root.name);
  const branch = findAncestor(node, (n) => n.type === "IfStatement" || n.type === "ConditionalExpression");
  if (!branch) return false;
  return (
    findDescendant(branch, (n) => {
      if (n.type !== "AssignmentExpression") return false;
      const left = unwrapChain(n.left as AstNode);
      return left?.type === "Identifier" && String(left.name) === name;
    }) !== null
  );
};

/** `indexOf` only counts when compared with 0 or -1; the others always count. */
const indexOfIsGate = (node: AstNode): boolean => {
  const parent = node.parent as AstNode | undefined;
  if (parent?.type !== "BinaryExpression") return false;
  const other = (parent.left === node ? parent.right : parent.left) as AstNode | undefined;
  if (other?.type === "Literal" && other.value === 0) return true;
  return (
    other?.type === "UnaryExpression" &&
    other.operator === "-" &&
    (other.argument as AstNode | undefined)?.type === "Literal" &&
    ((other.argument as AstNode).value as unknown) === 1
  );
};

export const noSubstringHostCheck = defineDiagnostic({
  id: "no-substring-host-check",
  title: "Host allowlist written as a substring test, which the parsed URL disagrees with",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["injection", "ssrf", "redirect", "owasp:a01"],
  recommendation:
    'Parse it and compare the host: `const h = new URL(url).hostname; if (h !== "trusted.com" && !h.endsWith(".trusted.com")) throw …`. Measured with Node\'s own URL parser, `"https://trusted.com.evil.com/steal".startsWith("https://trusted.com")` is **true** and so is `"https://trusted.com@evil.com/steal"` — where everything before the `@` is userinfo and the real host is `evil.com`. `includes` falls to a query parameter. On a parsed hostname, a dotless `endsWith("trusted.com")` still accepts `nottrusted.com`, so the leading dot is not optional.',
  create: (ctx) => ({
    CallExpression: (node) => {
      const callee = node.callee as AstNode | undefined;
      if (callee?.type !== "MemberExpression" || callee.computed) return;
      const property = callee.property as AstNode | undefined;
      if (property?.type !== "Identifier") return;
      const method = String(property.name);
      if (!SUBSTRING_METHODS.has(method)) return;

      const receiver = callee.object as AstNode | undefined;
      if (!receiver) return;

      // The argument must name a concrete host, written out.
      const argument = ((node.arguments as AstNode[] | undefined) ?? [])[0];
      const literal = getStaticStringValue(argument);
      if (literal === null || !namesConcreteHost(literal)) return;

      // The receiver must be the URL or host an allowlist guards.
      const name = operandName(receiver);
      const parsedHost = receiverIsParsedHost(receiver, findEnclosingFunction(node) ?? ctx.program);
      if (!parsedHost && !isUrlOperand(name)) return;

      if (method === "indexOf" ? !indexOfIsGate(node) : !isBooleanGate(node)) return;
      // A branch that rewrites the tested value is normalization, not admission.
      if (isNormalizingBranch(node, receiver)) return;

      if (parsedHost) {
        // Measured: on a hostname, only `===` and a DOT-PREFIXED suffix hold.
        if (method === "endsWith" && literal.startsWith(".")) return;
        if (method === "indexOf") return; // an index into a hostname is not a gate we model
        const bypass =
          method === "endsWith"
            ? `\`nottrusted.com\` ends with \`${literal}\` too`
            : `\`${literal}.evil.com\` starts with \`${literal}\` too`;
        ctx.report(
          node,
          `This gates on a **substring of a hostname**, and ${bypass} — measured, \`"nottrusted.com".endsWith("trusted.com")\` is \`true\` and \`"trusted.com.evil.com".startsWith("trusted.com")\` is \`true\`. Compare the hostname exactly (\`=== "${literal}"\`), and for subdomains use a **dot-prefixed** suffix (\`.endsWith(".${literal.replace(/^\./, "")}")\`) — the leading dot is what makes it a boundary rather than a substring.`,
        );
        return;
      }

      ctx.report(
        node,
        `This gates on a **substring of the URL text**, while \`fetch\` and every redirect act on its PARSED host — so the two disagree and the attacker picks the gap. Measured with Node's own URL parser: \`"https://trusted.com.evil.com/steal".startsWith("https://trusted.com")\` is **true**, and so is \`"https://trusted.com@evil.com/steal"\`, where everything before the \`@\` is USERINFO and the real hostname is \`evil.com\`. \`includes\` falls to a query parameter (\`https://evil.com/?next=https://trusted.com\`), and \`endsWith\` on a full URL is answered by the query string. Parse it instead: \`const h = new URL(url).hostname; if (h !== "…" && !h.endsWith(".…")) throw\`. Note that \`no-ssrf-unvalidated-url\` and \`no-open-redirect\` count this call as validation and stay quiet — this finding is what makes that silence honest.`,
      );
    },
  }),
});
