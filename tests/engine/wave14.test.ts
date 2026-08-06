/**
 * Wave 14 — runtime awareness and organizational routing.
 *
 * §83 deprecated Node APIs · §85 modernization score · §94 Bun/Deno detection
 * §95 edge-runtime gating · §96 cross-package graph · §89/§90 CODEOWNERS + PR risk
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectFires, expectSilent, findingsFor } from "../helpers.ts";
import { fileURLToPath } from "node:url";
import { discoverProject } from "../../src/core/project.ts";
import { scanProject } from "../../src/core/scan.ts";
import { buildProjectGraph, type ModuleFacts } from "../../src/core/graph.ts";
import { scanWorkspaces } from "../../src/core/workspaces.ts";
import { buildModernizationReport } from "../../src/core/modernization.ts";
import { parseCodeowners, ownersFor, groupByOwner, loadCodeowners, scorePrRisk } from "../../src/core/ownership.ts";
import type { Finding } from "../../src/core/types.ts";

const workdir = async (): Promise<string> => mkdtemp(join(tmpdir(), "nd-w14-"));

// ---------------------------------------------------------------------------
// §83 — deprecated Node APIs
// ---------------------------------------------------------------------------

describe("no-deprecated-node-api", () => {
  test("fires on url.parse", () => {
    expectFires("no-deprecated-node-api", `import url from "node:url"; const u = url.parse(input);`);
  });

  test("fires on the require() and namespace forms", () => {
    expectFires("no-deprecated-node-api", `const url = require("url"); url.parse(input);`);
    expectFires("no-deprecated-node-api", `import * as util from "node:util"; util._extend({}, o);`);
  });

  // The receiver must resolve to a real Node built-in in THIS file. Matching on
  // the name alone reported Prisma's `db.domain.create()`, mem-fs's
  // `generator.fs.exists()`, the `url-parse` package, and every test mock — and
  // a false positive is a release blocker.
  test("silent when the receiver is not bound to the built-in", () => {
    const cases = [
      `const db = new PrismaClient(); db.domain.create({ data });`,
      `class S { add(d) { return this.domain.create(d); } }`,
      `import url from "url-parse"; url.parse(raw);`,
      `export const f = (generator, dest) => generator.fs.exists(dest);`,
      `import { fs } from "memfs"; fs.exists(p, cb);`,
      `const fs = { exists: jest.fn() }; fs.exists("/x", cb);`,
      `export const e = (opts) => opts.crypto.createCipher("aes192", k);`,
      `const x = a.b.url.parse(y);`,
      `const util = { isArray: (v) => Array.isArray(v) }; util.isArray(v);`,
    ];
    for (const src of cases) expectSilent("no-deprecated-node-api", src);
  });

  // An audit against Node's own `doc/api/deprecations.md` found this table
  // overstating four different ways. A fact table entry that overstates is a
  // false positive with a version number on it, so the STATUS is now pinned.
  test("an end-of-life API says REMOVED, and names the release that removed it", () => {
    const [f] = expectFires(
      "no-deprecated-node-api",
      `import crypto from "node:crypto"; crypto.createCipher("aes-256-cbc", secret);`,
    );
    assert.match(f!.message, /REMOVED in Node 22/);
    assert.match(f!.message, /DEP0106/);
    assert.match(f!.message, /throws, it does not warn/);
  });

  test("a runtime deprecation is NOT described as removed", () => {
    // `util.isArray` survived the Node 23 purge that took its siblings.
    const [f] = expectFires("no-deprecated-node-api", `import util from "node:util"; util.isArray(x);`);
    assert.match(f!.message, /runtime-deprecated since Node 22/);
    assert.doesNotMatch(f!.message, /REMOVED/);
  });

  test("a documentation-only deprecation promises no removal", () => {
    const [f] = expectFires("no-deprecated-node-api", `import fs from "node:fs"; fs.exists(p, cb);`);
    assert.match(f!.message, /no removal is scheduled/);
    assert.doesNotMatch(f!.message, /REMOVED/);
  });

  test("`new Buffer()` is not claimed to be removed — it never was", () => {
    const [f] = expectFires("no-deprecated-node-api", `const b = new Buffer(10);`);
    assert.match(f!.message, /DEP0005/);
    assert.doesNotMatch(f!.message, /removed/i, "Buffer() is alive on main; saying otherwise is a false claim");
  });

  test("the newly verified end-of-life entries fire", () => {
    for (const [src, expected] of [
      [`import util from "node:util"; util.isString(x);`, /REMOVED in Node 23/],
      [`import tls from "node:tls"; tls.createSecurePair(s);`, /REMOVED in Node 24/],
      [`import timers from "node:timers"; timers.enroll(o, 5);`, /REMOVED in Node 24/],
      [`import os from "node:os"; os.tmpDir();`, /REMOVED in Node 14/],
      [`import mod from "node:module"; mod.createRequireFromPath(p);`, /REMOVED in Node 16/],
      [`import nodeUtil from "node:util"; nodeUtil.isString(x);`, /REMOVED in Node 23/],
      [`import net from "node:net"; net._setSimultaneousAccepts(true);`, /REMOVED in Node 24/],
    ] as Array<[string, RegExp]>) {
      const [f] = expectFires("no-deprecated-node-api", src);
      assert.match(f!.message, expected, src);
    }
  });

  test("the new receivers still require a real built-in binding", () => {
    for (const src of [
      `import tls from "./my-tls.ts"; tls.createSecurePair(s);`,
      `const timers = makeTimers(); timers.enroll(o, 5);`,
      `export const f = (net) => net._setSimultaneousAccepts(true);`,
    ]) {
      expectSilent("no-deprecated-node-api", src);
    }
  });

  test("silent when Buffer is a local class, import, or parameter", () => {
    expectSilent("no-deprecated-node-api", `class Buffer { constructor(n) { this.n = n; } }\nexport const r = (n) => new Buffer(n);`);
    expectSilent("no-deprecated-node-api", `const { Buffer } = require("./ring");\nexport const r = new Buffer(1024);`);
    expectSilent("no-deprecated-node-api", `export function build(Buffer) { return new Buffer(16); }`);
    expectSilent("no-deprecated-node-api", `import Buffer from "three/src/Buffer.js";\nexport const b = new Buffer(8);`);
  });

  test("fires on new Buffer(size) — the API with a documented security history", () => {
    const found = expectFires("no-deprecated-node-api", `const b = new Buffer(64);`);
    assert.match(found[0]!.message, /Buffer/);
  });

  test("fires on crypto.createCipher (no IV — not the same as createCipheriv)", () => {
    expectFires("no-deprecated-node-api", `import crypto from "node:crypto"; const c = crypto.createCipher("aes192", pw);`);
  });

  test("fires on fs.exists, whose callback signature is famously wrong", () => {
    expectFires("no-deprecated-node-api", `import fs from "node:fs"; fs.exists(p, (e) => {});`);
  });

  test("silent on the modern replacements", () => {
    expectSilent(
      "no-deprecated-node-api",
      `import crypto from "node:crypto";
       import fs from "node:fs";
       const u = new URL(input);
       const b = Buffer.alloc(64);
       const c = crypto.createCipheriv("aes-256-gcm", key, iv);
       fs.access(p, (e) => {});`,
    );
  });

  test("silent on same-named methods on unrelated objects", () => {
    // `router.parse` and `queue.exists` are not the Node builtins.
    expectSilent("no-deprecated-node-api", `router.parse(x); queue.exists(k); myUtil.isArray(v);`);
  });

  test("silent on Buffer.from — a call, not a construction", () => {
    expectSilent("no-deprecated-node-api", `const b = Buffer.from("hi", "utf8");`);
  });
});

// ---------------------------------------------------------------------------
// §95 — edge runtime
// ---------------------------------------------------------------------------

describe("no-node-builtin-on-edge", () => {
  const src = `import cp from "node:child_process"; export default () => cp.execSync("ls");`;
  const EDGE = { capabilities: ["node", "esm", "edge"] };

  test("fires when the project targets an edge runtime", () => {
    expectFires("no-node-builtin-on-edge", src, EDGE);
  });

  test("stays silent on a plain Node project — the whole point of the gate", () => {
    expectSilent("no-node-builtin-on-edge", src, { capabilities: ["node", "esm"] });
  });

  test("catches the require() form too", () => {
    expectFires("no-node-builtin-on-edge", `const cp = require("child_process");`, {
      capabilities: ["node", "cjs", "edge"],
    });
  });

  // Cloudflare's `nodejs_compat` ships these, and the documented Hyperdrive
  // pattern is literally `import net from "node:net"`. Flagging them at
  // error/high-confidence asserts a fact we never observed (the compat flags
  // live in wrangler.toml, which we only stat()).
  test("silent on builtins edge runtimes DO provide under nodejs_compat", () => {
    expectSilent(
      "no-node-builtin-on-edge",
      `import net from "node:net";
       import tls from "node:tls";
       import os from "node:os";
       import http from "node:http";
       import fs from "node:fs";
       import { Buffer } from "node:buffer";
       import url from "node:url";`,
      EDGE,
    );
  });

  test("silent on a type-only import — erased at compile time, never bundled", () => {
    expectSilent("no-node-builtin-on-edge", `import type { ChildProcess } from "node:child_process";`, EDGE);
  });

  test("still fires on an inline type import — verbatimModuleSyntax emits a real load", () => {
    expectFires("no-node-builtin-on-edge", `import { type ChildProcess } from "node:child_process";`, EDGE);
  });

  test("silent in build tooling, which runs under Node even in a Worker repo", () => {
    for (const path of ["scripts/build.mjs", "tools/gen.ts", "vite.config.ts", "build/x.js", "jest.config.js"]) {
      expectSilent("no-node-builtin-on-edge", src, { ...EDGE, filePath: path });
    }
  });

  test("still fires in the worker source itself", () => {
    expectFires("no-node-builtin-on-edge", src, { ...EDGE, filePath: "src/worker.js" });
  });
});

// ---------------------------------------------------------------------------
// §94 — Bun / Deno / edge detection
// ---------------------------------------------------------------------------

describe("runtime detection", () => {
  test("bun.lockb marks the project as Bun", async () => {
    const dir = await workdir();
    try {
      await writeFile(join(dir, "package.json"), `{"name":"b"}`);
      await writeFile(join(dir, "bun.lockb"), "");
      assert.ok((await discoverProject(dir)).capabilities.has("bun"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("deno.json marks the project as Deno", async () => {
    const dir = await workdir();
    try {
      await writeFile(join(dir, "deno.json"), `{}`);
      assert.ok((await discoverProject(dir)).capabilities.has("deno"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("wrangler.toml marks the project as edge", async () => {
    const dir = await workdir();
    try {
      await writeFile(join(dir, "package.json"), `{"name":"w"}`);
      await writeFile(join(dir, "wrangler.toml"), `name = "w"\n`);
      assert.ok((await discoverProject(dir)).capabilities.has("edge"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a @vercel/edge dependency marks the project as edge", async () => {
    const dir = await workdir();
    try {
      await writeFile(join(dir, "package.json"), `{"name":"v","dependencies":{"@vercel/edge":"^1.0.0"}}`);
      assert.ok((await discoverProject(dir)).capabilities.has("edge"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a plain Node project claims none of them", async () => {
    const dir = await workdir();
    try {
      await writeFile(join(dir, "package.json"), `{"name":"p","dependencies":{"express":"^4.18.2"}}`);
      const caps = (await discoverProject(dir)).capabilities;
      assert.equal(caps.has("bun"), false);
      assert.equal(caps.has("deno"), false);
      assert.equal(caps.has("edge"), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// §85 — modernization score
// ---------------------------------------------------------------------------

const legacyFinding = (diagnostic: string): Finding =>
  ({ diagnostic, title: diagnostic, tags: ["modernization"] }) as unknown as Finding;

describe("modernization score", () => {
  test("a clean, supported project scores current", () => {
    const r = buildModernizationReport([], ["node", "node:22"], 1000);
    assert.equal(r.score, 100);
    assert.equal(r.label, "current");
    assert.equal(r.declaredNodeMajor, 22);
  });

  test("an end-of-life engines.node costs 25 points and says why", () => {
    const r = buildModernizationReport([], ["node", "node:16"], 1000);
    assert.equal(r.score, 75);
    assert.equal(r.label, "aging");
    assert.match(r.notes.join(" "), /end-of-life/);
  });

  test("scores by density, so a big codebase is not punished for being big", () => {
    const ten = Array.from({ length: 10 }, () => legacyFinding("no-deprecated-node-api"));
    const small = buildModernizationReport(ten, ["node:22"], 1_000);
    const large = buildModernizationReport(ten, ["node:22"], 100_000);
    assert.ok(large.score > small.score, "same count, more code → less debt per kLOC");
  });

  test("signals are ranked by frequency and are deterministic", () => {
    const findings = [
      legacyFinding("b-rule"),
      legacyFinding("a-rule"),
      legacyFinding("a-rule"),
    ];
    const r = buildModernizationReport(findings, ["node:22"], 500);
    assert.deepEqual(
      r.signals.map((s) => s.diagnostic),
      ["a-rule", "b-rule"],
    );
  });

  test("a missing engines.node is called out rather than assumed", () => {
    const r = buildModernizationReport([], ["node"], 1000);
    assert.equal(r.declaredNodeMajor, null);
    assert.match(r.notes.join(" "), /engines\.node/);
  });

  test("non-modernization findings do not move the score", () => {
    const bug = { diagnostic: "no-eval", title: "x", tags: ["security"] } as unknown as Finding;
    assert.equal(buildModernizationReport([bug], ["node:22"], 100).score, 100);
  });
});

// ---------------------------------------------------------------------------
// §89 — CODEOWNERS
// ---------------------------------------------------------------------------

describe("CODEOWNERS", () => {
  const RULES = parseCodeowners(
    [
      "# comment",
      "*            @org/platform",
      "/src/api/    @org/api-team",
      "src/db/**    @org/data",
      "*.md         @org/docs",
      "",
    ].join("\n"),
  );

  test("ignores comments and blank lines", () => {
    assert.equal(RULES.length, 4);
  });

  test("the LAST matching rule wins, as GitHub does it", () => {
    assert.deepEqual(ownersFor("src/api/routes.ts", RULES), ["@org/api-team"]);
    assert.deepEqual(ownersFor("src/db/pool.ts", RULES), ["@org/data"]);
    assert.deepEqual(ownersFor("README.md", RULES), ["@org/docs"]);
    assert.deepEqual(ownersFor("src/util.ts", RULES), ["@org/platform"]);
  });

  // GitHub documents `docs/*` as matching docs/getting-started.md but NOT
  // docs/build-app/troubleshooting.md. Recursing there makes the ubiquitous
  // `packages/*` swallow every subtree and outrank the catch-all that should win.
  test("a rule ending in a glob does NOT recurse", () => {
    const rules = parseCodeowners("* @org/platform\ndocs/* @org/docs\npackages/* @org/pkg");
    assert.deepEqual(ownersFor("docs/getting-started.md", rules), ["@org/docs"]);
    assert.deepEqual(ownersFor("docs/build-app/trouble.md", rules), ["@org/platform"]);
    assert.deepEqual(ownersFor("packages/a/src/deep/bad.ts", rules), ["@org/platform"]);
  });

  // gitignore/GitHub: "a/**/b matches a/b, a/x/b, a/x/y/b".
  test("** matches ZERO directories as well as many", () => {
    assert.deepEqual(ownersFor("src/index.ts", parseCodeowners("src/**/*.ts @deep")), ["@deep"]);
    assert.deepEqual(ownersFor("src/a/b/c.ts", parseCodeowners("src/**/*.ts @deep")), ["@deep"]);
    assert.deepEqual(ownersFor("a/b", parseCodeowners("a/**/b @t")), ["@t"]);
    assert.deepEqual(ownersFor("foo/x.ts", parseCodeowners("**/foo @t")), ["@t"]);
  });

  test("zero-directory ** does not invert last-match-wins", () => {
    const rules = parseCodeowners("src/*.ts @flat\nsrc/**/*.ts @deep");
    assert.deepEqual(ownersFor("src/index.ts", rules), ["@deep"]);
  });

  test("a malformed pattern never throws — a crash mid-scan is worse than a miss", () => {
    for (const pat of ["src/[a.ts", "foo(bar", "a{b", "x\\", "a]b", "q+e", "^st"]) {
      assert.doesNotThrow(() => ownersFor("src/whatever.ts", parseCodeowners(`${pat} @t`)), `pattern: ${pat}`);
    }
  });

  test("an inline comment after owners is not parsed as an owner", () => {
    assert.deepEqual(parseCodeowners("* @team # because reasons")[0]!.owners, ["@team"]);
  });

  // A CODEOWNERS file authored on Windows arrives with CRLF endings. JavaScript's
  // `.` does not match `\r`, so a comment-stripping `#.*$` cannot reach the end of
  // such a line — the comment survived, and every `@handle` mentioned inside it
  // became a real owner. Splitting on both endings is the fix.
  test("CRLF line endings do not smuggle commented-out handles in as owners", () => {
    const rules = parseCodeowners("* @fallback\r\nsrc/** @core # was @legacy, do not ping them\r\n");
    assert.deepEqual(rules[1]!.owners, ["@core"], "the handle inside the comment is not an owner");
    assert.deepEqual(ownersFor("src/a.ts", rules), ["@core"]);
    assert.deepEqual(ownersFor("README.md", rules), ["@fallback"], "the CRLF pattern itself still matches");
  });

  test("a CRLF file with a full-line comment parses like its LF twin", () => {
    const crlf = parseCodeowners("# owners\r\n\r\nsrc/db/** @data\r\n");
    const lf = parseCodeowners("# owners\n\nsrc/db/** @data\n");
    assert.deepEqual(crlf, lf);
  });

  test("a leading slash anchors to the repo root", () => {
    const anchored = parseCodeowners("/build/ @team");
    assert.deepEqual(ownersFor("build/out.js", anchored), ["@team"]);
    assert.deepEqual(ownersFor("packages/x/build/out.js", anchored), []);
  });

  test("* does not cross a path separator but ** does", () => {
    const rules = parseCodeowners("src/*.ts @flat\nsrc/**/*.ts @deep");
    assert.deepEqual(ownersFor("src/a.ts", parseCodeowners("src/*.ts @flat")), ["@flat"]);
    assert.deepEqual(ownersFor("src/nested/a.ts", parseCodeowners("src/*.ts @flat")), []);
    assert.deepEqual(ownersFor("src/nested/a.ts", rules), ["@deep"]);
  });

  test("a rule with no owners deliberately clears ownership", () => {
    const rules = parseCodeowners("* @org/platform\nsrc/generated/**");
    assert.deepEqual(ownersFor("src/generated/api.ts", rules), []);
  });

  test("unowned findings are grouped, never dropped", () => {
    const f = (p: string): Finding => ({ normalizedFilePath: p }) as unknown as Finding;
    const groups = groupByOwner([f("src/api/a.ts"), f("scripts/x.ts")], parseCodeowners("/src/api/ @org/api-team"));
    const owners = groups.map((g) => g.owner).sort();
    assert.deepEqual(owners, ["(unowned)", "@org/api-team"]);
    assert.equal(groups.reduce((n, g) => n + g.findings.length, 0), 2);
  });

  test("loadCodeowners reads .github/CODEOWNERS and returns [] when absent", async () => {
    const dir = await workdir();
    try {
      assert.deepEqual(await loadCodeowners(dir), []);
      await mkdir(join(dir, ".github"), { recursive: true });
      await writeFile(join(dir, ".github", "CODEOWNERS"), "* @org/all\n");
      assert.deepEqual(await loadCodeowners(dir), [{ pattern: "*", owners: ["@org/all"] }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// §90 — PR risk
// ---------------------------------------------------------------------------

const finding = (over: Partial<Finding>): Finding =>
  ({ severity: "warn", category: "Reliability", confidence: "medium", ...over }) as unknown as Finding;

describe("PR risk score", () => {
  test("a clean diff is low risk and says so plainly", () => {
    const risk = scorePrRisk([], 3);
    assert.equal(risk.level, "low");
    assert.deepEqual(risk.reasons, ["no findings introduced"]);
  });

  test("any introduced security finding is severe regardless of count", () => {
    const risk = scorePrRisk([finding({ category: "Security", severity: "error" })], 1);
    assert.equal(risk.level, "severe");
    assert.match(risk.reasons[0]!, /security/);
  });

  test("breadth raises risk on its own but is capped", () => {
    const wide = scorePrRisk([], 200);
    assert.equal(wide.filesTouched, 200);
    assert.ok(wide.score <= 10, "breadth alone cannot dominate the score");
    assert.match(wide.reasons.join(" "), /broad surface/);
  });

  test("error severity outweighs warn severity for the same category", () => {
    const err = scorePrRisk([finding({ severity: "error" })], 1).score;
    const warn = scorePrRisk([finding({ severity: "warn" })], 1).score;
    assert.ok(err > warn);
  });

  test("the score is reported to one decimal, so it is stable in CI output", () => {
    const risk = scorePrRisk([finding({})], 7);
    assert.equal(risk.score, Math.round(risk.score * 10) / 10);
  });

  // The score already includes these findings, so "no findings introduced" beside
  // a non-zero number is a self-contradiction the reader has to resolve.
  test("the fallback reason describes the diff rather than denying it", () => {
    const risk = scorePrRisk([finding({}), finding({})], 2);
    assert.ok(risk.score > 0);
    assert.deepEqual(risk.reasons, ["2 finding(s) introduced"]);
    assert.deepEqual(scorePrRisk([], 2).reasons, ["no findings introduced"]);
  });

  test("an unrecognized category never yields NaN — a silent \"low\" would be worse than a wrong number", () => {
    const risk = scorePrRisk([finding({ category: "Nonsense" as never, severity: "error" })], 2);
    assert.ok(Number.isFinite(risk.score));
    assert.notEqual(risk.level, "low");
  });
});

// ---------------------------------------------------------------------------
// §96 — cross-package graph
// ---------------------------------------------------------------------------

/** apps/api → @acme/db, with the blocking read living in the library. */
const buildWorkspace = async (importSibling: boolean): Promise<string> => {
  const dir = await workdir();
  await mkdir(join(dir, "apps", "api", "src"), { recursive: true });
  await mkdir(join(dir, "packages", "db", "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), `{"name":"root","private":true,"workspaces":["apps/*","packages/*"]}`);
  await writeFile(join(dir, "apps", "api", "package.json"), `{"name":"@acme/api","type":"module","dependencies":{"express":"^4.18.2"}}`);
  await writeFile(join(dir, "packages", "db", "package.json"), `{"name":"@acme/db","type":"module"}`);
  await writeFile(
    join(dir, "apps", "api", "src", "routes.js"),
    [
      `import express from "express";`,
      importSibling ? `import { warm } from "@acme/db";` : ``,
      `const app = express();`,
      `app.get("/warm", (req, res) => { res.send(${importSibling ? "warm()" : `"ok"`}); });`,
      `export default app;`,
    ].join("\n"),
  );
  await writeFile(
    join(dir, "packages", "db", "src", "index.js"),
    `import fs from "node:fs";\nexport function warm() { return fs.readFileSync("./cache.json", "utf8"); }\n`,
  );
  return dir;
};

const dbFindings = (report: Awaited<ReturnType<typeof scanWorkspaces>>): Finding[] =>
  report.projects.find((p) => p.name === "@acme/db")!.report.findings;

describe("cross-package reachability (§96)", () => {
  test("a handler in apps/api makes a sync read in packages/db a finding", async () => {
    const dir = await buildWorkspace(true);
    try {
      const report = await scanWorkspaces(dir);
      const hits = dbFindings(report).filter((f) => f.diagnostic === "no-sync-io-reachable-from-handler");
      assert.equal(hits.length, 1, "the cross-package request path must be followed");
      assert.equal(hits[0]!.normalizedFilePath, "src/index.js", "attributed to the package that contains the code");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the same library is silent when nothing imports it — no blanket flagging", async () => {
    const dir = await buildWorkspace(false);
    try {
      const report = await scanWorkspaces(dir);
      assert.equal(dbFindings(report).length, 0);
      assert.equal(report.totalFindings, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the cross-package finding is not double-counted", async () => {
    const dir = await buildWorkspace(true);
    try {
      const report = await scanWorkspaces(dir);
      const keys = dbFindings(report).map((f) => f.evidenceKey);
      assert.equal(new Set(keys).size, keys.length, "dedup by evidenceKey must hold");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the workspace score reflects the cross-package finding", async () => {
    const dir = await buildWorkspace(true);
    try {
      const report = await scanWorkspaces(dir);
      assert.equal(report.worstProject, "@acme/db");
      assert.ok(report.score.score < 100, "a re-scored member must move the worst-of headline");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("repeated scans are byte-identical", async () => {
    const dir = await buildWorkspace(true);
    try {
      const a = await scanWorkspaces(dir);
      const b = await scanWorkspaces(dir);
      assert.equal(JSON.stringify(dbFindings(a)), JSON.stringify(dbFindings(b)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * TWO consumers, deliberately. With one, only a single hop trail is possible and
   * a determinism assertion passes vacuously. The member pool completes in I/O
   * order, so whichever consumer finished first used to own the taint hop trail
   * that gets baked into the message and hashed into `evidenceKey` — making the
   * same tree produce different keys run to run, which CI reads as a finding
   * introduced and resolved on a commit that touched nothing.
   */
  const buildTwoConsumers = async (): Promise<string> => {
    const dir = await workdir();
    await mkdir(join(dir, "packages", "db", "src"), { recursive: true });
    await writeFile(join(dir, "package.json"), `{"name":"root","private":true,"workspaces":["apps/*","packages/*"]}`);
    for (const app of ["aaa", "zzz"]) {
      await mkdir(join(dir, "apps", app, "src"), { recursive: true });
      await writeFile(join(dir, "apps", app, "package.json"), `{"name":"@acme/${app}","type":"module","dependencies":{"express":"^4.18.2"}}`);
      await writeFile(
        join(dir, "apps", app, "src", "routes.js"),
        `import express from "express";\nimport { lookup } from "@acme/db";\nconst app = express();\napp.get("/u", (req, res) => { res.send(lookup(req.query.name)); });\nexport default app;\n`,
      );
    }
    await writeFile(join(dir, "packages", "db", "package.json"), `{"name":"@acme/db","type":"module"}`);
    await writeFile(
      join(dir, "packages", "db", "src", "index.js"),
      "import { pool } from \"./pool.js\";\nexport function lookup(name) {\n  return pool.query(`SELECT * FROM users WHERE name = '${name}'`);\n}\n",
    );
    await writeFile(join(dir, "packages", "db", "src", "pool.js"), `export const pool = { query: (s) => s };\n`);
    return dir;
  };

  test("two competing consumers still produce byte-identical output", async () => {
    const dir = await buildTwoConsumers();
    try {
      const keys = new Set<string>();
      for (let i = 0; i < 6; i++) {
        const report = await scanWorkspaces(dir);
        keys.add(JSON.stringify(dbFindings(report).map((f) => [f.evidenceKey, f.id, f.message])));
      }
      assert.equal(keys.size, 1, "the member pool's completion order must not reach the output");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // evidenceKey is deliberately position-independent, so two byte-identical
  // boilerplate sites in one package collide and the second is dropped.
  test("two identical sites in one package are both reported", async () => {
    const dir = await buildWorkspace(true);
    try {
      await writeFile(
        join(dir, "packages", "db", "src", "index.js"),
        `import fs from "node:fs";\nexport function warm() { return fs.readFileSync("./cache.json", "utf8"); }\nexport function localOnly() { return fs.readFileSync("./cache.json", "utf8"); }\n`,
      );
      await writeFile(
        join(dir, "packages", "db", "src", "local.js"),
        `import express from "express";\nimport { localOnly } from "./index.js";\nconst app = express();\napp.get("/l", (req, res) => { res.send(localOnly()); });\nexport default app;\n`,
      );
      await writeFile(join(dir, "packages", "db", "package.json"), `{"name":"@acme/db","type":"module","dependencies":{"express":"^4.18.2"}}`);
      const report = await scanWorkspaces(dir);
      const hits = dbFindings(report).filter((f) => f.diagnostic === "no-sync-io-reachable-from-handler");
      assert.equal(hits.length, 2, "the cross-package site must not be swallowed by an evidenceKey collision");
      assert.equal(new Set(hits.map((f) => f.evidenceKey)).size, 1, "…precisely because the keys DO collide");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The cache fast path returns no ModuleFacts, so a warm run used to hand the
  // workspace pass an empty fact list and silently flip a CI gate from fail to pass.
  test("--cache does not lose cross-package findings on a warm run", async () => {
    const dir = await buildWorkspace(true);
    try {
      const cold = await scanWorkspaces(dir, { cache: true });
      const warm = await scanWorkspaces(dir, { cache: true });
      assert.equal(dbFindings(cold).length, 1);
      assert.equal(dbFindings(warm).length, 1, "a cache hit must not swallow the facts the pass needs");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a bare specifier that is not a workspace member still resolves to nothing", async () => {
    const dir = await buildWorkspace(true);
    try {
      // `lodash` names no member; it must not accidentally match `@acme/db`.
      await writeFile(
        join(dir, "apps", "api", "src", "extra.js"),
        `import { chunk } from "lodash";\nexport const go = () => chunk([1, 2, 3], 2);\n`,
      );
      const report = await scanWorkspaces(dir);
      assert.equal(dbFindings(report).length, 1, "unrelated bare imports add nothing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Phase B cost — the whole-project site collections must be computed once
// ---------------------------------------------------------------------------

describe("project graph memoization", () => {
  // Phase B calls these once per file. Recomputing a whole-project AST walk each
  // time is O(files x project): it cost 17s on a 427-file package before this was
  // memoized, and made a 4,000-file monorepo effectively unscannable. Identity
  // equality is the cheap, non-flaky way to assert the walk happened once.
  test("taintedSinkSites() and reachableSyncIoSites() are computed once per graph", async () => {
    const crossfile = fileURLToPath(new URL("../fixtures/crossfile", import.meta.url));
    let facts: ModuleFacts[] = [];
    await scanProject({ rootDirectory: crossfile, onModuleFacts: (f) => (facts = f) });
    assert.ok(facts.length > 0, "the fixture must produce module facts");

    const graph = buildProjectGraph(facts);
    assert.equal(graph.taintedSinkSites(), graph.taintedSinkSites(), "taint sites recomputed");
    assert.equal(graph.reachableSyncIoSites(), graph.reachableSyncIoSites(), "sync-IO sites recomputed");
  });
});

// ---------------------------------------------------------------------------
// Registry hygiene — a new diagnostic that isn't registered is invisible
// ---------------------------------------------------------------------------

describe("wave 14 registry", () => {
  test("the new diagnostics are addressable by id", () => {
    assert.deepEqual(findingsFor("no-deprecated-node-api", `const x = 1;`), []);
    assert.deepEqual(findingsFor("no-node-builtin-on-edge", `const x = 1;`), []);
  });
});

// ---------------------------------------------------------------------------
// Large --json through a PIPE must not truncate
// ---------------------------------------------------------------------------

describe("stdout flush", () => {
  /**
   * stdout is asynchronous when it is a pipe, so `process.exit()` straight after
   * writing discards whatever is still buffered. A 400 KB `--json` report came out
   * as exactly 65536 or 131072 bytes — a pipe-buffer boundary — so
   * `node-doctor . --json | jq` failed on invalid JSON while the same run
   * redirected to a file was complete. Spawned for real: the bug only exists when
   * stdout is a pipe, so an in-process test cannot see it.
   */
  test("a report larger than the pipe buffer survives being piped", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);

    const dir = await workdir();
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "package.json"), `{"name":"big","type":"module","dependencies":{"express":"^4.18.2"}}`);
      // Enough distinct findings to push the JSON past 64 KB.
      for (let i = 0; i < 120; i++) {
        await writeFile(
          join(dir, "src", `r${i}.js`),
          `import express from "express";\nconst app = express();\napp.get("/p${i}", (req, res) => { res.send(eval(req.query.c${i})); });\nexport default app;\n`,
        );
      }
      const bin = fileURLToPath(new URL("../../bin/node-doctor.js", import.meta.url));
      const { stdout } = await run(process.execPath, [bin, dir, "--json"], {
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1" },
      }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));

      assert.ok(stdout.length > 65536, `report must exceed one pipe buffer (got ${stdout.length})`);
      assert.doesNotThrow(() => JSON.parse(stdout), "piped --json must be complete, parseable JSON");
      assert.equal(JSON.parse(stdout).findings.length > 0, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
