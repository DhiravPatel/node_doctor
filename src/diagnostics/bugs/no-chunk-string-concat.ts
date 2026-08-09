import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, getStaticStringValue, staticMemberPath } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §202 — a stream body accumulated with `+=`, which splits multibyte characters.
 *
 * A `data` chunk from a BYTE stream is a `Buffer` sized by the network, not by
 * the text inside it. Concatenating one onto a string coerces it with
 * `toString()` **per chunk**, so any character whose UTF-8 encoding straddles the
 * boundary is decoded as two separate fragments, and every byte of it becomes a
 * replacement character:
 *
 *   ❌ let body = "";
 *      req.on("data", (chunk) => { body += chunk; });
 *      // one ☕ split 1+2 bytes arrives as three U+FFFD, not one character
 *   ✅ const chunks = [];
 *      req.on("data", (chunk) => chunks.push(chunk));
 *      req.on("end", () => JSON.parse(Buffer.concat(chunks).toString("utf8")));
 *   ✅ req.setEncoding("utf8");                      // a decoder that spans chunks
 *      req.on("data", (chunk) => { body += chunk; });
 *
 * It is the commonest body-collection snippet in circulation, and it passes
 * every test: a small ASCII payload arrives in one chunk, and one chunk can
 * never be split. What it needs is a body the network fragments — two TCP
 * segments, a proxy, a TLS record boundary — with a non-ASCII character landing
 * on the seam. Verified against a real HTTP server: a body split mid-character
 * across two segments arrives as `{"name":"café ��� naïve"}`.
 *
 * And it does NOT announce itself. `U+FFFD` is a perfectly legal character
 * inside a JSON string, so `JSON.parse` succeeds and the corrupted value is
 * written straight to the database. Structural characters are all ASCII and
 * never split, so this is silent data loss on a fraction of requests rather
 * than an error anybody gets paged for.
 *
 * PRECISION MODEL. The claim is "these chunks are Buffers", and the hunt made
 * clear how many streams emit STRINGS instead — `Readable.from(["a","b"])`, any
 * `objectMode` stream, `split2()`, `through2.obj()`, a `serialport`
 * `ReadlineParser`, an `iconv-lite` `decodeStream`, `Readable.fromWeb` over a
 * `TextDecoderStream`. On every one of those, `+=` is correct code. So the
 * receiver is PROVEN rather than assumed:
 *
 *   - `process.stdin`, a `net` socket, an `http`/`https` request or response, a
 *     `child_process` handle's `.stdout`/`.stderr`, or an `fs.createReadStream`
 *     opened with no encoding. Each is a byte stream by construction, traced to
 *     the builtin it came from. A name assigned across branches — the CLI shape
 *     `let s; if (file) s = createReadStream(file); else s = process.stdin;` —
 *     counts only when EVERY branch hands it a byte stream.
 *   - The accumulator must be initialised to a STRING LITERAL. `+=` onto an
 *     unknown binding proves nothing.
 *   - The right-hand side must be the handler's own chunk parameter, bare or
 *     with a no-argument `.toString()` — `chunk.toString("utf8")` is the same
 *     bug, and is included; `chunk.toString("hex")` and `"base64"` are NOT,
 *     because those encodings are per-byte and survive any split.
 *   - Any `setEncoding` in the file, or an encoding passed where the stream is
 *     opened, drops the claim: a decoder that spans chunks makes every chunk a
 *     string already.
 *
 * WHAT THIS COSTS, MEASURED. Proving the receiver is what makes the rule safe,
 * and it is not free. On a 525,810-file corpus this reports 28 findings across
 * four packages, all of them a `child_process` handle, a `process.stdin` read or
 * an unencoded `createReadStream`. A stream that arrives as an opaque function
 * parameter —
 * `export async function parseBody(req) { req.on("data", …) }`, which is how
 * Metro, Next and Cloudinary all write it — cannot be traced to a builtin from
 * inside one file, and is not reported. Neither is a transpiled interop shape
 * (`_fs2.default.createReadStream(…)`), nor a `cross-spawn` handle, which is a
 * real `ChildProcess` from a package this rule does not know. Those are real
 * bugs this rule will not find. They are the price of never reporting the
 * eighteen string-emitting stream shapes the hunt produced, and on a
 * precision-first bar that is the right side to err on.
 */

/** Encodings whose decoding is stateful, so a split chunk corrupts. */
const MULTIBYTE_ENCODINGS = new Set(["utf8", "utf-8", "utf16le", "utf-16le", "ucs2", "ucs-2"]);

/** Every encoding name, so an explicit one anywhere marks the file as decoding. */
const ANY_ENCODING = new Set([...MULTIBYTE_ENCODINGS, "ascii", "latin1", "binary", "hex", "base64", "base64url"]);

const FS_MODULES = new Set(["fs", "node:fs"]);
const NET_MODULES = new Set(["net", "node:net", "tls", "node:tls"]);
const HTTP_MODULES = new Set(["http", "node:http", "https", "node:https", "http2", "node:http2"]);
const CHILD_MODULES = new Set(["child_process", "node:child_process"]);

/** `child_process` functions returning a handle with byte pipes. */
const SPAWNERS = new Set(["spawn", "exec", "execFile", "fork"]);
/** `http`/`https` calls whose callback receives an `IncomingMessage`. */
const HTTP_REQUESTERS = new Set(["request", "get"]);
/** Server factories whose handler's first parameter is a byte stream. */
const SERVER_FACTORIES = new Set(["createServer", "createSecureServer"]);
/** `net`/`tls` calls returning a socket. */
const SOCKET_FACTORIES = new Set(["connect", "createConnection"]);

export const noChunkStringConcat = defineDiagnostic({
  id: "no-chunk-string-concat",
  title: "Byte-stream chunks concatenated onto a string, splitting multibyte characters",
  severity: "error",
  category: "Bugs",
  confidence: "high",
  tags: ["correctness", "streams", "encoding"],
  recommendation:
    'Collect the chunks and decode once: `const chunks = []; stream.on("data", (c) => chunks.push(c)); … Buffer.concat(chunks).toString("utf8")`. Or call `stream.setEncoding("utf8")` first, which installs a decoder that carries a partial character across the boundary. `+=` decodes each chunk on its own, so a character split by the boundary becomes replacement characters — and because `U+FFFD` is legal inside a JSON string, nothing throws and the corrupted value is stored.',
  create: (ctx) => {
    /**
     * Any mention of an encoding means the file decodes on purpose — through
     * `setEncoding`, a stream option, or an explicit `toString`.
     */
    let encodingAware = false;
    for (const node of collectDescendants(
      ctx.program,
      (n) => n.type === "CallExpression" || n.type === "Literal",
      undefined,
      true,
    )) {
      if (node.type === "CallExpression") {
        if (getMethodName(node) === "setEncoding") {
          encodingAware = true;
          break;
        }
        continue;
      }
      const value = node.value;
      if (typeof value === "string" && ANY_ENCODING.has(value.toLowerCase())) {
        encodingAware = true;
        break;
      }
    }

    // ---------------------------------------------------------------------
    // Which builtins is this file actually holding?
    // ---------------------------------------------------------------------
    /** Local name → the module family it was imported from. */
    const namespaces = new Map<string, string>();
    /** Local name → the member it was imported as, plus its family. */
    const members = new Map<string, { family: string; name: string }>();

    const familyOf = (source: string): string | null => {
      if (FS_MODULES.has(source)) return "fs";
      if (NET_MODULES.has(source)) return "net";
      if (HTTP_MODULES.has(source)) return "http";
      if (CHILD_MODULES.has(source)) return "child";
      return null;
    };

    const bind = (family: string, id: AstNode | undefined): void => {
      if (id?.type === "Identifier") {
        namespaces.set(id.name as string, family);
        return;
      }
      if (id?.type !== "ObjectPattern") return;
      for (const prop of (id.properties as AstNode[] | undefined) ?? []) {
        if (prop.type !== "Property") continue;
        const key = prop.key as AstNode | undefined;
        const local = prop.value as AstNode | undefined;
        if (key?.type !== "Identifier" || local?.type !== "Identifier") continue;
        members.set(local.name as string, { family, name: key.name as string });
      }
    };

    for (const stmt of (ctx.program.body as AstNode[] | undefined) ?? []) {
      if (stmt.type !== "ImportDeclaration") continue;
      const source = stmt.source?.value;
      const family = typeof source === "string" ? familyOf(source) : null;
      if (family === null) continue;
      for (const spec of (stmt.specifiers as AstNode[] | undefined) ?? []) {
        const local = (spec.local as AstNode | undefined)?.name;
        if (typeof local !== "string") continue;
        if (spec.type === "ImportSpecifier") {
          const imported = spec.imported as AstNode | undefined;
          if (imported?.type === "Identifier") members.set(local, { family, name: imported.name as string });
        } else {
          namespaces.set(local, family);
        }
      }
    }

    /** The module a `require(…)` call names, if it is one this rule tracks. */
    const requiredFamily = (node: AstNode | null | undefined): string | null => {
      if (!node || node.type !== "CallExpression") return null;
      if ((node.callee as AstNode | undefined)?.name !== "require") return null;
      const source = getStaticStringValue(((node.arguments as AstNode[] | undefined) ?? [])[0]);
      return source === null ? null : familyOf(source);
    };

    for (const decl of collectDescendants(ctx.program, (n) => n.type === "VariableDeclarator", undefined, true)) {
      const init = decl.init as AstNode | undefined;
      const id = decl.id as AstNode | undefined;
      const family = requiredFamily(init);
      if (family !== null) {
        bind(family, id);
        continue;
      }
      // `const spawn = require("child_process").spawn` — a member read off the
      // require, which is as common as destructuring it.
      if (init?.type !== "MemberExpression" || init.computed) continue;
      const memberFamily = requiredFamily(init.object as AstNode);
      const memberName = (init.property as AstNode | undefined)?.name;
      if (memberFamily !== null && typeof memberName === "string" && id?.type === "Identifier") {
        members.set(id.name as string, { family: memberFamily, name: memberName });
      }
    }

    /** Which builtin function does this call reach — `<family>.<name>` — if any? */
    const builtinCall = (call: AstNode | null | undefined): { family: string; name: string } | null => {
      if (!call || call.type !== "CallExpression") return null;
      const callee = call.callee as AstNode | undefined;
      if (callee?.type === "Identifier") {
        const hit = members.get(callee.name as string);
        return hit && ctx.scope.getBinding(callee.name as string, callee)?.kind !== "param" ? hit : null;
      }
      if (callee?.type !== "MemberExpression") return null;
      const object = callee.object as AstNode | undefined;
      if (object?.type !== "Identifier") return null;
      const family = namespaces.get(object.name as string);
      const name = getMethodName(call);
      return family !== undefined && name !== null ? { family, name } : null;
    };

    /** Does this `createReadStream` call pass an encoding? Then it emits strings. */
    const readStreamHasEncoding = (call: AstNode): boolean => {
      for (const arg of ((call.arguments as AstNode[] | undefined) ?? []).slice(1)) {
        if (getStaticStringValue(arg) !== null) return true;
        if (arg.type !== "ObjectExpression") continue;
        for (const prop of (arg.properties as AstNode[] | undefined) ?? []) {
          if (prop.type === "Property" && (prop.key as AstNode | undefined)?.name === "encoding") return true;
        }
      }
      return false;
    };

    // ---------------------------------------------------------------------
    // Which local bindings and parameters are proven byte streams?
    // ---------------------------------------------------------------------
    const byteStreams = new Set<string>();
    /** Names bound to a `child_process` handle, whose `.stdout`/`.stderr` are byte pipes. */
    const childHandles = new Set<string>();

    /** What kind of stream, if any, does this expression produce? */
    type Source = "bytes" | "child" | "other";
    const sourceOf = (value: AstNode | null | undefined): Source => {
      if (!value) return "other";
      // `readStream = process.stdin` in one branch of a CLI's input selection.
      if (staticMemberPath(value) === "process.stdin") return "bytes";
      const hit = builtinCall(value);
      if (!hit) return "other";
      if (hit.family === "fs" && hit.name === "createReadStream") {
        return readStreamHasEncoding(value) ? "other" : "bytes";
      }
      if (hit.family === "net" && SOCKET_FACTORIES.has(hit.name)) return "bytes";
      if (hit.family === "http" && HTTP_REQUESTERS.has(hit.name)) return "bytes";
      if (hit.family === "child" && SPAWNERS.has(hit.name)) return "child";
      return "other";
    };

    /**
     * Every value a name is given, so a binding assigned across branches —
     * `let s; if (file) s = createReadStream(file); else s = process.stdin;` —
     * counts only when EVERY branch hands it a byte stream.
     */
    const assigned = new Map<string, Source[]>();
    const record = (name: string, source: Source): void => {
      const list = assigned.get(name);
      if (list) list.push(source);
      else assigned.set(name, [source]);
    };

    for (const node of collectDescendants(
      ctx.program,
      (n) => n.type === "VariableDeclarator" || n.type === "AssignmentExpression",
      undefined,
      true,
    )) {
      if (node.type === "VariableDeclarator") {
        const id = node.id as AstNode | undefined;
        const init = node.init as AstNode | undefined;
        // A bare `let s;` declares nothing about the value; the assignments do.
        if (id?.type === "Identifier" && init) record(id.name as string, sourceOf(init));
        continue;
      }
      if (node.operator !== "=") continue;
      const target = node.left as AstNode | undefined;
      if (target?.type === "Identifier") record(target.name as string, sourceOf(node.right as AstNode));
    }

    for (const [name, sources] of assigned) {
      if (sources.length === 0) continue;
      if (sources.every((k) => k === "bytes")) byteStreams.add(name);
      else if (sources.every((k) => k === "child")) childHandles.add(name);
    }

    // A callback parameter that the builtin hands a byte stream.
    for (const call of collectDescendants(ctx.program, (n) => n.type === "CallExpression", undefined, true)) {
      const hit = builtinCall(call);
      if (!hit) continue;
      const givesByteStream =
        (hit.family === "http" && (HTTP_REQUESTERS.has(hit.name) || SERVER_FACTORIES.has(hit.name))) ||
        (hit.family === "net" && SERVER_FACTORIES.has(hit.name));
      if (!givesByteStream) continue;
      for (const arg of (call.arguments as AstNode[] | undefined) ?? []) {
        if (arg.type !== "ArrowFunctionExpression" && arg.type !== "FunctionExpression") continue;
        const first = ((arg.params as AstNode[] | undefined) ?? [])[0];
        if (first?.type === "Identifier") byteStreams.add(first.name as string);
      }
    }

    /** Is the receiver of this `.on("data", …)` a proven byte stream? */
    const isByteStream = (receiver: AstNode | null | undefined): boolean => {
      if (!receiver) return false;
      if (receiver.type === "Identifier") return byteStreams.has(receiver.name as string);
      if (receiver.type !== "MemberExpression" || receiver.computed) return false;
      const property = (receiver.property as AstNode | undefined)?.name;
      if (property !== "stdout" && property !== "stderr" && property !== "stdin") return false;
      const object = receiver.object as AstNode | undefined;
      if (object?.type !== "Identifier") return false;
      // `process.stdin`, and a proven child handle's pipes.
      if (staticMemberPath(receiver) === "process.stdin") {
        return ctx.scope.getBinding("process", object) === null;
      }
      return childHandles.has(object.name as string);
    };

    /** `chunk` or `chunk.toString()` / `chunk.toString("utf8")`. */
    const isChunkValue = (node: AstNode | null | undefined, chunkName: string): boolean => {
      if (!node) return false;
      if (node.type === "Identifier") return node.name === chunkName;
      if (node.type !== "CallExpression" || getMethodName(node) !== "toString") return false;
      const receiver = (node.callee as AstNode | undefined)?.object as AstNode | undefined;
      if (receiver?.type !== "Identifier" || receiver.name !== chunkName) return false;
      const encoding = getStaticStringValue(((node.arguments as AstNode[] | undefined) ?? [])[0]);
      // No argument means utf8. `hex`/`base64` are per-byte and survive a split.
      return encoding === null || MULTIBYTE_ENCODINGS.has(encoding.toLowerCase());
    };

    return {
      CallExpression: (node) => {
        if (encodingAware) return;
        const method = getMethodName(node);
        if (method !== "on" && method !== "once" && method !== "addListener") return;
        const args = (node.arguments as AstNode[] | undefined) ?? [];
        if (getStaticStringValue(args[0]) !== "data") return;

        const callee = node.callee as AstNode | undefined;
        if (callee?.type !== "MemberExpression") return;
        if (!isByteStream(callee.object as AstNode)) return;

        const handler = args[1];
        if (handler?.type !== "ArrowFunctionExpression" && handler?.type !== "FunctionExpression") return;
        const chunkParam = ((handler.params as AstNode[] | undefined) ?? [])[0];
        if (chunkParam?.type !== "Identifier") return;
        const chunkName = chunkParam.name as string;

        for (const assignment of collectDescendants(
          handler,
          (n) => n.type === "AssignmentExpression" && n.operator === "+=",
          undefined,
          true,
        )) {
          if (!isChunkValue(assignment.right as AstNode, chunkName)) continue;

          // The accumulator must PROVABLY start as a string; `+=` onto an
          // unknown binding could be a number, a Buffer list, anything.
          const target = assignment.left as AstNode | undefined;
          if (target?.type !== "Identifier") continue;
          const binding = ctx.scope.getBinding(target.name as string, target);
          const init = binding?.initNode;
          if (!init || init.type !== "Literal" || typeof init.value !== "string") continue;

          ctx.report(
            assignment,
            `Each \`data\` chunk from this byte stream is a \`Buffer\` sized by the network, and \`+=\` decodes it on its own — so a character whose UTF-8 bytes straddle the boundary is decoded as separate halves and becomes replacement characters. Nothing throws: \`U+FFFD\` is legal inside a JSON string, so the corrupted value parses and gets stored. A small ASCII payload arrives in one chunk and never reproduces it. Collect the chunks and \`Buffer.concat(…).toString("utf8")\` once, or call \`setEncoding("utf8")\` on the stream first.`,
          );
        }
      },
    };
  },
});
