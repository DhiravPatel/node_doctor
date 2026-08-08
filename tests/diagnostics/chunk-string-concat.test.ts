/**
 * §202 — `no-chunk-string-concat`.
 *
 * A `data` chunk from a BYTE stream is a Buffer sized by the network. `+=`
 * decodes each one on its own, so a UTF-8 character straddling the boundary
 * becomes replacement characters. Plenty of streams emit strings instead, so the
 * receiver is proven rather than assumed.
 */

/** A proven byte stream: an http server's request object. */
const SERVER = `import http from "node:http";\n`;

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noChunkStringConcat } from "../../src/diagnostics/bugs/no-chunk-string-concat.ts";

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/body.ts",
    sourceText: source,
    diagnostics: [noChunkStringConcat],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === "no-chunk-string-concat");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};

const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(found.length, 0, `expected SILENCE, got ${found.length}:\n${source}`);
};

describe("no-chunk-string-concat — fires", () => {
  test("the classic body-collection snippet", () => {
    const [f] = fires(
      `${SERVER}http.createServer((req, res) => {\n  let body = "";\n  req.on("data", (chunk) => { body += chunk; });\n});`,
    );
    assert.match(f!.message, /U\+FFFD/);
    assert.match(f!.message, /Buffer\.concat/);
    assert.match(f!.message, /setEncoding/);
  });

  test("the `function` form, and `once`", () => {
    fires(`${SERVER}http.createServer((req) => { let body = ""; req.on("data", function (chunk) { body += chunk; }); });`);
    fires(`${SERVER}http.createServer((req) => { let body = ""; req.once("data", (c) => { body += c; }); });`);
  });

  test("`chunk.toString()` with no argument is the same decode", () => {
    fires(`${SERVER}http.createServer((req) => { let body = ""; req.on("data", (c) => { body += c.toString(); }); });`);
  });

  test("every builtin that hands out a byte stream", () => {
    // process.stdin, an https response, a child's pipes, an unencoded file
    // read, and a socket — the five shapes the corpus sweep actually found.
    fires(`let source = "";\nprocess.stdin.on("data", (chunk) => { source += chunk; });`);
    fires(`import https from "node:https";\nhttps.request(o, (res) => { let b = ""; res.on("data", (d) => { b += d; }); }).end();`);
    fires(`import { spawn } from "node:child_process";\nconst child = spawn("ls", []);\nlet out = "";\nchild.stdout.on("data", (c) => { out += c; });`);
    fires(`import { createReadStream } from "node:fs";\nconst rs = createReadStream("./f");\nlet b = "";\nrs.on("data", (c) => { b += c; });`);
    fires(`import net from "node:net";\nconst sock = net.connect(80);\nlet b = "";\nsock.on("data", (c) => { b += c; });`);
  });

  test("the real shape found in the wild — Metro's JSON body parser", () => {
    fires(
      `${SERVER}http.createServer((req) => {\n  let data = "";\n  req.on("data", (chunk) => {\n    size += Buffer.byteLength(chunk);\n    if (size > LIMIT) { req.destroy(); return; }\n    data += chunk;\n  });\n  req.on("end", () => JSON.parse(data));\n});`,
    );
  });

  test("the CJS require form binds the same way", () => {
    fires(`const { spawn } = require("child_process");\nconst p = spawn("ls");\nlet o = "";\np.stderr.on("data", (c) => { o += c; });`);
  });
});

describe("no-chunk-string-concat — silent", () => {
  test("`setEncoding` installs a decoder that spans chunks", () => {
    silent(`${SERVER}http.createServer((req) => { req.setEncoding("utf8"); let body = ""; req.on("data", (c) => { body += c; }); });`);
  });

  test("any mention of an encoding means the file decodes deliberately", () => {
    // Which stream this handler is on is unknowable from here, and a stream
    // opened with an encoding emits strings already.
    silent(`let body = "";\nconst stream = createReadStream(p, "utf8");\nstream.on("data", (c) => { body += c; });`);
    silent(`let body = "";\nconst s = createReadStream(p, { encoding: "utf8" });\ns.on("data", (c) => { body += c; });`);
  });

  test("`hex` and `base64` are per-byte and survive any split", () => {
    silent(`let out = "";\nprocess.stdin.on("data", (c) => { out += c.toString("hex"); });`);
  });

  test("collecting the chunks is the correct thing to do", () => {
    silent(`const chunks = [];\nprocess.stdin.on("data", (c) => chunks.push(c));`);
    silent(`${SERVER}http.createServer((req) => { const chunks = []; req.on("data", (c) => { chunks.push(c); }); });`);
  });

  test("an accumulator that is not provably a string", () => {
    silent(`let n = 0;\nprocess.stdin.on("data", (c) => { n += c.length; });`);
    silent(`let body = seed;\nprocess.stdin.on("data", (c) => { body += c; });`);
    silent(`process.stdin.on("data", (c) => { outer.body += c; });`);
  });

  test("a different event, or a different right-hand side", () => {
    silent(`let body = "";\nprocess.stdin.on("line", (c) => { body += c; });`);
    silent(`let body = "";\nprocess.stdin.on("data", (c) => { body += prefix; });`);
    silent(`let body = "";\nprocess.stdin.on("data", () => { body += "."; });`);
  });
});

describe("no-chunk-string-concat — hardened by the adversarial hunt", () => {
  test("a stream whose chunks are already STRINGS is correct code", () => {
    // `Readable.from(["a"])`, objectMode, split2(), through2.obj(), a serialport
    // ReadlineParser, an iconv-lite decodeStream, Readable.fromWeb over a
    // TextDecoderStream — on every one of these, `+=` is right. The receiver is
    // proven rather than assumed, so none of them is judged.
    silent(`import { Readable } from "node:stream";\nconst s = Readable.from(["a", "b"]);\nlet b = "";\ns.on("data", (c) => { b += c; });`);
    silent(`const s = split2();\nlet b = "";\ns.on("data", (line) => { b += line; });`);
    silent(`import { PassThrough } from "node:stream";\nconst bus = new PassThrough({ objectMode: true });\nlet b = "";\nbus.on("data", (c) => { b += c; });`);
    silent(`let b = "";\nemitter.on("data", (c) => { b += c; });`);
  });

  test("a file stream opened WITH an encoding emits strings", () => {
    silent(`import { createReadStream } from "node:fs";\nconst rs = createReadStream("./f", "utf8");\nlet b = "";\nrs.on("data", (c) => { b += c; });`);
    silent(
      `import { createReadStream } from "node:fs";\nconst rs = createReadStream("./f", { encoding: "utf8" });\nlet b = "";\nrs.on("data", (c) => { b += c; });`,
    );
  });

  test("a shadowed `process` is not the global one", () => {
    silent(`function f(process) { let b = ""; process.stdin.on("data", (c) => { b += c; }); }`);
  });
});

describe("no-chunk-string-concat — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `import net from "node:net";\nconst x = net.connect(1);\nconst y = net.connect(2);\nlet a = "";\nlet b = "";\nx.on("data", (c) => { a += c; });\ny.on("data", (c) => { b += c; });`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
