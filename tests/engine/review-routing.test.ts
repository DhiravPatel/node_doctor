/**
 * §163 — Blast-Radius-Aware Review Routing.
 *
 * The claim this makes is a review LEVEL, so the tests pin that it is a function
 * of counted graph facts (reach, handler-bearing dependents, hub status) and that
 * every escalation is explained. The other property that matters: a file the
 * graph cannot see is reported as *unknown* reach, never as safe.
 *
 * One escalation is deliberately NOT available: handler-bearing dependents are
 * matched by SHAPE, so they can never reach senior on their own (see below).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildReviewRouting } from "../../src/core/review-routing.ts";

const makeProject = async (files: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-review-"));
  await writeFile(join(dir, "package.json"), `{ "name": "r", "version": "1.0.0", "type": "module" }`);
  for (const [rel, src] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, src);
  }
  return dir;
};

/** A leaf nobody imports, and a hub 12 modules depend on. */
const PROJECT: Record<string, string> = {
  "src/leaf.js": `export const leaf = 1;`,
  "src/hub.js": `export const hub = 1;`,
  "src/routes/api.js": `import { hub } from "../hub.js";\napp.get("/x", (req, res) => res.json(hub));`,
};
for (let i = 0; i < 12; i++) {
  PROJECT[`src/m${i}.js`] = `import { hub } from "./hub.js";\nexport const m${i} = hub;`;
}

describe("buildReviewRouting — level follows reach", () => {
  test("a leaf with no dependents is a light review", async () => {
    const dir = await makeProject(PROJECT);
    try {
      const r = await buildReviewRouting(dir, [join(dir, "src/leaf.js")]);
      assert.equal(r.level, "light");
      assert.equal(r.reachedCount, 0);
      assert.deepEqual(r.hubsTouched, []);
      assert.ok(r.rationale.length > 0, "a level is always explained");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a widely-depended-on module escalates to senior, and says why", async () => {
    const dir = await makeProject(PROJECT);
    try {
      const r = await buildReviewRouting(dir, [join(dir, "src/hub.js")]);
      assert.equal(r.level, "senior");
      assert.ok(r.reachedCount >= 12, "every dependent is counted");
      assert.ok(
        r.rationale.some((x) => x.includes("reaches")),
        "the reach that drove the escalation is stated",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handler-bearing dependents are surfaced", async () => {
    const dir = await makeProject(PROJECT);
    try {
      const r = await buildReviewRouting(dir, [join(dir, "src/hub.js")]);
      assert.ok(
        r.handlerBearingFiles.includes("src/routes/api.js"),
        "a change to the hub can break this route, so its owner must see it",
      );
      assert.deepEqual(r.routesAtRisk, r.handlerBearingFiles, "the old field name still resolves");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildReviewRouting — a shape-matched signal cannot escalate to senior alone", () => {
  // `collectRequestHandlers` recognizes the `(req, res)` SHAPE, which a
  // middleware factory has as surely as a route does. Counting those and calling
  // ten of them a senior review escalates on a guess, and "senior review" is a
  // claim about someone's time. Reach and hub status are exact; they escalate.
  const middleware = (i: number) =>
    `import { core } from "./mid.js";
` +
    `export const wrap${i} = () => (req, res, next) => next(core);
`;

  /** core ← mid ← 12 handler-shaped modules. No single file has hub fan-in. */
  const INDIRECT: Record<string, string> = {
    "src/core.js": `export const core = 1;`,
    "src/mid.js": `import { core } from "./core.js";
export { core };`,
  };
  for (let i = 0; i < 12; i++) INDIRECT[`src/mw${i}.js`] = middleware(i);

  test("twelve handler-shaped dependents, modest reach, no hub → standard, not senior", async () => {
    const dir = await makeProject(INDIRECT);
    try {
      const r = await buildReviewRouting(dir, [join(dir, "src/core.js")]);
      assert.ok(r.handlerBearingFiles.length >= 10, "the signal is present in quantity");
      assert.deepEqual(r.hubsTouched, [], "no changed file has hub fan-in");
      assert.ok(r.reachedCount < 25, "reach alone does not reach the senior threshold");
      assert.equal(r.level, "standard", "a shape match is worth attention, not a senior reviewer");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the rationale says the signal is shape-matched rather than counted routes", async () => {
    const dir = await makeProject(INDIRECT);
    try {
      const r = await buildReviewRouting(dir, [join(dir, "src/core.js")]);
      assert.ok(
        r.rationale.some((x) => x.includes("handler-shaped")),
        "a reader can see what was actually measured",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reach still escalates to senior on its own", async () => {
    const wide: Record<string, string> = { "src/core.js": `export const core = 1;` };
    for (let i = 0; i < 30; i++) wide[`src/n${i}.js`] = `import { core } from "./core.js";\nexport const n${i} = core;`;
    const dir = await makeProject(wide);
    try {
      const r = await buildReviewRouting(dir, [join(dir, "src/core.js")]);
      assert.equal(r.level, "senior");
      assert.ok(r.rationale.some((x) => x.includes("reaches")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildReviewRouting — reviewers come from the whole blast radius", () => {
  test("owners of DOWNSTREAM files are included, not just the changed file's owner", async () => {
    const dir = await makeProject({
      ...PROJECT,
      CODEOWNERS: ["src/hub.js @core-team", "src/routes/ @api-team", "src/m1.js @platform"].join("\n"),
    });
    try {
      const r = await buildReviewRouting(dir, [join(dir, "src/hub.js")]);
      assert.deepEqual(r.directOwners, ["@core-team"], "the changed file's owner");
      assert.ok(r.reviewers.includes("@core-team"));
      assert.ok(r.reviewers.includes("@api-team"), "owns a route this change can break");
      assert.ok(r.reviewers.includes("@platform"), "owns a module this change can break");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no CODEOWNERS is not an error — the routing still reports reach", async () => {
    const dir = await makeProject(PROJECT);
    try {
      const r = await buildReviewRouting(dir, [join(dir, "src/hub.js")]);
      assert.deepEqual(r.reviewers, []);
      assert.ok(r.reachedCount > 0, "reach is independent of ownership data");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildReviewRouting — unknown reach is never reported as safe", () => {
  test("a file the graph does not contain is unresolved, and said so", async () => {
    const dir = await makeProject(PROJECT);
    try {
      const r = await buildReviewRouting(dir, [join(dir, "src/does-not-exist.js")]);
      assert.deepEqual(r.changed, []);
      assert.equal(r.unresolved.length, 1);
      assert.ok(
        r.rationale.some((x) => x.includes("not in the import graph")),
        '"I could not see this" must not look like "this is safe"',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildReviewRouting — determinism", () => {
  test("identical input yields identical output", async () => {
    const dir = await makeProject({
      ...PROJECT,
      CODEOWNERS: ["src/hub.js @core-team", "src/routes/ @api-team"].join("\n"),
    });
    try {
      const a = await buildReviewRouting(dir, [join(dir, "src/hub.js")]);
      const b = await buildReviewRouting(dir, [join(dir, "src/hub.js")]);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
      assert.deepEqual(a.reviewers, [...a.reviewers].sort(), "reviewers are sorted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
