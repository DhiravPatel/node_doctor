/**
 * §128 — `no-unhandled-pipe-error`.
 *
 * The rule is opt-in and not in the generated registry for these tests, so we
 * import it directly and drive `lintSource` with an explicit single-rule list.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnhandledPipeError } from "../../src/diagnostics/reliability/no-unhandled-pipe-error.ts";

const CAPS = new Set(["node", "esm", "typescript"]);
const FS_IMPORT = `import { createReadStream, createWriteStream } from "node:fs";\n`;

const findings = (source: string) =>
  lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [noUnhandledPipeError],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-unhandled-pipe-error");

const fires = (source: string): void => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected no-unhandled-pipe-error to FIRE on:\n${source}`);
};

const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(
    found.length,
    0,
    `expected no-unhandled-pipe-error to STAY SILENT, got ${found.length}:\n` +
      found.map((f) => `  - ${f.message}`).join("\n") +
      `\n--- source ---\n${source}`,
  );
};

describe("no-unhandled-pipe-error — fires", () => {
  test("a named stream binding piped with no error listener", () => {
    fires(FS_IMPORT + `const file = createReadStream(path);\nfile.pipe(res);`);
  });

  test("an inline stream chain piped with no error listener", () => {
    fires(FS_IMPORT + `createReadStream(path).pipe(res);`);
  });

  test("a namespaced factory (fs.createReadStream)", () => {
    fires(`import fs from "node:fs";\nconst f = fs.createReadStream(path);\nf.pipe(res);`);
  });

  test("a zlib transform stream", () => {
    fires(`import { createGzip } from "node:zlib";\nconst gz = createGzip();\ngz.pipe(out);`);
  });

  test("a constructed PassThrough", () => {
    fires(`import { PassThrough } from "node:stream";\nconst tunnel = new PassThrough();\ntunnel.pipe(res);`);
  });

  test("pipe with an options argument still fires", () => {
    fires(FS_IMPORT + `const f = createReadStream(p);\nf.pipe(res, { end: false });`);
  });
});

describe("no-unhandled-pipe-error — silent when an error path may exist", () => {
  test("an error listener on the binding, before the pipe", () => {
    silent(FS_IMPORT + `const f = createReadStream(p);\nf.on("error", next);\nf.pipe(res);`);
  });

  test("an error listener registered AFTER the pipe is still registered", () => {
    silent(FS_IMPORT + `const f = createReadStream(p);\nf.pipe(res);\nf.on("error", next);`);
  });

  test("an inline chain that handles error before piping", () => {
    silent(FS_IMPORT + `createReadStream(p).on("error", next).pipe(res);`);
  });

  test("`once(\"error\")` counts", () => {
    silent(FS_IMPORT + `const f = createReadStream(p);\nf.once("error", next);\nf.pipe(res);`);
  });

  test("a dynamic event name could be error — unprovable, so silent", () => {
    silent(FS_IMPORT + `const f = createReadStream(p);\nf.on(evt, next);\nf.pipe(res);`);
  });

  test("stream.pipeline handles teardown for the whole chain", () => {
    silent(
      `import { pipeline } from "node:stream";\nimport { createReadStream, createWriteStream } from "node:fs";\npipeline(createReadStream(a), createWriteStream(b), (err) => {});`,
    );
  });

  test("a stream passed into a helper may get its handler there", () => {
    silent(FS_IMPORT + `const f = createReadStream(p);\nwireUp(f);\nf.pipe(res);`);
  });
});

describe("no-unhandled-pipe-error — never fires on a non-stream `.pipe()`", () => {
  test("an RxJS observable pipeline is not a stream", () => {
    silent(
      `import { map, filter } from "rxjs/operators";\nobservable$.pipe(map((x) => x), filter(Boolean)).subscribe();`,
    );
  });

  test("a single RxJS operator argument is still not a destination", () => {
    silent(`import { map } from "rxjs/operators";\nsource$.pipe(map((x) => x * 2)).subscribe();`);
  });

  test("an unidentified receiver is never assumed to be a stream", () => {
    silent(FS_IMPORT + `someThing.pipe(dest);`);
    silent(FS_IMPORT + `getStream().pipe(dest);`);
    silent(FS_IMPORT + `this.source.pipe(dest);`);
  });

  test("a parameter is not provably a stream", () => {
    silent(FS_IMPORT + `export function forward(input, out) { input.pipe(out); }`);
  });

  test("no stream factory anywhere — nothing to claim", () => {
    silent(`a.pipe(b);`);
  });
});
