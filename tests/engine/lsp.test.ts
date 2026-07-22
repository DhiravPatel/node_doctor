import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { encodeMessage, decodeMessages } from "../../src/lsp/protocol.ts";
import { createServer, pathFromUri, type LspServer } from "../../src/lsp/server.ts";
import { rangeForFinding, hoverFor, codeActionsFor, rangeContains } from "../../src/lsp/diagnostics.ts";

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

describe("LSP framing", () => {
  test("round-trips a message", () => {
    const { messages, rest } = decodeMessages(encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 1, method: "initialize" }]);
    assert.equal(rest.length, 0);
  });

  test("Content-Length counts BYTES, not characters", () => {
    // "é" is two UTF-8 bytes — a character count here would truncate the body.
    const frame = encodeMessage({ text: "café ☕" });
    const header = frame.subarray(0, frame.indexOf("\r\n\r\n")).toString("ascii");
    const declared = Number(/Content-Length: (\d+)/.exec(header)![1]);
    const body = frame.subarray(frame.indexOf("\r\n\r\n") + 4);
    assert.equal(declared, body.length);
    assert.deepEqual(decodeMessages(frame).messages, [{ text: "café ☕" }]);
  });

  test("decodes two messages arriving in one chunk", () => {
    const buf = Buffer.concat([encodeMessage({ a: 1 }), encodeMessage({ b: 2 })]);
    assert.deepEqual(decodeMessages(buf).messages, [{ a: 1 }, { b: 2 }]);
  });

  test("holds a partial frame until the rest arrives", () => {
    const full = encodeMessage({ hello: "world" });
    const first = decodeMessages(full.subarray(0, 12));
    assert.deepEqual(first.messages, [], "header incomplete → nothing yet");

    const split = full.length - 5;
    const second = decodeMessages(full.subarray(0, split));
    assert.deepEqual(second.messages, [], "body incomplete → nothing yet");
    const third = decodeMessages(Buffer.concat([second.rest, full.subarray(split)]));
    assert.deepEqual(third.messages, [{ hello: "world" }]);
  });

  test("a malformed payload is dropped without wedging the stream", () => {
    const bad = Buffer.from("Content-Length: 5\r\n\r\n{oops", "utf8");
    const buf = Buffer.concat([bad, encodeMessage({ ok: true })]);
    assert.deepEqual(decodeMessages(buf).messages, [{ ok: true }], "recovers and reads the next message");
  });
});

// ---------------------------------------------------------------------------
// Position mapping — the off-by-one that would misplace every squiggle
// ---------------------------------------------------------------------------

describe("position mapping", () => {
  const finding = (line: number, column: number) =>
    ({ line, column, severity: "error", diagnostic: "d", message: "m", recommendation: "r" }) as never;

  test("converts 1-based node.doctor positions to 0-based LSP positions", () => {
    const r = rangeForFinding(finding(3, 5), "const x = evil(1);");
    assert.equal(r.start.line, 2);
    assert.equal(r.start.character, 4);
  });

  test("underlines the token so the squiggle has width", () => {
    const r = rangeForFinding(finding(1, 11), "const x = evil(1);");
    assert.ok(r.end.character > r.start.character);
  });

  test("rangeContains respects line and character bounds", () => {
    const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } };
    assert.equal(rangeContains(range, { line: 2, character: 6 }), true);
    assert.equal(rangeContains(range, { line: 2, character: 9 }), false);
    assert.equal(rangeContains(range, { line: 3, character: 5 }), false);
  });
});

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

const BAD = 'app.get("/x",(req,res)=>{ const o = eval(req.query.c); res.send(o); });\n';
const uri = pathToFileURL(join(tmpdir(), "nd-lsp-fixture", "handler.js")).href;

const makeServer = (): { server: LspServer; sent: Array<Record<string, unknown>> } => {
  const sent: Array<Record<string, unknown>> = [];
  const server = createServer({
    send: (m) => sent.push(m as Record<string, unknown>),
    // Run debounced work immediately so tests need no real timers.
    setTimer: (fn) => {
      fn();
      return 0;
    },
    clearTimer: () => {},
  });
  return { server, sent };
};

const published = (sent: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
  sent
    .filter((m) => m.method === "textDocument/publishDiagnostics")
    .map((m) => (m.params as Record<string, unknown>));

describe("LSP server", () => {
  test("initialize advertises the capabilities the client needs", async () => {
    const { server, sent } = makeServer();
    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const caps = (sent[0]!.result as Record<string, Record<string, unknown>>).capabilities;
    assert.equal(caps.hoverProvider, true);
    assert.equal(caps.codeActionProvider, true);
    assert.ok(caps.textDocumentSync);
  });

  test("didOpen publishes diagnostics for the buffer", async () => {
    const { server, sent } = makeServer();
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, text: BAD, version: 1 } },
    });
    const diags = published(sent)[0]!.diagnostics as Array<Record<string, unknown>>;
    assert.ok(diags.length > 0);
    assert.equal(diags[0]!.source, "node.doctor");
    assert.match(String(diags[0]!.code), /^node-doctor\//);
    assert.equal(diags[0]!.severity, 1, "an error maps to LSP severity 1");
  });

  test("analyzes the unsaved buffer, not the file on disk", async () => {
    const { server, sent } = makeServer();
    // The path never exists; diagnostics must still come from the buffer text.
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, text: BAD, version: 1 } },
    });
    assert.ok((published(sent)[0]!.diagnostics as unknown[]).length > 0);
  });

  test("didChange to clean code clears the diagnostics", async () => {
    const { server, sent } = makeServer();
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, text: BAD, version: 1 } },
    });
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: "export const add=(a,b)=>a+b;\n" }] },
    });
    const last = published(sent).at(-1)!;
    assert.deepEqual(last.diagnostics, []);
  });

  test("a syntax error mid-edit keeps the previous diagnostics rather than flashing empty", async () => {
    const { server, sent } = makeServer();
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, text: BAD, version: 1 } },
    });
    const before = published(sent).length;
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: "const x = (((" }] },
    });
    assert.equal(published(sent).length, before, "no publish on an unparseable buffer");
    assert.ok(server.diagnosticsFor(uri).length > 0, "last good diagnostics retained");
  });

  test("didClose clears diagnostics and forgets the document", async () => {
    const { server, sent } = makeServer();
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, text: BAD, version: 1 } },
    });
    await server.handle({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri } } });
    assert.deepEqual(published(sent).at(-1)!.diagnostics, []);
    assert.deepEqual(server.diagnosticsFor(uri), []);
  });

  test("hover returns a markdown card over a finding, null elsewhere", async () => {
    const { server, sent } = makeServer();
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, text: BAD, version: 1 } },
    });
    const d = (published(sent)[0]!.diagnostics as Array<{ range: { start: { line: number; character: number } } }>)[0]!;
    sent.length = 0;
    await server.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "textDocument/hover",
      params: { textDocument: { uri }, position: d.range.start },
    });
    const contents = (sent[0]!.result as { contents: { value: string } }).contents;
    assert.equal((sent[0]!.result as { contents: { kind: string } }).contents.kind, "markdown");
    assert.match(contents.value, /node-doctor\//);

    sent.length = 0;
    await server.handle({
      jsonrpc: "2.0",
      id: 10,
      method: "textDocument/hover",
      params: { textDocument: { uri }, position: { line: 99, character: 0 } },
    });
    assert.equal(sent[0]!.result, null);
  });

  test("code action inserts a disable comment WITH a reason placeholder", async () => {
    const { server, sent } = makeServer();
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, text: BAD, version: 1 } },
    });
    sent.length = 0;
    await server.handle({
      jsonrpc: "2.0",
      id: 11,
      method: "textDocument/codeAction",
      params: {
        textDocument: { uri },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 80 } },
      },
    });
    const actions = sent[0]!.result as Array<{ title: string; edit: { changes: Record<string, Array<{ newText: string }>> } }>;
    assert.ok(actions.length > 0);
    const text = actions[0]!.edit.changes[uri]![0]!.newText;
    assert.match(text, /node-doctor-disable-next-line/);
    // A bare suppression would just trade one finding for `suppression-without-reason`.
    assert.match(text, /-- TODO: explain/);
  });

  test("an unknown request is answered so the client never hangs", async () => {
    const { server, sent } = makeServer();
    await server.handle({ jsonrpc: "2.0", id: 42, method: "textDocument/somethingElse", params: {} });
    assert.equal(sent[0]!.id, 42);
  });

  test("a non-file URI is ignored rather than crashing", async () => {
    const { server, sent } = makeServer();
    await server.handle({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri: "untitled:Untitled-1", text: BAD, version: 1 } },
    });
    assert.equal(published(sent).length, 0);
    assert.equal(pathFromUri("untitled:Untitled-1"), null);
  });
});

describe("codeActionsFor", () => {
  test("returns nothing when the range holds no finding", () => {
    assert.deepEqual(codeActionsFor("file:///a.ts", [], { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, "x"), []);
  });
});

describe("hoverFor", () => {
  test("returns null with no diagnostics", () => {
    assert.equal(hoverFor([], { line: 0, character: 0 }), null);
  });
});
