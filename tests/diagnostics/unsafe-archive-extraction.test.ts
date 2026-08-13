/**
 * §7 — `no-unsafe-archive-extraction` (zip slip).
 *
 * An archive entry carries its own path, and that path is attacker-chosen.
 * Measured: `join("/srv/app/uploads", "../../../etc/cron.d/pwn")` resolves to
 * `/etc/cron.d/pwn`.
 *
 * Two shapes, and they are not equally provable — the `tar` flag is a literal
 * verified against the shipped library, the hand-rolled join needs three
 * conditions before it will say anything.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { lintSource } from "../../src/core/scan.ts";
import { noUnsafeArchiveExtraction } from "../../src/diagnostics/security/no-unsafe-archive-extraction.ts";

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/extract.ts",
    sourceText: source,
    diagnostics: [noUnsafeArchiveExtraction],
    capabilities: new Set(["node", "esm", "typescript"]),
  }).findings.filter((f) => f.diagnostic === "no-unsafe-archive-extraction");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string): void =>
  assert.equal(findings(source).length, 0, `expected SILENCE on:\n${source}`);

const TAR = `import * as tar from "tar";\n`;
const FS = `import { join } from "node:path";\nimport { createWriteStream } from "node:fs";\n`;

describe("the escape is real", () => {
  test("an entry path walks straight out of the destination", () => {
    // The premise, pinned as an executable fact rather than asserted.
    assert.equal(join("/srv/app/uploads", "../../../etc/cron.d/pwn"), "/etc/cron.d/pwn");
    assert.equal(join("/srv/app/uploads", "a/../../../../tmp/x"), "/tmp/x");
    assert.equal(join("/srv/app/uploads", "ok/file.txt"), "/srv/app/uploads/ok/file.txt");
  });
});

describe("no-unsafe-archive-extraction — the tar flag", () => {
  test("`preservePaths: true` turns off three protections at once", () => {
    const [f] = fires(`${TAR}await tar.x({ file, cwd: dest, preservePaths: true });`);
    assert.match(f!.message, /stripping `\/`/);
    assert.match(f!.message, /`\.\.`/);
    assert.match(f!.message, /symbolic link/);
  });

  test("the documented `P` alias, `extract`, and the require form", () => {
    fires(`${TAR}await tar.x({ file, cwd: dest, P: true });`);
    fires(`${TAR}await tar.extract({ file, cwd: dest, preservePaths: true });`);
    fires(`const tar = require("tar");\nawait tar.x({ file, cwd: dest, preservePaths: true });`);
  });

  test("the default is the safe one, and saying so is not a defect", () => {
    silent(`${TAR}await tar.x({ file, cwd: dest });`);
    silent(`${TAR}await tar.x({ file, cwd: dest, preservePaths: false });`);
  });

  test("a non-literal is not folded, and a look-alike module is not tar", () => {
    silent(`${TAR}await tar.x({ file, cwd: dest, preservePaths: allowAbsolute });`);
    silent(`import * as tar from "./my-tar.ts";\nawait tar.x({ file, preservePaths: true });`);
  });
});

describe("no-unsafe-archive-extraction — the hand-rolled join", () => {
  test("an entry name reaching a write, with nothing checking it", () => {
    const [f] = fires(`${FS}zip.on("entry", (entry) => { createWriteStream(join(dest, entry.fileName)); });`);
    assert.match(f!.message, /attacker-chosen/);
    assert.match(f!.message, /etc\/cron\.d\/pwn/);
  });

  test("both entry properties that were verified in a shipped library", () => {
    // `fileName` is yauzl's (confirmed in its source); `path` is tar's
    // `read-entry.js`. `adm-zip`'s `entryName` is documented but was not
    // installed here to check, so it is deliberately not matched.
    fires(`${FS}zip.on("entry", (entry) => { createWriteStream(join(dest, entry.fileName)); });`);
    fires(
      `import { join } from "node:path";\nimport { writeFileSync } from "node:fs";\nstream.on("entry", (entry) => { writeFileSync(join(dest, entry.path), buf); });`,
    );
  });

  test("ANY containment check is a silence", () => {
    // Whether the check is CORRECT is not a claim this makes; that one exists
    // is. Proving correctness would need to evaluate the comparison.
    silent(
      `import { join, relative } from "node:path";\nimport { createWriteStream } from "node:fs";\nzip.on("entry", (entry) => { const out = join(dest, entry.fileName); if (relative(dest, out).startsWith("..")) return; createWriteStream(out); });`,
    );
    silent(
      `${FS}zip.on("entry", (entry) => { const out = join(dest, entry.fileName); if (!out.startsWith(dest)) return; createWriteStream(out); });`,
    );
  });

  test("all three conditions are required", () => {
    // Not an "entry" listener…
    silent(`${FS}queue.on("job", (entry) => { createWriteStream(join(dest, entry.fileName)); });`);
    // …not a write…
    silent(
      `import { join } from "node:path";\nimport { readFileSync } from "node:fs";\nzip.on("entry", (entry) => { readFileSync(join(dest, entry.fileName)); });`,
    );
    // …and not an entry-path property.
    silent(`${FS}zip.on("entry", (entry) => { createWriteStream(join(dest, entry.size)); });`);
  });
});

describe("no-unsafe-archive-extraction — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = `${TAR}await tar.x({ file: a, preservePaths: true });\nawait tar.x({ file: b, preservePaths: true });`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
