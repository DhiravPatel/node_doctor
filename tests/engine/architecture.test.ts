/**
 * §33 — Architecture Analysis.
 *
 * Covers exact cycle detection (2-node, longer, self-loop, disjoint), layer
 * violation classification (upward import vs layer skip), the refusal to judge
 * unlayered or ambiguously-layered files, hub reporting, and determinism.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildArchitectureReport, type ArchitectureReport } from "../../src/core/architecture.ts";

const makeProject = async (files: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-arch-"));
  await writeFile(join(dir, "package.json"), `{ "name": "arch", "version": "1.0.0", "type": "module" }`);
  for (const [rel, src] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, src);
  }
  return dir;
};

const build = async (files: Record<string, string>): Promise<ArchitectureReport> => {
  const dir = await makeProject(files);
  try {
    return await buildArchitectureReport(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("buildArchitectureReport — import cycles", () => {
  test("a two-module cycle is found exactly", async () => {
    const r = await build({
      "src/a.js": `import { b } from "./b.js";\nexport const a = () => b();`,
      "src/b.js": `import { a } from "./a.js";\nexport const b = () => a();`,
    });
    assert.equal(r.cycles.length, 1);
    assert.deepEqual(r.cycles[0]!.files, ["src/a.js", "src/b.js"]);
    assert.equal(r.cycles[0]!.length, 2);
  });

  test("a three-module cycle is found as one component", async () => {
    const r = await build({
      "src/a.js": `import { b } from "./b.js";\nexport const a = () => b();`,
      "src/b.js": `import { c } from "./c.js";\nexport const b = () => c();`,
      "src/c.js": `import { a } from "./a.js";\nexport const c = () => a();`,
    });
    assert.equal(r.cycles.length, 1);
    assert.deepEqual(r.cycles[0]!.files, ["src/a.js", "src/b.js", "src/c.js"]);
  });

  test("two disjoint cycles are reported separately, longest first", async () => {
    const r = await build({
      "src/a.js": `import { b } from "./b.js";\nexport const a = 1;`,
      "src/b.js": `import { a } from "./a.js";\nexport const b = 1;`,
      "src/x.js": `import { y } from "./y.js";\nexport const x = 1;`,
      "src/y.js": `import { z } from "./z.js";\nexport const y = 1;`,
      "src/z.js": `import { x } from "./x.js";\nexport const z = 1;`,
    });
    assert.equal(r.cycles.length, 2);
    assert.equal(r.cycles[0]!.length, 3, "longest cycle first");
    assert.equal(r.cycles[1]!.length, 2);
  });

  test("an acyclic graph reports no cycles", async () => {
    const r = await build({
      "src/a.js": `import { b } from "./b.js";\nexport const a = 1;`,
      "src/b.js": `import { c } from "./c.js";\nexport const b = 1;`,
      "src/c.js": `export const c = 1;`,
    });
    assert.deepEqual(r.cycles, []);
    assert.equal(r.summary.cycles, 0);
  });

  test("a diamond (shared dependency, no cycle) is not a cycle", async () => {
    const r = await build({
      "src/top.js": `import { l } from "./left.js";\nimport { r } from "./right.js";\nexport const t = 1;`,
      "src/left.js": `import { base } from "./base.js";\nexport const l = 1;`,
      "src/right.js": `import { base } from "./base.js";\nexport const r = 1;`,
      "src/base.js": `export const base = 1;`,
    });
    assert.deepEqual(r.cycles, []);
  });
});

describe("buildArchitectureReport — layer violations", () => {
  const LAYERED = {
    "src/routes/user.js": `import { getUser } from "../services/user.js";\nexport const handler = () => getUser();`,
    "src/services/user.js": `import { findUser } from "../repositories/user.js";\nexport const getUser = () => findUser();`,
    "src/repositories/user.js": `export const findUser = () => ({});`,
  };

  test("a correctly-layered project reports no violations", async () => {
    const r = await build(LAYERED);
    assert.deepEqual(r.layerViolations, []);
  });

  test("a service importing back up into routes is an upward import", async () => {
    const r = await build({
      ...LAYERED,
      "src/services/audit.js": `import { handler } from "../routes/user.js";\nexport const audit = () => handler();`,
    });
    const v = r.layerViolations.find((x) => x.from === "src/services/audit.js")!;
    assert.equal(v.kind, "upward-import");
    assert.equal(v.fromLayer, "service");
    assert.equal(v.toLayer, "route");
  });

  test("a route reaching straight into a repository is a layer skip", async () => {
    const r = await build({
      ...LAYERED,
      "src/routes/raw.js": `import { findUser } from "../repositories/user.js";\nexport const raw = () => findUser();`,
    });
    const v = r.layerViolations.find((x) => x.from === "src/routes/raw.js")!;
    assert.equal(v.kind, "layer-skip");
    assert.equal(v.toLayer, "repository");
  });

  test("files outside a recognized layer take part in no violation", async () => {
    const r = await build({
      "src/utils/format.js": `import { thing } from "../helpers/thing.js";\nexport const f = 1;`,
      "src/helpers/thing.js": `export const thing = 1;`,
    });
    assert.deepEqual(r.layerViolations, []);
    assert.equal(r.summary.unlayeredModules, 2);
  });

  test("an ambiguous path (two layer segments) is not classified", async () => {
    // `src/services/db/pool.js` names both a service and an infrastructure
    // segment — too uncertain to hang a violation on.
    const r = await build({
      "src/services/db/pool.js": `import { h } from "../../routes/user.js";\nexport const p = 1;`,
      "src/routes/user.js": `export const h = 1;`,
    });
    assert.deepEqual(r.layerViolations, [], "an ambiguous layer never produces a confident claim");
  });

  test("a project with no layered convention produces no violations at all", async () => {
    const r = await build({
      "src/one.js": `import { two } from "./two.js";\nexport const one = 1;`,
      "src/two.js": `export const two = 1;`,
    });
    assert.deepEqual(r.layerViolations, []);
  });
});

describe("buildArchitectureReport — hubs + summary", () => {
  test("a widely-imported module is reported as a hub", async () => {
    const files: Record<string, string> = { "src/hub.js": `export const hub = 1;` };
    for (let i = 0; i < 12; i++) {
      files[`src/m${i}.js`] = `import { hub } from "./hub.js";\nexport const m${i} = 1;`;
    }
    const r = await build(files);
    const hub = r.hubs.find((h) => h.file === "src/hub.js");
    assert.ok(hub, "expected src/hub.js to be a hub");
    assert.equal(hub!.dependents, 12);
  });

  test("a module under the hub threshold is not reported", async () => {
    const files: Record<string, string> = { "src/small.js": `export const s = 1;` };
    for (let i = 0; i < 3; i++) {
      files[`src/m${i}.js`] = `import { s } from "./small.js";\nexport const m${i} = 1;`;
    }
    const r = await build(files);
    assert.deepEqual(r.hubs, []);
  });

  test("summary counts modules, edges and findings", async () => {
    const r = await build({
      "src/a.js": `import { b } from "./b.js";\nexport const a = 1;`,
      "src/b.js": `import { a } from "./a.js";\nexport const b = 1;`,
    });
    assert.equal(r.summary.modules, 2);
    assert.equal(r.summary.edges, 2);
    assert.equal(r.summary.cycles, 1);
    assert.equal(r.summary.layerViolations, 0);
  });
});

describe("buildArchitectureReport — determinism", () => {
  test("identical input yields byte-identical JSON across runs", async () => {
    const dir = await makeProject({
      "src/routes/a.js": `import { s } from "../services/s.js";\nimport { r } from "../repositories/r.js";\nexport const a = 1;`,
      "src/services/s.js": `import { r } from "../repositories/r.js";\nexport const s = 1;`,
      "src/repositories/r.js": `export const r = 1;`,
    });
    try {
      const a = await buildArchitectureReport(dir);
      const b = await buildArchitectureReport(dir);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
