/**
 * A Language Server for node.doctor (§41, §53).
 *
 * The scanner already knows things an editor should show the moment you type
 * them — a blocking call on a request path, an injection sink, a secret. This
 * puts them under the cursor instead of behind a CLI run, which is the whole
 * point of "catch it at the source": the fastest feedback loop wins.
 *
 * Design notes:
 *  - Analysis runs on the **unsaved buffer**, not the file on disk, so squiggles
 *    track what you are actually typing.
 *  - Per-document debounce with supersede: keystrokes coalesce, and a newer edit
 *    cancels an in-flight analysis for that document rather than queueing behind it.
 *  - Only file-scope diagnostics run. Project-scope (cross-file) and text-scan
 *    diagnostics need the whole tree and are left to the CLI — an editor pass
 *    that re-walked the project on every keystroke would be useless.
 *  - `handleRequest` is pure-ish and unit-tested; the transport is a thin shell.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lintSource } from "../core/scan.ts";
import { DIAGNOSTICS } from "../core/registry.ts";
import { discoverProject, shouldEnableDiagnostic } from "../core/project.ts";
import { toolVersion } from "../core/version.ts";
import { encodeMessage, decodeMessages } from "./protocol.ts";
import {
  toLspDiagnostics,
  hoverFor,
  codeActionsFor,
  type LspDiagnostic,
  type LspRange,
  type LspPosition,
} from "./diagnostics.ts";
import type { Finding } from "../core/types.ts";

const DEBOUNCE_MS = 180;

interface Doc {
  uri: string;
  text: string;
  version: number;
}

/** File path for a `file://` URI, or null for anything else (untitled, scheme). */
export const pathFromUri = (uri: string): string | null => {
  if (!uri.startsWith("file://")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
};

export interface ServerDeps {
  /** Emit a notification/response to the client. */
  send: (message: unknown) => void;
  /** Overridable for tests (avoids real timers). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface LspServer {
  handle: (message: unknown) => Promise<void>;
  /** Analyze a document now, bypassing the debounce (used by tests). */
  analyzeNow: (uri: string) => Promise<void>;
  diagnosticsFor: (uri: string) => LspDiagnostic[];
}

/**
 * Build the server. Capabilities are resolved per project directory and cached —
 * an editor session stays in one project, and re-reading the manifest on every
 * keystroke would be wasteful.
 */
export const createServer = (deps: ServerDeps): LspServer => {
  const docs = new Map<string, Doc>();
  const published = new Map<string, LspDiagnostic[]>();
  const timers = new Map<string, unknown>();
  const capsCache = new Map<string, Set<string>>();
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const capabilitiesFor = async (filePath: string): Promise<Set<string>> => {
    const dir = dirname(filePath);
    const cached = capsCache.get(dir);
    if (cached) return cached;
    let caps: Set<string>;
    try {
      caps = (await discoverProject(dir)).capabilities;
    } catch {
      caps = new Set(["node"]);
    }
    capsCache.set(dir, caps);
    return caps;
  };

  const analyze = async (uri: string): Promise<void> => {
    const doc = docs.get(uri);
    if (!doc) return;
    const filePath = pathFromUri(uri);
    if (!filePath) return;

    const startedAt = doc.version;
    const capabilities = await capabilitiesFor(filePath);
    // A newer edit landed while we were resolving — that analysis is stale.
    if ((docs.get(uri)?.version ?? -1) !== startedAt) return;

    const active = DIAGNOSTICS.filter(
      (d) => (d.scope ?? "file") === "file" && shouldEnableDiagnostic(d, capabilities),
    );

    let findings: Finding[] = [];
    try {
      const result = lintSource({ filePath, sourceText: doc.text, diagnostics: active, capabilities });
      // A syntax error mid-edit is normal; keep the last good diagnostics rather
      // than flashing the list empty on every incomplete keystroke.
      if (result.parseFailed) return;
      findings = result.findings;
    } catch {
      return;
    }
    if ((docs.get(uri)?.version ?? -1) !== startedAt) return;

    const diagnostics = toLspDiagnostics(findings, doc.text);
    published.set(uri, diagnostics);
    deps.send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
  };

  const schedule = (uri: string): void => {
    const existing = timers.get(uri);
    if (existing !== undefined) clearTimer(existing);
    timers.set(
      uri,
      setTimer(() => {
        timers.delete(uri);
        void analyze(uri);
      }, DEBOUNCE_MS),
    );
  };

  const clearDoc = (uri: string): void => {
    const t = timers.get(uri);
    if (t !== undefined) clearTimer(t);
    timers.delete(uri);
    docs.delete(uri);
    published.delete(uri);
    deps.send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
  };

  const handle = async (message: unknown): Promise<void> => {
    const msg = message as { id?: number | string; method?: string; params?: Record<string, unknown> };
    const { id, method, params } = msg;
    const reply = (result: unknown): void => {
      if (id !== undefined) deps.send({ jsonrpc: "2.0", id, result });
    };

    switch (method) {
      case "initialize":
        reply({
          capabilities: {
            // Full sync: the analyzer needs the whole buffer anyway, and it keeps
            // the server free of incremental-patch bugs.
            textDocumentSync: { openClose: true, change: 1, save: true },
            hoverProvider: true,
            codeActionProvider: true,
          },
          serverInfo: { name: "node-doctor", version: toolVersion() },
        });
        return;

      case "initialized":
      case "$/setTrace":
        return;

      case "shutdown":
        reply(null);
        return;

      case "exit":
        return;

      case "textDocument/didOpen": {
        const td = params?.textDocument as { uri: string; text: string; version?: number } | undefined;
        if (!td) return;
        docs.set(td.uri, { uri: td.uri, text: td.text, version: td.version ?? 0 });
        await analyze(td.uri); // open is not a keystroke — show results immediately
        return;
      }

      case "textDocument/didChange": {
        const td = params?.textDocument as { uri: string; version?: number } | undefined;
        const changes = (params?.contentChanges as Array<{ text: string }> | undefined) ?? [];
        const full = changes[changes.length - 1];
        if (!td || !full) return;
        const prev = docs.get(td.uri);
        docs.set(td.uri, { uri: td.uri, text: full.text, version: td.version ?? (prev?.version ?? 0) + 1 });
        schedule(td.uri);
        return;
      }

      case "textDocument/didSave": {
        const td = params?.textDocument as { uri: string } | undefined;
        if (td) await analyze(td.uri);
        return;
      }

      case "textDocument/didClose": {
        const td = params?.textDocument as { uri: string } | undefined;
        if (td) clearDoc(td.uri);
        return;
      }

      case "textDocument/hover": {
        const td = params?.textDocument as { uri: string } | undefined;
        const position = params?.position as LspPosition | undefined;
        if (!td || !position) return reply(null);
        const markdown = hoverFor(published.get(td.uri) ?? [], position);
        return reply(markdown ? { contents: { kind: "markdown", value: markdown } } : null);
      }

      case "textDocument/codeAction": {
        const td = params?.textDocument as { uri: string } | undefined;
        const range = params?.range as LspRange | undefined;
        const doc = td ? docs.get(td.uri) : undefined;
        if (!td || !range || !doc) return reply([]);
        return reply(codeActionsFor(td.uri, published.get(td.uri) ?? [], range, doc.text));
      }

      default:
        // Unknown request: answer so the client is never left waiting.
        if (id !== undefined) reply(null);
        return;
    }
  };

  return {
    handle,
    analyzeNow: analyze,
    diagnosticsFor: (uri) => published.get(uri) ?? [],
  };
};

/**
 * Wire the server to stdin/stdout. Nothing but protocol frames touch stdout.
 * Resolves only when the client closes the stream — the caller awaits it, so the
 * process stays alive for the session instead of exiting as soon as it is wired.
 */
export const startLanguageServer = (): Promise<void> =>
  new Promise((done) => {
    const server = createServer({ send: (m) => process.stdout.write(encodeMessage(m)) });
    let buffer: Buffer = Buffer.alloc(0);
    let queue: Promise<void> = Promise.resolve();

    process.stderr.write("node-doctor language server ready (stdio).\n");
    process.stdin.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]) as Buffer;
      const { messages, rest } = decodeMessages(buffer);
      buffer = rest as Buffer;
      // Serialize handling so document state mutates in message order.
      for (const message of messages) {
        queue = queue.then(() => server.handle(message)).catch(() => {});
      }
    });
    process.stdin.on("end", () => done());
    process.stdin.on("close", () => done());
  });
