/**
 * The LSP wire format: JSON-RPC framed with `Content-Length` headers.
 *
 * Hand-rolled rather than pulling in `vscode-languageserver`, for the same reason
 * the MCP server is: node.doctor ships zero runtime dependencies, and the framing
 * is a dozen lines. Keeping it here also makes it directly unit-testable — the
 * decoder is a pure function over a byte buffer, so the nasty cases (a header
 * split across two TCP reads, two messages in one chunk, a UTF-8 character
 * straddling a boundary) are tested rather than hoped for.
 */

const HEADER_END = "\r\n\r\n";

/** Frame a message for the wire. Length is in BYTES, not characters. */
export const encodeMessage = (message: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}${HEADER_END}`, "ascii"), body]);
};

export interface DecodeResult {
  /** Complete messages decoded from the buffer, in order. */
  messages: unknown[];
  /** Bytes not yet consumed — carry these into the next read. */
  rest: Buffer;
}

/**
 * Decode as many complete messages as `buffer` holds. Anything partial stays in
 * `rest`. Never throws on a malformed frame: a message that will not parse is
 * dropped and decoding continues, so one bad frame cannot wedge the server.
 */
export const decodeMessages = (buffer: Buffer): DecodeResult => {
  const messages: unknown[] = [];
  let rest = buffer;

  for (;;) {
    const headerEnd = rest.indexOf(HEADER_END);
    if (headerEnd === -1) break; // headers still arriving

    const header = rest.subarray(0, headerEnd).toString("ascii");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      // Unparseable header — skip past it rather than spinning forever.
      rest = rest.subarray(headerEnd + HEADER_END.length);
      continue;
    }

    const length = Number(match[1]);
    const bodyStart = headerEnd + HEADER_END.length;
    if (rest.length < bodyStart + length) break; // body still arriving

    const body = rest.subarray(bodyStart, bodyStart + length).toString("utf8");
    rest = rest.subarray(bodyStart + length);
    try {
      messages.push(JSON.parse(body));
    } catch {
      /* malformed payload — drop this frame, keep the stream alive */
    }
  }

  return { messages, rest };
};
