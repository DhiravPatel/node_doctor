/**
 * §19 — `no-conflicting-dependency-declaration`.
 *
 * A package in both `dependencies` and `devDependencies` reads like a harmless
 * duplicate. Measured against real npm, twice:
 *
 *   - with DIFFERENT ranges, the devDependencies range wins (`^7` + `^6`
 *     resolved `semver@6.3.1`);
 *   - with IDENTICAL ranges it still resolves as dev;
 *   - in both cases the lockfile carries `"dev": true`, and after
 *     `npm install --omit=dev` the package is absent from `node_modules`.
 *
 * So the failure is production-only and total, and npm prints no warning.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { noConflictingDependencyDeclaration } from "../../src/diagnostics/supplychain/no-conflicting-dependency-declaration.ts";

interface Reported {
  line: number;
  message: string;
}

const scan = (manifest: unknown): Reported[] => {
  const content = typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2);
  const found: Reported[] = [];
  noConflictingDependencyDeclaration.scan({
    filePath: "/repo/package.json",
    normalizedFilePath: "package.json",
    content,
    committed: true,
    report: (f) => found.push({ line: f.line, message: f.message }),
  });
  return found;
};

describe("no-conflicting-dependency-declaration — fires", () => {
  test("different ranges, and the message states which one wins", () => {
    const found = scan({ dependencies: { semver: "^7.0.0" }, devDependencies: { semver: "^6.0.0" } });
    assert.equal(found.length, 1);
    assert.match(found[0]!.message, /`\^7\.0\.0` as a runtime dependency and `\^6\.0\.0` as a dev one/);
    assert.match(found[0]!.message, /devDependencies range wins/);
    assert.match(found[0]!.message, /MODULE_NOT_FOUND/);
  });

  test("IDENTICAL ranges are equally wrong — it still resolves as dev", () => {
    const found = scan({ dependencies: { semver: "^7.0.0" }, devDependencies: { semver: "^7.0.0" } });
    assert.equal(found.length, 1);
    assert.match(found[0]!.message, /both at `\^7\.0\.0`/);
  });

  test("every conflicting package is reported, in a stable order", () => {
    const found = scan({
      dependencies: { zod: "^3", axios: "^1", semver: "^7" },
      devDependencies: { zod: "^3", semver: "^6", typescript: "^5" },
    });
    assert.deepEqual(
      found.map((f) => f.message.match(/^`([^`]+)`/)?.[1]),
      ["semver", "zod"],
    );
  });

  test("the line points at the devDependencies entry, which is the one to delete", () => {
    const content = [
      "{",
      '  "name": "app",',
      '  "dependencies": {',
      '    "semver": "^7.0.0"',
      "  },",
      '  "devDependencies": {',
      '    "typescript": "^5.0.0",',
      '    "semver": "^6.0.0"',
      "  }",
      "}",
    ].join("\n");
    const found = scan(content);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.line, 8);
  });
});

describe("no-conflicting-dependency-declaration — silent", () => {
  test("a manifest with no overlap", () => {
    assert.deepEqual(scan({ dependencies: { express: "^4" }, devDependencies: { typescript: "^5" } }), []);
  });

  test("a peer dependency ALSO declared as a runtime one is the ordinary pattern", () => {
    // Shipping a peer with a fallback is how libraries do it; never reported.
    assert.deepEqual(scan({ dependencies: { react: "^18" }, peerDependencies: { react: "^18" } }), []);
  });

  test("`optionalDependencies` overriding `dependencies` is documented and deliberate", () => {
    assert.deepEqual(scan({ dependencies: { fsevents: "^2" }, optionalDependencies: { fsevents: "^2" } }), []);
  });

  test("a manifest missing either section, or neither", () => {
    assert.deepEqual(scan({ dependencies: { express: "^4" } }), []);
    assert.deepEqual(scan({ devDependencies: { typescript: "^5" } }), []);
    assert.deepEqual(scan({ name: "app", version: "1.0.0" }), []);
  });

  test("a manifest that does not parse is skipped rather than guessed at", () => {
    assert.deepEqual(scan("{ not json"), []);
    assert.deepEqual(scan("[]"), []);
    assert.deepEqual(scan('{ "dependencies": "oops", "devDependencies": {} }'), []);
  });
});

describe("no-conflicting-dependency-declaration — determinism", () => {
  test("identical input yields identical output", () => {
    const m = { dependencies: { a: "^1", b: "^2" }, devDependencies: { a: "^1", b: "^1" } };
    assert.equal(JSON.stringify(scan(m)), JSON.stringify(scan(m)));
  });
});
