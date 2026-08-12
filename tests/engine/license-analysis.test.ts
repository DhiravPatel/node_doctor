/**
 * §19 — license analysis, as a section of the supply-chain report.
 *
 * Everything here is a DECLARED fact read from a package's own manifest. The
 * report never says you are violating anything: whether an obligation binds you
 * depends on how you distribute, which a manifest cannot say. Same discipline as
 * §110's "declared AI assistance".
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSupplyChainReport } from "../../src/core/supply-chain.ts";

/** A project whose `node_modules` holds the given packages. */
const makeTree = async (packages: Record<string, Record<string, unknown>>, files: Record<string, string> = {}) => {
  const dir = await mkdtemp(join(tmpdir(), "nd-lic-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
  for (const [name, manifest] of Object.entries(packages)) {
    const pkgDir = join(dir, "node_modules", name);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
  }
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, "node_modules", rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
  }
  return dir;
};

const report = async (packages: Record<string, Record<string, unknown>>, files?: Record<string, string>) => {
  const dir = await makeTree(packages, files);
  try {
    return await buildSupplyChainReport(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("license analysis — the counts", () => {
  test("every declared expression is counted, most-used first", async () => {
    const r = await report({ a: { license: "MIT" }, b: { license: "MIT" }, c: { license: "ISC" } });
    assert.deepEqual(r.licenseCounts, [
      { license: "MIT", packages: 2 },
      { license: "ISC", packages: 1 },
    ]);
  });

  test("the deprecated `licenses` array form is still read", async () => {
    const r = await report({ old: { licenses: [{ type: "MIT" }] } });
    assert.deepEqual(r.licenseCounts, [{ license: "MIT", packages: 1 }]);
    assert.equal(r.undeclaredLicenses.length, 0);
  });
});

describe("license analysis — copyleft is an obligation, not a defect", () => {
  test("a strong-copyleft declaration is reported", async () => {
    const r = await report({ gpl: { license: "GPL-3.0-or-later" }, agpl: { license: "AGPL-3.0" } });
    assert.deepEqual(r.copyleftLicenses.map((l) => l.package), ["agpl", "gpl"]);
    assert.equal(r.summary.copyleftLicenses, 2);
  });

  test("LGPL counts — weaker than GPL, still not MIT", async () => {
    const r = await report({ lgpl: { license: "LGPL-3.0-or-later" } });
    assert.deepEqual(r.copyleftLicenses.map((l) => l.package), ["lgpl"]);
  });

  test("an `OR` is a CHOICE, so a dual license imposes nothing", async () => {
    // `jszip` really ships `(MIT OR GPL-3.0-or-later)`. You take the MIT branch
    // and owe nothing; reporting it as copyleft would simply be wrong. Found by
    // running this against a real dependency tree, not by construction.
    const r = await report({ jszip: { license: "(MIT OR GPL-3.0-or-later)" } });
    assert.deepEqual(r.copyleftLicenses, []);
  });

  test("but an OR whose every branch is copyleft still binds", async () => {
    const r = await report({ both: { license: "(GPL-3.0-only OR AGPL-3.0-only)" } });
    assert.deepEqual(r.copyleftLicenses.map((l) => l.package), ["both"]);
  });

  test("an `AND` applies every term, so one copyleft term is enough", async () => {
    const r = await report({ combo: { license: "MIT AND GPL-3.0-only" } });
    assert.deepEqual(r.copyleftLicenses.map((l) => l.package), ["combo"]);
  });

  test("permissive licenses are never copyleft", async () => {
    const r = await report({
      a: { license: "MIT" },
      b: { license: "Apache-2.0" },
      c: { license: "BSD-3-Clause" },
      d: { license: "ISC" },
      e: { license: "Unlicense" },
    });
    assert.deepEqual(r.copyleftLicenses, []);
  });
});

describe("license analysis — an absent field is not 'unlicensed'", () => {
  test("no field and no LICENSE file is the only case with nothing to read", async () => {
    const r = await report({ bare: {} });
    assert.deepEqual(r.undeclaredLicenses.map((l) => l.package), ["bare"]);
    assert.equal(r.summary.undeclaredLicenses, 1);
  });

  test("a LICENSE file the field never names is a documentation gap, not a legal unknown", async () => {
    const r = await report({ terms: {} }, { "terms/LICENSE": "MIT License\n\nCopyright…" });
    assert.deepEqual(r.undeclaredLicenses, []);
  });

  test("a PRIVATE package needs no license, by npm's own convention", async () => {
    // Almost always the workspace's own package rather than a dependency.
    const r = await report({ mine: { private: true } });
    assert.deepEqual(r.undeclaredLicenses, []);
  });
});

describe("license analysis — determinism", () => {
  test("identical trees yield identical output", async () => {
    const dir = await makeTree({ a: { license: "MIT" }, b: { license: "GPL-3.0-only" }, c: {} });
    try {
      const one = await buildSupplyChainReport(dir);
      const two = await buildSupplyChainReport(dir);
      assert.equal(JSON.stringify(one), JSON.stringify(two));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
