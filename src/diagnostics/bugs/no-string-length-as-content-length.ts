import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getStaticStringValue, staticMemberPath } from "../../core/ast.ts";

/**
 * §202 — `Content-Length` measured in characters instead of bytes.
 *
 * `String.prototype.length` counts UTF-16 code units. `Content-Length` is a
 * count of **bytes on the wire**. For ASCII they agree, which is why this
 * survives every test written in English:
 *
 *   ❌ res.setHeader("Content-Length", body.length);
 *      body = '{"name":"café ☕"}'  →  header says 17, the body is 20 bytes
 *   ✅ res.setHeader("Content-Length", Buffer.byteLength(body));
 *
 * When the two disagree the header is always too SMALL, because every
 * non-ASCII character encodes to more than one byte. The client reads exactly
 * as many bytes as it was promised and stops — so the JSON is truncated
 * mid-string and fails to parse, or, on a keep-alive connection, the leftover
 * bytes are read as the start of the NEXT response and the connection
 * desynchronises. An emoji in a user's display name is enough.
 *
 * PRECISION MODEL. The claim is "this value is a character count, not a byte
 * count", so the operand has to be provably a STRING:
 *
 *   - A LITERAL is decided by arithmetic, not by shape: the two counts are
 *     computed and compared, so `"OK".length` and a hex or base64 body — every
 *     byte of which is ASCII — are correct code and stay silent. Only a literal
 *     that really does encode to more bytes than it has characters is reported.
 *   - `JSON.stringify(…)`, a template literal WITH substitutions, and a `+`
 *     concatenation are reported: each is a byte count that depends on data the
 *     file does not contain, and one non-ASCII character in it truncates the
 *     response.
 *   - Everything decided by a METHOD NAME was removed after the hunt.
 *     `String(n)`, `toString()`, `Date#toISOString()`, `join()` on numbers — all
 *     produce ASCII, so `.length` is the byte count and the code is right.
 *     Distinguishing them from a non-ASCII case needs the value, not the name.
 *   - A bare identifier is NOT judged. `body` could just as easily be a Buffer,
 *     whose `.length` IS the byte count and is correct.
 *   - Only `setHeader` and `writeHead`, which are unambiguously HTTP. `set` and
 *     `header` were removed: a `Map` of column widths keyed by a header name,
 *     and a report builder's `.header(name, width)`, are not responses.
 *   - `Buffer.byteLength(…)` is the fix and is never matched, because the
 *     operand is a call rather than a `.length` read.
 */

/** The header, however it is cased on the wire. */
const isContentLength = (name: string | null): boolean => name !== null && name.toLowerCase() === "content-length";

/**
 * Is this a string whose `.length` is provably NOT its byte count?
 *
 * For a constant the question is arithmetic — compute both and compare. For a
 * value the file does not contain, the answer is "it depends on the data", and
 * that is exactly the latent bug worth reporting: the header is right in every
 * ASCII test and wrong the first time a user types an accent.
 */
const measuresWrong = (node: AstNode | null | undefined): boolean => {
  if (!node) return false;

  // A constant: decide it by counting, not by shape.
  if (node.type === "Literal") {
    return typeof node.value === "string" && Buffer.byteLength(node.value as string) !== (node.value as string).length;
  }
  if (node.type === "TemplateLiteral") {
    const expressions = (node.expressions as AstNode[] | undefined) ?? [];
    const quasis = (node.quasis as AstNode[] | undefined) ?? [];
    const constantText = quasis.map((q) => ((q.value as { cooked?: string } | undefined)?.cooked ?? "")).join("");
    // With substitutions the total depends on runtime data; without, it is a
    // constant and gets the same arithmetic as a plain literal.
    if (expressions.length > 0) return true;
    return Buffer.byteLength(constantText) !== constantText.length;
  }

  // `JSON.stringify(x)` serialises data the file does not contain.
  if (node.type === "CallExpression") {
    const callee = node.callee as AstNode | undefined;
    return callee?.type === "MemberExpression" && staticMemberPath(callee) === "JSON.stringify";
  }

  // `"prefix" + body` — the byte count depends on `body`.
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return measuresWrong(node.left as AstNode) || measuresWrong(node.right as AstNode);
  }
  return false;
};

/** Is `node` a `.length` read whose subject is measured in the wrong unit? */
const stringLengthRead = (node: AstNode | null | undefined): AstNode | null => {
  if (!node || node.type !== "MemberExpression" || node.computed) return null;
  if ((node.property as AstNode | undefined)?.name !== "length") return null;
  const object = node.object as AstNode | undefined;
  return measuresWrong(object) ? (object as AstNode) : null;
};

export const noStringLengthAsContentLength = defineDiagnostic({
  id: "no-string-length-as-content-length",
  title: "Content-Length set from a character count, not a byte count",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  tags: ["correctness", "http", "encoding"],
  recommendation:
    "Use `Buffer.byteLength(body)`. `String.prototype.length` counts UTF-16 code units, and `Content-Length` counts bytes — the two agree only for ASCII, and when they disagree the header is too small, so the client truncates the body or desynchronises a keep-alive connection.",
  create: (ctx) => {
    const report = (valueNode: AstNode, subject: AstNode): void => {
      const shape =
        subject.type === "CallExpression" || subject.type === "TemplateLiteral" || subject.type === "BinaryExpression"
          ? "this string"
          : "the string";
      ctx.report(
        valueNode,
        `\`Content-Length\` is set from \`.length\` of ${shape}, which counts UTF-16 code units rather than bytes. They agree only for ASCII; one non-ASCII character makes the header too small, and the client stops reading mid-body — truncating the response, or desynchronising a keep-alive connection so the leftover bytes are parsed as the next one. Use \`Buffer.byteLength(…)\`.`,
      );
    };

    return {
      CallExpression: (node) => {
        const method = getMethodName(node);
        const args = (node.arguments as AstNode[] | undefined) ?? [];

        // `res.setHeader("Content-Length", body.length)`
        if (method === "setHeader") {
          if (!isContentLength(getStaticStringValue(args[0]))) return;
          const subject = stringLengthRead(args[1]);
          if (subject && args[1]) report(args[1], subject);
          return;
        }

        // `res.writeHead(200, { "Content-Length": body.length })`
        if (method !== "writeHead") return;
        for (const arg of args) {
          if (arg.type !== "ObjectExpression") continue;
          for (const prop of (arg.properties as AstNode[] | undefined) ?? []) {
            if (prop.type !== "Property") continue;
            const key = prop.key as AstNode | undefined;
            const name =
              key?.type === "Identifier" && !prop.computed ? (key.name as string) : getStaticStringValue(key);
            if (!isContentLength(name)) continue;
            const value = prop.value as AstNode | undefined;
            const subject = stringLengthRead(value);
            if (subject && value) report(value, subject);
          }
        }
      },
    };
  },
});
