import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  CONVENTION_TARGETS,
  generateConventions,
  writeConventions,
} from "../../src/core/conventions.ts";
import { capabilitiesSatisfied, detectCapabilities } from "../../src/core/project.ts";
import type { ProjectInfo } from "../../src/core/project.ts";
import { DIAGNOSTICS_BY_ID } from "../../src/core/registry.ts";

/** A ProjectInfo with exactly the given capability tokens (plus `node`). */
const project = (tokens: string[], name = "svc"): ProjectInfo => ({
  name,
  rootDirectory: "/Users/example/workspace/svc",
  capabilities: new Set(["node", ...tokens]),
});

/** Collapse wrapping so assertions can match phrases that the renderer may wrap. */
const flat = (markdown: string): string => markdown.replace(/\s+/g, " ");

/** Every diagnostic id the document cites, de-duplicated and sorted. */
const citedIds = (markdown: string): string[] =>
  [...new Set([...markdown.matchAll(/`node-doctor\/([a-z0-9-]+)`/g)].map((m) => m[1]!))].sort();

/** The body of one `## heading` section, so a citation can be pinned to its own section. */
const sectionBody = (markdown: string, heading: string): string => {
  const start = markdown.indexOf(`## ${heading}\n`);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const rest = markdown.slice(start);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
};

/** One capability set per stack the generator claims to know about. */
const STACKS: string[][] = [
  [],
  ["cjs"],
  ["esm"],
  ["esm", "typescript"],
  ["esm", "express"],
  ["esm", "express", "express:5"],
  ["esm", "fastify"],
  ["esm", "nest"],
  ["esm", "koa"],
  ["esm", "hono"],
  ["esm", "adonis"],
  ["esm", "prisma"],
  ["esm", "drizzle"],
  ["esm", "sequelize"],
  ["esm", "typeorm"],
  ["esm", "mongoose"],
  ["esm", "knex"],
  ["esm", "jsonwebtoken"],
  ["esm", "jose"],
  ["cjs", "express", "mongoose", "jose", "node:20"],
];

const tempProject = async (manifest: Record<string, unknown>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-conventions-"));
  await writeFile(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
};

describe("conventions: purity and determinism", () => {
  test("the same project renders a byte-identical string twice", () => {
    const info = project(["esm", "typescript", "express", "prisma", "jsonwebtoken"]);
    assert.equal(generateConventions(info), generateConventions(info));
  });

  test("two distinct objects with equal capabilities render identically", () => {
    const a = generateConventions(project(["cjs", "fastify", "mongoose"]));
    const b = generateConventions(project(["mongoose", "fastify", "cjs"]));
    assert.equal(a, b);
  });

  test("no machine path, timestamp, or year leaks into the content", () => {
    const output = generateConventions(project(["esm", "express"]));
    assert.ok(!output.includes("/Users/example/workspace/svc"));
    assert.ok(!/\b20\d\d-\d\d-\d\d\b/.test(output));
    assert.ok(!/\bT\d\d:\d\d:\d\dZ\b/.test(output));
  });

  test("every referenced diagnostic id exists in the registry", () => {
    const output = generateConventions(
      project([
        "esm",
        "typescript",
        "express",
        "fastify",
        "nest",
        "koa",
        "hono",
        "adonis",
        "prisma",
        "drizzle",
        "sequelize",
        "typeorm",
        "mongoose",
        "knex",
        "jsonwebtoken",
        "jose",
      ]),
    );
    const referenced = [...output.matchAll(/`node-doctor\/([a-z0-9-]+)`/g)].map((m) => m[1]!);
    assert.ok(referenced.length > 20, "expected the generated file to cite diagnostics");
    for (const id of new Set(referenced)) {
      assert.ok(DIAGNOSTICS_BY_ID.has(id), `unknown diagnostic id cited: ${id}`);
    }
  });
});

describe("conventions: every citation is one the scanner can actually report", () => {
  // A citation is a promise that `node-doctor` enforces the rule. If the diagnostic is
  // capability-gated away for this stack it can never fire, so citing it is a lie the
  // agent can check — and the whole file loses its authority. Existence in the registry
  // is not enough; the diagnostic's own requires/disabledWhen must be satisfied too.
  for (const tokens of STACKS) {
    test(`no unenforceable citation for [${tokens.join(", ") || "bare"}]`, () => {
      const capabilities = new Set(["node", ...tokens]);
      const output = generateConventions({ name: "svc", rootDirectory: "/x", capabilities });
      for (const id of citedIds(output)) {
        const diagnostic = DIAGNOSTICS_BY_ID.get(id);
        assert.ok(diagnostic, `unknown diagnostic id cited: ${id}`);
        assert.ok(
          capabilitiesSatisfied(diagnostic, capabilities),
          `cited ${id}, but it is gated off for [${tokens.join(", ")}]`,
        );
      }
    });
  }

  test("the capability-gated citations do appear where they are enforceable", () => {
    // The negative test above is satisfied by citing nothing at all; this pins the
    // positive direction, so a typo'd id (which silently drops out) fails the build.
    const output = generateConventions(
      project(["esm", "express", "fastify", "nest", "prisma", "mongoose", "jsonwebtoken"]),
    );
    for (const id of [
      "express-async-handler-unprotected",
      "express-missing-return-after-response",
      "no-missing-body-size-limit",
      "no-trust-proxy-true",
      "require-error-handling-middleware",
      "fastify-missing-schema",
      "nest-missing-validation-pipe",
      "require-pagination-limit",
      "no-jwt-decode-as-verify",
      "require-jwt-algorithms-allowlist",
      "no-jwt-none-algorithm",
      "jwt-missing-expiration",
    ]) {
      assert.ok(output.includes(`\`node-doctor/${id}\``), `expected the document to cite ${id}`);
    }
  });

  test("a Prisma-only diagnostic is cited to a Drizzle project only when Prisma is also installed", () => {
    const drizzleOnly = generateConventions(project(["esm", "drizzle"]));
    assert.ok(drizzleOnly.includes("## Data access — Drizzle"));
    assert.ok(!drizzleOnly.includes("require-pagination-limit"));
    assert.ok(flat(drizzleOnly).includes("`.limit(n)` on every list select"), "the rule text stays either way");

    const both = generateConventions(project(["esm", "prisma", "drizzle"]));
    assert.ok(sectionBody(both, "Data access — Drizzle").includes("`node-doctor/require-pagination-limit`"));
  });

  test("the Express-only body-limit diagnostic is not promised to a Fastify-only project", () => {
    const fastifyOnly = generateConventions(project(["esm", "fastify"]));
    assert.ok(!fastifyOnly.includes("no-missing-body-size-limit"));
    assert.ok(flat(fastifyOnly).includes("Set `bodyLimit`"), "the rule text stays either way");
    assert.ok(
      sectionBody(generateConventions(project(["esm", "express", "fastify"])), "Express 4 — the request path").includes(
        "`node-doctor/no-missing-body-size-limit`",
      ),
    );
  });

  test("the jsonwebtoken-gated diagnostics are not promised to a jose-only project", () => {
    const joseOnly = generateConventions(project(["esm", "jose"]));
    assert.ok(joseOnly.includes("## Auth — jose"));
    for (const id of ["no-jwt-decode-as-verify", "require-jwt-algorithms-allowlist", "jwt-missing-expiration"]) {
      assert.ok(!joseOnly.includes(id), `jose-only project must not cite ${id}`);
    }
    assert.ok(flat(joseOnly).includes("`decodeJwt` parses without verifying"), "the rule text stays either way");

    const both = sectionBody(generateConventions(project(["esm", "jose", "jsonwebtoken"])), "Auth — jose");
    assert.ok(both.includes("`node-doctor/no-jwt-decode-as-verify`"));
  });

  test("dropping a citation never leaves dangling punctuation", () => {
    // Citations sit at the end of a sentence or inside a parenthetical; removing one
    // must not leave " ." / " ," / " ;" / " ()" behind. Checked on the unwrapped text so
    // a line break is not mistaken for a gap.
    for (const tokens of STACKS) {
      // `npx node-doctor@latest .` legitimately ends in " ." — it is a path argument.
      const text = flat(generateConventions(project(tokens))).replace("node-doctor@latest .", "");
      const label = tokens.join(", ") || "bare";
      assert.ok(!text.includes(" ()"), `empty parenthetical for [${label}]`);
      // ` ...` (an elided argument list) is prose, not an orphaned period.
      assert.ok(!/ \.(?!\.)/.test(text), `orphaned period for [${label}]`);
      assert.ok(!text.includes(" ,"), `orphaned comma for [${label}]`);
      assert.ok(!text.includes(" ;"), `orphaned semicolon for [${label}]`);
      assert.ok(!text.includes(",,"), `doubled separator for [${label}]`);
    }
  });
});

describe("conventions: the stack is named", () => {
  test("the detected stack lists framework, ORM, auth, modules and language", () => {
    const output = flat(generateConventions(project(["esm", "typescript", "express", "prisma", "jose"], "billing-api")));
    assert.ok(output.includes("# Node.js conventions — billing-api"));
    assert.ok(output.includes("**Framework** — Express 4"));
    assert.ok(output.includes("**Data access** — Prisma"));
    assert.ok(output.includes("**Auth** — jose"));
    assert.ok(output.includes("**Modules** — ESM"));
    assert.ok(output.includes("**Language** — TypeScript"));
  });

  test("engines.node pins the runtime line; without it the line says so", () => {
    assert.ok(flat(generateConventions(project(["cjs", "node:22"]))).includes("Node.js 22+"));
    assert.ok(flat(generateConventions(project(["cjs"]))).includes("no `engines.node` pin"));
  });

  test("a bare project names no framework, ORM or auth library", () => {
    const output = generateConventions(project(["cjs"]));
    assert.ok(!output.includes("**Framework**"));
    assert.ok(!output.includes("**Data access**"));
    assert.ok(!output.includes("**Auth**"));
    assert.ok(output.includes("**Language** — JavaScript"));
  });
});

describe("conventions: stack-specific sections are gated on capabilities", () => {
  test("Express 4 gets the async-rejection rule", () => {
    const output = flat(generateConventions(project(["esm", "express"])));
    assert.ok(output.includes("## Express 4 — the request path"));
    assert.ok(output.includes("Express 4 does **not** catch a rejected promise"));
    assert.ok(output.includes("next(err)"));
    assert.ok(output.includes("express-async-handler-unprotected"));
  });

  test("Express 5 retires the wrapper rule but still demands error middleware", () => {
    const output = flat(generateConventions(project(["esm", "express", "express:5"])));
    assert.ok(output.includes("## Express 5 — the request path"));
    assert.ok(output.includes("**Framework** — Express 5"));
    assert.ok(!output.includes("Express 4 does **not** catch a rejected promise"));
    assert.ok(!output.includes("express-async-handler-unprotected"));
    assert.ok(output.includes("require-error-handling-middleware"));
  });

  test("a stray express:5 token without express names no Express anywhere", () => {
    // `express:5` is a version refinement, never a stack on its own. If it could leak
    // into the prose alone, the document would contradict its own "if a library is not
    // named here, this project does not install it" promise.
    const output = generateConventions(project(["esm", "express:5"]));
    assert.ok(!output.includes("Express"), "Express must not be mentioned without the express capability");
    assert.ok(
      flat(output).includes("an explicit `try/catch` or the framework's error hook"),
      "question 1 falls back to the generic mechanism",
    );
    assert.ok(flat(output).includes("a rule that holds for one major of a dependency"));
  });

  test("no Express section at all without Express", () => {
    const output = generateConventions(project(["esm", "fastify"]));
    assert.ok(!output.includes("Express"));
    assert.ok(output.includes("## Fastify — the request path"));
    assert.ok(output.includes("fastify-missing-schema"));
  });

  test("Prisma gets the N+1 and bounded-findMany rules; a Prisma-less project gets none", () => {
    const withPrisma = flat(generateConventions(project(["esm", "prisma"])));
    assert.ok(withPrisma.includes("## Data access — Prisma"));
    assert.ok(withPrisma.includes("Never query inside a loop"));
    assert.ok(withPrisma.includes("Every `findMany` carries `take`"));
    assert.ok(withPrisma.includes("no-query-in-loop"));

    const without = generateConventions(project(["esm", "express"]));
    assert.ok(!without.includes("Prisma"));
    assert.ok(!without.includes("Data access"));
    assert.ok(!without.includes("no-query-in-loop"));
  });

  test("each ORM emits only its own section", () => {
    const drizzle = generateConventions(project(["esm", "drizzle"]));
    assert.ok(drizzle.includes("## Data access — Drizzle"));
    assert.ok(drizzle.includes("inArray"));
    assert.ok(!drizzle.includes("Prisma"));
    assert.ok(!drizzle.includes("Mongoose"));

    const mongoose = flat(generateConventions(project(["cjs", "mongoose"])));
    assert.ok(mongoose.includes("## Data access — Mongoose"));
    assert.ok(mongoose.includes("no-nosql-object-injection"));
    assert.ok(!mongoose.includes("Drizzle"));
  });

  test("jsonwebtoken demands verify-not-decode and expiresIn; absent otherwise", () => {
    const output = flat(generateConventions(project(["esm", "jsonwebtoken"])));
    assert.ok(output.includes("## Auth — jsonwebtoken"));
    assert.ok(output.includes("`jwt.decode` only base64-decodes"));
    assert.ok(output.includes("expiresIn"));
    assert.ok(output.includes("no-jwt-decode-as-verify"));
    assert.ok(output.includes("require-jwt-algorithms-allowlist"));

    const without = generateConventions(project(["esm", "express"]));
    assert.ok(!without.includes("jsonwebtoken"));
    assert.ok(!without.includes("jwt"));
  });

  test("jose gets its own auth section, not jsonwebtoken's", () => {
    const output = generateConventions(project(["esm", "jose"]));
    assert.ok(output.includes("## Auth — jose"));
    assert.ok(output.includes("jwtVerify"));
    assert.ok(!output.includes("jsonwebtoken"));
  });

  test("ESM and CJS get opposite module rules", () => {
    const esm = flat(generateConventions(project(["esm"])));
    assert.ok(esm.includes("## Modules — ESM"));
    assert.ok(esm.includes("import.meta.dirname"));
    assert.ok(!esm.includes("## Modules — CommonJS"));

    const cjs = flat(generateConventions(project(["cjs"])));
    assert.ok(cjs.includes("## Modules — CommonJS"));
    assert.ok(cjs.includes("There is no top-level `await`"));
    assert.ok(!cjs.includes("import.meta.dirname"));
  });

  test("the TypeScript section appears only for TypeScript projects", () => {
    assert.ok(generateConventions(project(["esm", "typescript"])).includes("## Language — TypeScript"));
    assert.ok(!generateConventions(project(["esm"])).includes("## Language — TypeScript"));
  });
});

describe("conventions: always-present guidance", () => {
  test("the four request-handler questions are always emitted", () => {
    const output = flat(generateConventions(project(["cjs"])));
    assert.ok(output.includes("## Every request handler — answer these four questions"));
    assert.ok(output.includes("1. **Where does a post-`await` rejection go?**"));
    assert.ok(output.includes("2. **Does anything block the event loop?**"));
    assert.ok(output.includes("3. **Does the code fan out proportionally to caller input?**"));
    assert.ok(output.includes("4. **Which values crossed the network, and where do they land?**"));
    assert.ok(output.includes("execFile(cmd, [args])"));
    assert.ok(output.includes("bound parameters"));
    assert.ok(output.includes("check containment against the base directory"));
    assert.ok(output.includes("no `eval`, `new Function`, or `vm` on caller data"));
  });

  test("question 1 names the framework's own rejection mechanism", () => {
    assert.ok(flat(generateConventions(project(["esm", "express"]))).includes("a `try/catch` that calls `next(err)`"));
    assert.ok(
      flat(generateConventions(project(["esm", "express", "express:5"]))).includes("Express 5's automatic forwarding"),
    );
    assert.ok(flat(generateConventions(project(["esm", "fastify"]))).includes("setErrorHandler"));
  });

  test("verification and the MCP snippet check are always emitted", () => {
    const output = flat(generateConventions(project(["esm"])));
    assert.ok(output.includes("npx node-doctor@latest ."));
    assert.ok(output.includes("node_doctor_check_snippet"));
    assert.ok(output.includes("before* it reaches disk"));
  });

  test("the suppression stance is always emitted", () => {
    const output = flat(generateConventions(project(["esm"])));
    assert.ok(output.includes("## The stance on suppressions"));
    assert.ok(output.includes("Fix the root cause; never suppress"));
    assert.ok(output.includes("a false positive is a bug in the diagnostic"));
  });
});

describe("conventions: targets", () => {
  test("the four known targets map to the expected paths", () => {
    const byId = new Map(CONVENTION_TARGETS.map((target) => [target.id, target.path]));
    assert.equal(byId.get("agents"), "AGENTS.md");
    assert.equal(byId.get("claude"), "CLAUDE.md");
    assert.equal(byId.get("cursor"), ".cursorrules");
    assert.equal(byId.get("windsurf"), ".windsurfrules");
    assert.equal(CONVENTION_TARGETS.length, 4);
  });
});

describe("conventions: writeConventions", () => {
  test("writes every target with content derived from the real manifest", async () => {
    const dir = await tempProject({
      name: "orders-api",
      type: "module",
      dependencies: { express: "^4.19.2", "@prisma/client": "^5.0.0" },
    });
    try {
      const result = await writeConventions({ rootDirectory: dir });
      assert.equal(result.written.length, 4);
      assert.equal(result.skipped.length, 0);
      assert.ok(result.written.some((p) => p.endsWith("AGENTS.md")));
      assert.ok(result.written.some((p) => p.endsWith("CLAUDE.md")));
      assert.ok(result.written.some((p) => p.endsWith(".cursorrules")));
      assert.ok(result.written.some((p) => p.endsWith(".windsurfrules")));

      const agents = await readFile(join(dir, "AGENTS.md"), "utf8");
      const cursor = await readFile(join(dir, ".cursorrules"), "utf8");
      assert.equal(agents, cursor);
      assert.ok(agents.includes("# Node.js conventions — orders-api"));
      assert.ok(flat(agents).includes("**Framework** — Express 4"));
      assert.ok(flat(agents).includes("**Data access** — Prisma"));
      assert.ok(flat(agents).includes("**Modules** — ESM"));

      const capabilities = detectCapabilities({
        name: "orders-api",
        type: "module",
        dependencies: { express: "^4.19.2", "@prisma/client": "^5.0.0" },
      });
      assert.equal(
        agents,
        generateConventions({ name: "orders-api", rootDirectory: dir, capabilities }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips a file that already exists unless overwrite is set", async () => {
    const dir = await tempProject({ name: "svc", dependencies: { fastify: "^4.0.0" } });
    try {
      await writeFile(join(dir, "CLAUDE.md"), "# hand written\n");

      const first = await writeConventions({ rootDirectory: dir });
      assert.equal(first.skipped.length, 1);
      assert.ok(first.skipped[0]!.endsWith("CLAUDE.md"));
      assert.equal(first.written.length, 3);
      assert.equal(await readFile(join(dir, "CLAUDE.md"), "utf8"), "# hand written\n");

      const second = await writeConventions({ rootDirectory: dir, overwrite: true });
      assert.equal(second.written.length, 4);
      assert.equal(second.skipped.length, 0);
      const claude = await readFile(join(dir, "CLAUDE.md"), "utf8");
      assert.ok(claude.startsWith("# Node.js conventions — svc"));
      assert.ok(claude.includes("## Fastify — the request path"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a second run without overwrite is a no-op", async () => {
    const dir = await tempProject({ name: "svc" });
    try {
      await writeConventions({ rootDirectory: dir });
      const again = await writeConventions({ rootDirectory: dir });
      assert.equal(again.written.length, 0);
      assert.equal(again.skipped.length, 4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("targets select a subset, in CONVENTION_TARGETS order regardless of argument order", async () => {
    const dir = await tempProject({ name: "svc" });
    try {
      const result = await writeConventions({ rootDirectory: dir, targets: ["cursor", "agents"] });
      assert.deepEqual(
        result.written.map((p) => p.slice(dir.length + 1)),
        ["AGENTS.md", ".cursorrules"],
      );
      await assert.rejects(
        () => writeConventions({ rootDirectory: dir, targets: ["aider"] }),
        /unknown conventions target "aider"/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a repeated target id is written once, and result paths are absolute", async () => {
    const dir = await tempProject({ name: "svc" });
    try {
      const result = await writeConventions({ rootDirectory: dir, targets: ["claude", "claude", "agents"] });
      assert.deepEqual(
        result.written.map((p) => p.slice(dir.length + 1)),
        ["AGENTS.md", "CLAUDE.md"],
      );
      for (const path of result.written) assert.ok(isAbsolute(path), `expected an absolute path, got ${path}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an empty targets array selects nothing rather than everything", async () => {
    const dir = await tempProject({ name: "svc" });
    try {
      const result = await writeConventions({ rootDirectory: dir, targets: [] });
      assert.deepEqual(result, { written: [], skipped: [] });
      await assert.rejects(() => readFile(join(dir, "AGENTS.md"), "utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the unknown-target error names the ids that are known", async () => {
    const dir = await tempProject({ name: "svc" });
    try {
      await assert.rejects(
        () => writeConventions({ rootDirectory: dir, targets: ["agents", "zed"] }),
        (error: Error) => {
          assert.match(error.message, /unknown conventions target "zed"/);
          for (const id of CONVENTION_TARGETS.map((t) => t.id)) assert.ok(error.message.includes(id));
          return true;
        },
      );
      // Validation happens before any write, so a bad id in the list writes nothing.
      await assert.rejects(() => readFile(join(dir, "AGENTS.md"), "utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a project with no package.json still gets a usable file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-conventions-"));
    try {
      const result = await writeConventions({ rootDirectory: dir, targets: ["agents"] });
      assert.equal(result.written.length, 1);
      const content = await readFile(join(dir, "AGENTS.md"), "utf8");
      assert.ok(content.includes("## Every request handler — answer these four questions"));
      assert.ok(content.includes("npx node-doctor@latest ."));
      assert.ok(content.endsWith("\n"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
