import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectCapabilities,
  shouldEnableDiagnostic,
  capabilitiesSatisfied,
  majorVersion,
  discoverProject,
  isGrantableCapability,
} from "../../src/core/project.ts";
import { DIAGNOSTICS, DIAGNOSTICS_BY_ID } from "../../src/core/registry.ts";
import { ALL_TEXT_DIAGNOSTICS } from "../../src/diagnostics/text-diagnostics.ts";
import type { Diagnostic } from "../../src/core/types.ts";

/** Every shipped diagnostic, AST and text-scan alike. */
const ALL_DIAGNOSTICS = [...DIAGNOSTICS, ...ALL_TEXT_DIAGNOSTICS];

describe("detectCapabilities", () => {
  test("express 4 does not add express:5", () => {
    const caps = detectCapabilities({ dependencies: { express: "^4.18.2" } });
    assert.ok(caps.has("express"));
    assert.ok(!caps.has("express:5"));
  });

  test("express 5 adds express:5", () => {
    const caps = detectCapabilities({ dependencies: { express: "^5.0.0" } });
    assert.ok(caps.has("express"));
    assert.ok(caps.has("express:5"));
  });

  test("type: module → esm; otherwise cjs", () => {
    assert.ok(detectCapabilities({ type: "module" }).has("esm"));
    assert.ok(detectCapabilities({}).has("cjs"));
  });

  test("typescript from a tsconfig even without the dep", () => {
    assert.ok(detectCapabilities({}, { hasTsconfig: true }).has("typescript"));
  });

  test("orm + framework tokens", () => {
    const caps = detectCapabilities({
      dependencies: { fastify: "^4", "@prisma/client": "^5", jsonwebtoken: "^9" },
    });
    for (const t of ["fastify", "prisma", "jsonwebtoken"]) assert.ok(caps.has(t), t);
  });

  test("node major from engines", () => {
    assert.ok(detectCapabilities({ engines: { node: ">=20.19" } }).has("node:20"));
  });

  test("majorVersion parses ranges", () => {
    assert.equal(majorVersion("^5.0.0"), 5);
    assert.equal(majorVersion(">=4.17.1 <5"), 4);
    assert.equal(majorVersion(undefined), null);
  });
});

describe("diagnostic gating", () => {
  const asyncHandler = DIAGNOSTICS_BY_ID.get("express-async-handler-unprotected")!;
  const jwtRule = DIAGNOSTICS_BY_ID.get("no-jwt-decode-as-verify")!;

  test("express-async diagnostic runs on express 4", () => {
    assert.ok(shouldEnableDiagnostic(asyncHandler, new Set(["node", "express"])));
  });
  test("express-async diagnostic retires on express 5", () => {
    assert.ok(!shouldEnableDiagnostic(asyncHandler, new Set(["node", "express", "express:5"])));
  });
  test("express-async diagnostic silent without express", () => {
    assert.ok(!shouldEnableDiagnostic(asyncHandler, new Set(["node"])));
  });
  test("jwt diagnostic requires jsonwebtoken", () => {
    assert.ok(!capabilitiesSatisfied(jwtRule, new Set(["node"])));
    assert.ok(capabilitiesSatisfied(jwtRule, new Set(["node", "jsonwebtoken"])));
  });
});

/**
 * Workspace-aware capability detection.
 *
 * Capability gating was wrong in exactly the repos where it matters most. In a
 * monorepo the database client is usually declared by ONE member and re-exported
 * to the rest — cal.com declares `@prisma/client` only in
 * `packages/prisma/package.json`, and every consumer imports `@calcom/prisma`.
 * The root manifest's sole prisma-ish entry is `@prisma/internals`, which is not
 * a client.
 *
 * A manifest-only reading of that repo therefore produced NO `prisma` capability
 * at ANY level — root, `packages/features`, `packages/trpc`, `apps/web` — so
 * every Prisma-gated diagnostic silently never ran on one of the largest
 * open-source Prisma codebases there is. In the report that is indistinguishable
 * from a clean result, which is the dangerous part.
 *
 * These tests cover both halves: unioning member manifests, and finding the
 * workspace root when a MEMBER is scanned directly (the common CI invocation,
 * where the member itself declares no `workspaces`).
 */
describe("workspace-aware capability detection", () => {
  /** Build a throwaway monorepo and hand its directory to `fn`. */
  const withRepo = async (
    spec: { root: Record<string, unknown>; members?: Record<string, Record<string, unknown>>; pnpm?: string },
    fn: (dir: string) => Promise<void>,
  ): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "nd-ws-"));
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "root", ...spec.root }));
      if (spec.pnpm !== undefined) await writeFile(join(dir, "pnpm-workspace.yaml"), spec.pnpm);
      for (const [rel, manifest] of Object.entries(spec.members ?? {})) {
        await mkdir(join(dir, rel), { recursive: true });
        await writeFile(join(dir, rel, "package.json"), JSON.stringify(manifest));
      }
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test("a dependency declared only by a member is detected at the root", async () => {
    await withRepo(
      {
        root: { workspaces: ["packages/*"], dependencies: { "@prisma/internals": "^5.0.0" } },
        members: { "packages/db": { name: "db", dependencies: { "@prisma/client": "^5.0.0" } } },
      },
      async (dir) => {
        const project = await discoverProject(dir);
        assert.ok(project.capabilities.has("prisma"), "member's client must reach the root's capabilities");
      },
    );
  });

  test("scanning a MEMBER directly still finds the workspace root", async () => {
    // The common CI invocation. `packages/features` declares no `workspaces` of
    // its own, so without climbing it sees only its own manifest.
    await withRepo(
      {
        root: { workspaces: ["packages/*"] },
        members: {
          "packages/db": { name: "db", dependencies: { "@prisma/client": "^5.0.0" } },
          "packages/features": { name: "features", dependencies: { react: "^18.0.0" } },
        },
      },
      async (dir) => {
        const project = await discoverProject(join(dir, "packages", "features"));
        assert.ok(project.capabilities.has("prisma"), "a member must inherit the workspace's capabilities");
      },
    );
  });

  test("pnpm workspaces are read too", async () => {
    await withRepo(
      {
        root: {},
        pnpm: "packages:\n  - 'packages/*'\n",
        members: { "packages/db": { name: "db", dependencies: { mongoose: "^8.0.0" } } },
      },
      async (dir) => {
        const project = await discoverProject(dir);
        assert.ok(project.capabilities.has("mongoose"));
      },
    );
  });

  test("the root's own version wins over a member's", async () => {
    // Otherwise a member pinning express 4 could retire the express:5 gate.
    await withRepo(
      {
        root: { workspaces: ["packages/*"], dependencies: { express: "^5.0.0" } },
        members: { "packages/legacy": { name: "legacy", dependencies: { express: "^4.18.0" } } },
      },
      async (dir) => {
        const project = await discoverProject(dir);
        assert.ok(project.capabilities.has("express:5"), "root pin decides the version token");
      },
    );
  });

  test("a plain single package is unaffected and globs nothing", async () => {
    await withRepo({ root: { dependencies: { express: "^4.18.0" } } }, async (dir) => {
      const project = await discoverProject(dir);
      assert.ok(project.capabilities.has("express"));
      assert.ok(!project.capabilities.has("prisma"));
    });
  });

  test("node_modules is never mistaken for a workspace member", async () => {
    await withRepo(
      {
        root: { workspaces: ["packages/*"] },
        members: {
          "packages/app": { name: "app", dependencies: {} },
          "packages/app/node_modules/mongoose": { name: "mongoose", dependencies: { mongoose: "^8.0.0" } },
        },
      },
      async (dir) => {
        const project = await discoverProject(dir);
        assert.ok(!project.capabilities.has("mongoose"), "an installed package is not a workspace member");
      },
    );
  });
});

/**
 * Declared deployment timezone.
 *
 * Some defects only exist away from UTC: a `Date` built from local wall-clock
 * components and rendered with `toISOString()` is wrong east of Greenwich and
 * exactly right on a UTC host. An adversarial review refuted an earlier version
 * of `no-local-date-as-iso-datestring` with a real counter-example — two of its
 * findings sat in a project whose own `.env` line 1 is `TZ=UTC`, so the emitted
 * string was correct and the rule was reporting working code.
 */
describe("declared deployment timezone", () => {
  const withFiles = async (files: Record<string, string>, fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "nd-tz-"));
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }));
      for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test("`TZ=UTC` in a .env declares UTC", async () => {
    await withFiles({ ".env": "TZ=UTC\nPORT=3000\n" }, async (dir) => {
      const caps = (await discoverProject(dir)).capabilities;
      assert.ok(caps.has("tz:utc"));
      assert.ok(!caps.has("tz:non-utc"));
    });
  });

  test("`ENV TZ=Asia/Kolkata` in a Dockerfile declares non-UTC", async () => {
    await withFiles({ Dockerfile: "FROM node:20\nENV TZ=Asia/Kolkata\n" }, async (dir) => {
      const caps = (await discoverProject(dir)).capabilities;
      assert.ok(caps.has("tz:non-utc"));
      assert.ok(!caps.has("tz:utc"));
    });
  });

  test("the UTC aliases all count as UTC", async () => {
    for (const zone of ["UTC", "GMT", "Etc/UTC", "Etc/GMT", "Universal"]) {
      await withFiles({ ".env": `TZ=${zone}\n` }, async (dir) => {
        assert.ok((await discoverProject(dir)).capabilities.has("tz:utc"), zone);
      });
    }
  });

  test("a compose `- TZ=Europe/Berlin` entry is read", async () => {
    await withFiles({ "docker-compose.yml": "services:\n  api:\n    environment:\n      - TZ=Europe/Berlin\n" }, async (dir) => {
      assert.ok((await discoverProject(dir)).capabilities.has("tz:non-utc"));
    });
  });

  test("CONFLICTING declarations prove nothing and grant no token", async () => {
    // Both corpus projects that pin `ENV TZ=Asia/Kolkata` in a Dockerfile also
    // ship a `.env` saying `TZ=UTC`. Which wins at runtime depends on whether the
    // dotenv loader runs before the first `Date` — not decidable from the files.
    await withFiles(
      { ".env": "TZ=UTC\n", Dockerfile: "FROM node:20\nENV TZ=Asia/Kolkata\n" },
      async (dir) => {
        const caps = (await discoverProject(dir)).capabilities;
        assert.ok(!caps.has("tz:utc"));
        assert.ok(!caps.has("tz:non-utc"));
      },
    );
  });

  test("declaring nothing grants no token", async () => {
    await withFiles({ ".env": "PORT=3000\n" }, async (dir) => {
      const caps = (await discoverProject(dir)).capabilities;
      assert.ok(!caps.has("tz:utc"));
      assert.ok(!caps.has("tz:non-utc"));
    });
  });

  test("a declared UTC deployment turns the date rule off", async () => {
    const rule = DIAGNOSTICS_BY_ID.get("no-local-date-as-iso-datestring")!;
    assert.ok(rule, "rule must be registered");
    assert.ok(!shouldEnableDiagnostic(rule, new Set(["node", "tz:utc"])));
    assert.ok(shouldEnableDiagnostic(rule, new Set(["node", "tz:non-utc"])));
    // Undeclared still fires: the code is contingently correct, not correct.
    assert.ok(shouldEnableDiagnostic(rule, new Set(["node"])));
  });
});

/**
 * Every gate must be satisfiable.
 *
 * `no-missing-websocket-error-handler` shipped with `requires: ["ws"]` while
 * nothing granted a `ws` token, so the rule could never fire — on any project,
 * on any machine, even when a user explicitly enabled it, because
 * `capabilitiesSatisfied` is checked before the explicit-config escape hatch.
 * In a report, a rule that never ran is indistinguishable from a clean result.
 *
 * The whole suite stayed green for its entire shipped life, because diagnostic
 * tests hand capabilities straight to `lintSource` and never exercise gating.
 * This test closes that hole for every rule at once, present and future — it is
 * the class-level fix, where deleting the bad token was only the instance.
 */
describe("gate integrity", () => {
  test("every `requires` token can actually be granted", () => {
    const offenders: string[] = [];
    for (const diagnostic of ALL_DIAGNOSTICS) {
      for (const token of diagnostic.requires ?? []) {
        if (!isGrantableCapability(token)) offenders.push(`${diagnostic.id} requires "${token}"`);
      }
      // `requiresAny` is subject to the identical hazard: a family gate whose
      // every token is ungrantable is just as dead as a `requires` one.
      for (const token of diagnostic.requiresAny ?? []) {
        if (!isGrantableCapability(token)) offenders.push(`${diagnostic.id} requiresAny "${token}"`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "a rule gated on a token nothing grants is dead, not quiet — add the token to DEP_TOKENS or drop the gate",
    );
  });

  test("every `disabledWhen` token can actually be granted", () => {
    // A disabledWhen naming an ungrantable token is harmless but always a
    // mistake: it says "turn this off under condition X" where X cannot occur.
    const offenders: string[] = [];
    for (const diagnostic of ALL_DIAGNOSTICS) {
      for (const token of diagnostic.disabledWhen ?? []) {
        if (!isGrantableCapability(token)) offenders.push(`${diagnostic.id} disabledWhen "${token}"`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test("the websocket rule specifically is reachable again", () => {
    const rule = DIAGNOSTICS_BY_ID.get("no-missing-websocket-error-handler")!;
    assert.ok(rule, "rule must be registered");
    assert.equal(rule.requires ?? null, null, "the ungrantable `ws` gate must stay deleted");
    // Opt-in, so it is off by default but selectable once explicitly enabled.
    assert.ok(capabilitiesSatisfied(rule, new Set(["node", "esm"])));
  });
});

/**
 * `requiresAny` — the FAMILY gate.
 *
 * Some defects are shared by frameworks that spell them identically: a guard that
 * responds without returning is the same bug, and the same fix, on Express and
 * Fastify. `requires` is ALL, so it cannot express that, and the alternative —
 * dropping the gate and relying on the structural check — would let the rule run
 * on projects with no HTTP framework at all.
 */
describe("requiresAny (family gate)", () => {
  const fake = (gate: Partial<Diagnostic>): Diagnostic =>
    ({ id: "x", title: "x", severity: "warn", category: "Bugs", recommendation: "x", create: () => ({}), ...gate }) as Diagnostic;

  test("satisfied when ANY listed token is present", () => {
    const rule = fake({ requiresAny: ["express", "fastify"] });
    assert.ok(capabilitiesSatisfied(rule, new Set(["node", "express"])));
    assert.ok(capabilitiesSatisfied(rule, new Set(["node", "fastify"])));
    assert.ok(capabilitiesSatisfied(rule, new Set(["node", "express", "fastify"])));
  });

  test("unsatisfied when none is present", () => {
    const rule = fake({ requiresAny: ["express", "fastify"] });
    assert.equal(capabilitiesSatisfied(rule, new Set(["node", "koa"])), false);
    assert.equal(capabilitiesSatisfied(rule, new Set(["node"])), false);
  });

  test("combines with `requires`, which stays ALL", () => {
    const rule = fake({ requires: ["typescript"], requiresAny: ["express", "fastify"] });
    assert.ok(capabilitiesSatisfied(rule, new Set(["node", "typescript", "fastify"])));
    assert.equal(capabilitiesSatisfied(rule, new Set(["node", "fastify"])), false, "missing the ALL token");
    assert.equal(capabilitiesSatisfied(rule, new Set(["node", "typescript"])), false, "missing every ANY token");
  });

  test("`disabledWhen` still wins over a satisfied family gate", () => {
    const rule = fake({ requiresAny: ["express", "fastify"], disabledWhen: ["edge"] });
    assert.equal(capabilitiesSatisfied(rule, new Set(["node", "express", "edge"])), false);
  });

  test("an EMPTY array is no constraint, not an unsatisfiable one", () => {
    // A mistaken `requiresAny: []` must not silently kill a rule the way an
    // ungrantable token once did — that is the failure this file exists for.
    assert.ok(capabilitiesSatisfied(fake({ requiresAny: [] }), new Set(["node"])));
  });

  test("`shouldEnableDiagnostic` applies it too, not just `capabilitiesSatisfied`", () => {
    const rule = fake({ requiresAny: ["express", "fastify"] });
    assert.ok(shouldEnableDiagnostic(rule, new Set(["node", "fastify"])));
    assert.equal(shouldEnableDiagnostic(rule, new Set(["node", "koa"])), false);
  });

  test("the guard-without-return rule now covers Fastify", () => {
    const rule = DIAGNOSTICS_BY_ID.get("express-missing-return-after-response");
    assert.ok(rule);
    assert.ok(capabilitiesSatisfied(rule!, new Set(["node", "fastify"])), "Fastify projects must get it");
    assert.ok(capabilitiesSatisfied(rule!, new Set(["node", "express"])), "Express must keep it");
    assert.equal(capabilitiesSatisfied(rule!, new Set(["node", "koa"])), false, "and it must not leak elsewhere");
  });
});
