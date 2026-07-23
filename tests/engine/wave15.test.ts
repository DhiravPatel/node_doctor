/**
 * Wave 15 — framework detection breadth (§2).
 *
 * Detection alone is worth shipping ahead of framework-specific diagnostics: the
 * capability token drives the `detected:` line, route extraction, and the gates
 * that keep rules off the wrong stack.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { detectCapabilities } from "../../src/core/project.ts";
import { lintSource } from "../../src/core/scan.ts";

const capsFor = (deps: Record<string, string>, extra: Record<string, unknown> = {}): Set<string> =>
  detectCapabilities({ name: "t", dependencies: deps, ...extra });

describe("framework detection (§2)", () => {
  const CASES: Array<[string, string]> = [
    ["@hapi/hapi", "hapi"],
    ["hapi", "hapi"],
    ["restify", "restify"],
    ["sails", "sails"],
    ["@feathersjs/feathers", "feathers"],
    ["@loopback/core", "loopback"],
    ["next", "next"],
    ["@remix-run/server-runtime", "remix"],
    ["@remix-run/node", "remix"],
    ["serverless-http", "serverless"],
  ];

  for (const [dep, token] of CASES) {
    test(`${dep} → ${token}`, () => {
      assert.ok(capsFor({ [dep]: "^1.0.0" }).has(token));
    });
  }

  // `react-router` ships in essentially every React SPA. Mapping it to `remix`
  // would tag a frontend as a backend framework — the same over-detection that
  // made a devDependency on `wrangler` claim a whole project runs at the edge.
  test("a React SPA is not mistaken for a Remix server", () => {
    const caps = capsFor({ react: "^18.0.0", "react-router": "^6.0.0", "react-dom": "^18.0.0" });
    assert.equal(caps.has("remix"), false);
    assert.equal(caps.has("next"), false);
  });

  test("detection is additive — a Next app on Prisma reports both", () => {
    const caps = capsFor({ next: "^14.0.0", "@prisma/client": "^5.0.0" });
    assert.ok(caps.has("next"));
    assert.ok(caps.has("prisma"));
  });

  test("an unknown framework adds no token rather than guessing", () => {
    const caps = capsFor({ "some-obscure-framework": "^1.0.0" });
    assert.deepEqual([...caps].sort(), ["cjs", "node"]);
  });
});

// ---------------------------------------------------------------------------
// Catalog reachability — a diagnostic you cannot look up cannot be acted on
// ---------------------------------------------------------------------------

import { DIAGNOSTICS } from "../../src/core/registry.ts";
import { ALL_TEXT_DIAGNOSTICS } from "../../src/diagnostics/text-diagnostics.ts";

describe("catalog reachability", () => {
  /**
   * Text (Phase C) diagnostics are not in the codegen registry, so every consumer
   * that composed its own list silently omitted them: `explain <id>` answered
   * "unknown diagnostic" for an id the tool had just printed in a report, and the
   * config schema offered no key to configure them by. They now all read one
   * canonical list.
   */
  test("every text diagnostic is reachable from the canonical list", () => {
    const ids = new Set(ALL_TEXT_DIAGNOSTICS.map((d) => d.id));
    for (const id of [
      "no-committed-env-secret",
      "no-open-security-group",
      "dockerfile-runs-as-root",
      "k8s-privileged-container",
      "ci-script-injection",
    ]) {
      assert.ok(ids.has(id), `${id} missing from ALL_TEXT_DIAGNOSTICS`);
    }
  });

  test("no id collides between the AST and text buckets", () => {
    const ast = new Set(DIAGNOSTICS.map((d) => d.id));
    const clashes = ALL_TEXT_DIAGNOSTICS.filter((d) => ast.has(d.id)).map((d) => d.id);
    assert.deepEqual(clashes, [], "an id in both buckets would resolve ambiguously");
  });

  test("every diagnostic carries the fields the catalog and explain render", () => {
    for (const d of [...DIAGNOSTICS, ...ALL_TEXT_DIAGNOSTICS]) {
      assert.ok(d.id && d.title && d.category && d.severity, `${d.id} is missing catalog fields`);
      assert.ok(d.recommendation && d.recommendation.length > 0, `${d.id} has no recommendation`);
    }
  });
});

// ---------------------------------------------------------------------------
// Convention-registered handlers (Next.js App Router / SvelteKit / Remix)
// ---------------------------------------------------------------------------

import { parseSource } from "../../src/core/parse.ts";
import { attachParents } from "../../src/core/walk.ts";
import { resolveScopes } from "../../src/core/scope.ts";
import { collectRequestHandlers } from "../../src/core/request-path.ts";

const handlerNames = (source: string): string[] => {
  const parsed = parseSource("t.ts", source);
  attachParents(parsed.program);
  const handlers = collectRequestHandlers(parsed.program, resolveScopes(parsed.program));
  return [...handlers]
    .map((h) => {
      const named = h as { id?: { name?: string }; parent?: { id?: { name?: string } } };
      return named.id?.name ?? named.parent?.id?.name ?? "<anon>";
    })
    .sort();
};

describe("convention-registered request handlers", () => {
  /**
   * Next.js App Router and SvelteKit register by file convention, not by a call,
   * so nothing in the registration-based detector saw them: node.doctor would
   * report `detected: next` and then miss the `readFileSync` in every route —
   * the whole point of the tool, silently inapplicable to a very common stack.
   */
  test("an exported HTTP-method function is a handler", () => {
    assert.deepEqual(
      handlerNames(`export async function GET(request) { return null; }\nexport async function POST(request) { return null; }`),
      ["GET", "POST"],
    );
  });

  test("Remix loader/action are handlers when they take DataFunctionArgs", () => {
    assert.deepEqual(
      handlerNames(`export async function loader({ request }) { return null; }\nexport const action = async ({ params }) => null;`),
      ["action", "loader"],
    );
  });

  // `action` is also what every Redux action creator is called, so the name
  // alone cannot qualify — the single destructured DataFunctionArgs object is
  // what makes the Remix convention recognizable.
  test("a Redux-style action creator is NOT a handler", () => {
    assert.deepEqual(handlerNames(`export const action = (type) => ({ type });`), []);
    assert.deepEqual(handlerNames(`export function loader(url, opts) { return fetch(url, opts); }`), []);
  });

  test("an ordinary exported function is not a handler", () => {
    assert.deepEqual(handlerNames(`export function notAHandler(x) { return x; }`), []);
    assert.deepEqual(handlerNames(`export const getUser = (id) => db.find(id);`), []);
  });

  test("a blocking call in a Next.js route handler is on the request path", () => {
    const d = DIAGNOSTICS.find((x) => x.id === "no-sync-io-in-request-path")!;
    const { findings } = lintSource({
      filePath: "app/api/users/route.ts",
      sourceText: `import fs from "node:fs";\nexport async function GET(request) {\n  return fs.readFileSync("./c.json", "utf8");\n}\n`,
      diagnostics: [d],
      capabilities: new Set(["node", "esm", "next"]),
    });
    assert.equal(findings.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Public API enumerates the WHOLE catalog (not just the AST rules)
// ---------------------------------------------------------------------------

import * as publicApi from "../../src/index.ts";

describe("public API catalog completeness", () => {
  /**
   * A programmatic consumer enumerates the ruleset via the package's own exports.
   * `TEXT_DIAGNOSTICS` is only the secrets subset, so `DIAGNOSTICS + TEXT_DIAGNOSTICS`
   * silently under-counted the catalog by every IaC/container/k8s/CI/migration/AI
   * text diagnostic. The full list must be reachable from the entry point.
   */
  test("DIAGNOSTICS + ALL_TEXT_DIAGNOSTICS covers every registered diagnostic", () => {
    const viaApi = new Set([
      ...publicApi.DIAGNOSTICS.map((d) => d.id),
      ...publicApi.ALL_TEXT_DIAGNOSTICS.map((d) => d.id),
    ]);
    for (const d of ALL_TEXT_DIAGNOSTICS) {
      assert.ok(viaApi.has(d.id), `${d.id} is not reachable from the public API`);
    }
    // The whole catalog, no gaps: every AST + text id resolves through the entry.
    assert.equal(viaApi.size, DIAGNOSTICS.length + ALL_TEXT_DIAGNOSTICS.length);
  });
});
