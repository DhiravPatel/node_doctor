/**
 * §202 — `no-string-length-as-content-length`.
 *
 * `String.prototype.length` counts UTF-16 code units; `Content-Length` counts
 * bytes. They agree only for ASCII, so the operand has to be provably a string
 * before the claim can be made — a bare identifier could be a Buffer, whose
 * `.length` IS the byte count.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noStringLengthAsContentLength } from "../../src/diagnostics/bugs/no-string-length-as-content-length.ts";

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/server.ts",
    sourceText: source,
    diagnostics: [noStringLengthAsContentLength],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === "no-string-length-as-content-length");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};

const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(found.length, 0, `expected SILENCE, got ${found.length}:\n${source}`);
};

describe("no-string-length-as-content-length — fires", () => {
  test("`JSON.stringify(…).length`, the commonest form", () => {
    const [f] = fires(`res.setHeader("Content-Length", JSON.stringify(payload).length);`);
    assert.match(f!.message, /UTF-16 code units/);
    assert.match(f!.message, /Buffer\.byteLength/);
    assert.match(f!.message, /keep-alive/);
  });

  test("a template WITH substitutions depends on data the file does not contain", () => {
    fires(`res.setHeader("Content-Length", \`hello \${name}\`.length);`);
    fires(`res.setHeader("Content-Length", (JSON.stringify(o) + "!").length);`);
  });

  test("a literal that really does encode to more bytes than it has characters", () => {
    fires(`res.setHeader("Content-Length", "café ☕".length);`);
    fires(`res.setHeader("Content-Length", \`café\`.length);`);
  });

  test("`writeHead` carries the same header in an object", () => {
    fires(`res.writeHead(200, { "Content-Length": JSON.stringify(o).length });`);
    fires(`res.writeHead(200, { "content-length": \`\${row}\`.length });`);
  });

  test("the header name is matched however it is cased", () => {
    fires(`res.setHeader("CONTENT-LENGTH", JSON.stringify(o).length);`);
  });
});

describe("no-string-length-as-content-length — silent", () => {
  test("`Buffer.byteLength` is the fix", () => {
    silent(`res.setHeader("Content-Length", Buffer.byteLength(body));`);
    silent(`res.setHeader("Content-Length", Buffer.byteLength(JSON.stringify(o)));`);
  });

  test("a bare identifier could be a Buffer, whose `.length` is correct", () => {
    silent(`res.setHeader("Content-Length", body.length);`);
    silent(`res.setHeader("Content-Length", buf.length);`);
    silent(`res.writeHead(200, { "Content-Length": chunk.length });`);
  });

  test("a value that is not a `.length` read at all", () => {
    silent(`res.setHeader("Content-Length", size);`);
    silent(`res.setHeader("Content-Length", stat.size);`);
    silent(`res.setHeader("Content-Length", String(bytes));`);
  });

  test("a different header entirely", () => {
    silent(`res.setHeader("X-Item-Count", JSON.stringify(o).length);`);
    silent(`res.writeHead(200, { "X-Rows": items.join(",").length });`);
  });
});

describe("no-string-length-as-content-length — hardened by the adversarial hunt", () => {
  test("an ASCII literal is decided by ARITHMETIC, and it is correct code", () => {
    // A canned 404 body, a /healthz "OK", a hex digest, a base64 token: every
    // byte of them is ASCII, so `.length` IS the byte count.
    silent(`res.setHeader("Content-Length", "Not Found".length);`);
    silent(`res.setHeader("Content-Length", "OK".length);`);
    silent(`res.setHeader("Content-Length", \`{"error":"not found"}\`.length);`);
    silent(`res.writeHead(200, { "Content-Length": "OK".length });`);
  });

  test("everything decided by a METHOD NAME was removed", () => {
    // `String(n)`, `toISOString()`, `toString()`, `join()` on numbers — all
    // produce ASCII, so the code is right and the name cannot tell you so.
    silent(`res.setHeader("Content-Length", String(count).length);`);
    silent(`res.setHeader("Content-Length", new Date().toISOString().length);`);
    silent(`res.setHeader("Content-Length", buf.toString("hex").length);`);
    silent(`res.setHeader("Content-Length", ids.join(",").length);`);
  });

  test("`set` and `header` are too generic to be HTTP", () => {
    // A Map of column widths keyed by a header name, and a report builder's
    // `.header(name, width)`, are not responses.
    silent(`widths.set("Content-Length", "Content-Length".length);`);
    silent(`report.header("Content-Length", "Content-Length".length);`);
  });
});

describe("no-string-length-as-content-length — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `res.setHeader("Content-Length", JSON.stringify(a).length);\nres.setHeader("content-length", \`\${b}\`.length);`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
