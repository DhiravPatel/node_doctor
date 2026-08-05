/**
 * §182 — Operational-Readiness Score.
 *
 * This report emits no findings, so it cannot produce a false positive in the
 * usual sense. What it CAN do — and what these tests exist to prevent — is
 * launder a blind spot into a pass. Every test below is a variation on the same
 * question: when the analyzer could not tell, does the report say so?
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs } from "../../src/cli/args.ts";
import {
  buildReadinessReport,
  collectReadinessEvidence,
  type ReadinessEvidence,
  type ReadinessInput,
} from "../../src/core/readiness.ts";
import type { ObservabilityReport } from "../../src/core/observability.ts";
import type { Finding } from "../../src/core/types.ts";

const ALL_RULES = new Set([
  "require-sigterm-handler",
  "no-liveness-check-with-dependency",
  "no-process-exit-in-request-path",
  "k8s-missing-resource-limits",
  "no-inverted-timeout-budget",
  "no-infinite-retry-without-backoff",
  "no-retry-amplification",
]);

const NO_EVIDENCE: ReadinessEvidence = {
  portBindings: [],
  signalHandlers: [],
  drainedServerFiles: [],
  manifests: [],
  routePaths: [],
  unparsedFiles: [],
};

const CHECKS = ["error-handling", "logs-on-failure", "timed-external-calls", "correlation-id"];

const route = (
  path: string,
  fails: string[] = [],
): ObservabilityReport["routes"][number] => ({
  method: "get",
  path,
  normalizedFilePath: "src/routes.js",
  line: 1,
  checks: Object.fromEntries(CHECKS.map((c) => [c, fails.includes(c) ? "fail" : "pass"])),
  score: 100,
});

const obs = (routes: ObservabilityReport["routes"] = []): ObservabilityReport => ({
  routes,
  score: 100,
  summary: { routes: routes.length, checkPassRate: {} },
});

const finding = (diagnostic: string, line = 1, normalizedFilePath = "src/a.js"): Finding =>
  ({ diagnostic, normalizedFilePath, line }) as unknown as Finding;

const build = (over: Partial<ReadinessInput> = {}) =>
  buildReadinessReport({
    findings: [],
    rulesRun: ALL_RULES,
    observability: obs(),
    evidence: NO_EVIDENCE,
    complete: true,
    parseFailures: 0,
    ...over,
  });

const dimension = (report: ReturnType<typeof build>, id: string) => {
  const found = report.dimensions.find((d) => d.id === id);
  assert.ok(found, `no dimension "${id}"`);
  return found;
};

describe("readiness — a blind spot is never a pass", () => {
  test("a repository with nothing to assess is UNSCORED, not 100", () => {
    const r = build();
    assert.equal(r.score, null, "no assessable dimension means no score");
    assert.equal(r.label, "unscored");
    assert.equal(r.summary.ready, 0);
    assert.equal(r.summary.gaps, 0);
  });

  test("no port bound means graceful shutdown does not apply — it is not a gap", () => {
    const d = dimension(build(), "graceful-shutdown");
    assert.equal(d.status, "not-applicable");
    assert.match(d.detail, /binds a port/);
  });

  test("a port bound with no handler is only a GAP when the rule that proves it ran", () => {
    const evidence = { ...NO_EVIDENCE, portBindings: ["src/server.js:10"] };

    const proven = build({
      evidence,
      findings: [finding("require-sigterm-handler", 10, "src/server.js")],
    });
    assert.equal(dimension(proven, "graceful-shutdown").status, "gap");

    const unproven = build({ evidence, rulesRun: new Set() });
    const d = dimension(unproven, "graceful-shutdown");
    assert.equal(d.status, "not-proven", "a disabled rule proves nothing");
    assert.match(d.detail, /unverified, not clean/);
  });

  test("the shutdown gap must be corroborated by a PORT binding in that same file", () => {
    // `require-sigterm-handler` matches any `.listen(...)`, including an
    // in-process bus subscription. A worker with no HTTP surface must not be
    // told its server cannot drain.
    const d = dimension(
      build({ findings: [finding("require-sigterm-handler", 2, "src/index.js")] }),
      "graceful-shutdown",
    );
    assert.equal(d.status, "not-proven");
    assert.match(d.detail, /in-process subscription/);
  });

  test("ready requires the handler in the SAME file as the port binding", () => {
    // A handler somewhere else in the tree — a fixture, an example, an unwired
    // helper — does not drain THIS server.
    const elsewhere = build({
      evidence: {
        ...NO_EVIDENCE,
        portBindings: ["src/server.js:10"],
        signalHandlers: ["src/shutdown.js:4"],
      },
    });
    assert.equal(dimension(elsewhere, "graceful-shutdown").status, "not-proven");

    const paired = build({
      evidence: {
        ...NO_EVIDENCE,
        portBindings: ["src/server.js:10"],
        signalHandlers: ["src/server.js:24"],
        drainedServerFiles: ["src/server.js"],
      },
    });
    const d = dimension(paired, "graceful-shutdown");
    assert.equal(d.status, "ready");
    assert.deepEqual(d.evidence, ["src/server.js"]);
  });

  test("the engine's own gap finding outranks positive evidence found elsewhere", () => {
    const d = dimension(
      build({
        evidence: {
          ...NO_EVIDENCE,
          portBindings: ["src/server.js:10", "src/admin.js:3"],
          signalHandlers: ["src/server.js:24"],
          drainedServerFiles: ["src/server.js"],
        },
        findings: [finding("require-sigterm-handler", 3, "src/admin.js")],
      }),
      "graceful-shutdown",
    );
    assert.equal(d.status, "gap", "a proven gap is not overridden by a handler somewhere");
  });

  test("an unparsed file means `no port binding` is unproven, not not-applicable", () => {
    const d = dimension(build({ evidence: { ...NO_EVIDENCE, unparsedFiles: ["src/server.js"] } }), "graceful-shutdown");
    assert.equal(d.status, "not-proven");
    assert.match(d.detail, /could not be parsed/);
  });

  test("no manifests means resource limits do not apply", () => {
    assert.equal(dimension(build(), "resource-limits").status, "not-applicable");
  });

  test("manifests present but the rule disabled is NOT PROVEN, not ready", () => {
    const d = dimension(
      build({ evidence: { ...NO_EVIDENCE, manifests: ["k8s/deploy.yaml"] }, rulesRun: new Set() }),
      "resource-limits",
    );
    assert.equal(d.status, "not-proven");
  });

  test("manifests present and clean is ready", () => {
    const d = dimension(build({ evidence: { ...NO_EVIDENCE, manifests: ["k8s/deploy.yaml"] } }), "resource-limits");
    assert.equal(d.status, "ready");
  });

  test("a dynamic route path could be the health probe, so absence is NOT PROVEN", () => {
    const withDynamic = build({ evidence: { ...NO_EVIDENCE, routePaths: ["<dynamic>", "/users"] } });
    assert.equal(dimension(withDynamic, "health-probes").status, "not-proven");

    const allStatic = build({ evidence: { ...NO_EVIDENCE, routePaths: ["/users"] } });
    assert.equal(dimension(allStatic, "health-probes").status, "gap", "every path readable, no probe → a real gap");
  });

  test("only unambiguous probe segments count as evidence of a probe", () => {
    for (const path of ["/healthz", "/health-check", "/ready", "/api/v1/readyz", "/liveness"]) {
      assert.equal(
        dimension(build({ evidence: { ...NO_EVIDENCE, routePaths: [path] } }), "health-probes").status,
        "ready",
        `expected ${path} to count as a probe`,
      );
    }
    // A video app's `/live/:channel` and a public `/status` page are as often a
    // real feature as a health check. Neither a pass nor a gap.
    for (const path of ["/live/:channel", "/status", "/ping", "/alive"]) {
      assert.equal(
        dimension(build({ evidence: { ...NO_EVIDENCE, routePaths: [path] } }), "health-probes").status,
        "not-proven",
        `expected ${path} to be ambiguous`,
      );
    }
    // `/health-tips` is a content route: the segment is `healthtips`.
    assert.equal(
      dimension(build({ evidence: { ...NO_EVIDENCE, routePaths: ["/health-tips"] } }), "health-probes").status,
      "gap",
    );
  });

  test("a probe endpoint is not called clean when the rule proving it did not run", () => {
    const d = dimension(
      build({ evidence: { ...NO_EVIDENCE, routePaths: ["/healthz"] }, rulesRun: new Set() }),
      "health-probes",
    );
    assert.equal(d.status, "not-proven", "disabling the rule must not flip gap → ready");
  });

  test("routes come from the route extractor, so a `(_req, res)` handler is still seen", () => {
    // The observability table only lists routes whose handler could be
    // identified; the evidence pass does not depend on parameter naming.
    const d = dimension(
      build({ observability: obs([]), evidence: { ...NO_EVIDENCE, routePaths: ["/healthz"] } }),
      "health-probes",
    );
    assert.equal(d.status, "ready");
  });

  test("a liveness probe that touches a dependency is a gap even though a probe exists", () => {
    const d = dimension(
      build({
        evidence: { ...NO_EVIDENCE, routePaths: ["/healthz"] },
        findings: [finding("no-liveness-check-with-dependency")],
      }),
      "health-probes",
    );
    assert.equal(d.status, "gap");
    assert.match(d.detail, /restart a healthy process/);
  });

  test("no routes means the observability-backed dimensions do not apply", () => {
    const r = build();
    for (const id of ["request-correlation", "failure-logging", "outbound-timeouts", "route-error-handling"]) {
      assert.equal(dimension(r, id).status, "not-applicable", id);
    }
  });

  test("checks that returned NO verdict are not scored as ready", () => {
    // §151 returns "na" for a check it could not evaluate. Folding those into
    // "ready" scored an app with zero logging and zero timeouts at 100/100.
    const naOnly: ObservabilityReport = {
      routes: [
        {
          method: "get",
          path: "/users",
          normalizedFilePath: "src/routes.js",
          line: 1,
          checks: Object.fromEntries(CHECKS.map((c) => [c, "na"])),
          score: 100,
        },
      ],
      score: 100,
      summary: { routes: 1, checkPassRate: {} },
    };
    const r = build({ observability: naOnly });
    for (const id of ["request-correlation", "failure-logging", "outbound-timeouts", "route-error-handling"]) {
      const d = dimension(r, id);
      assert.equal(d.status, "not-proven", id);
      assert.match(d.detail, /nothing to pass or fail/);
    }
    // Only `no-exit-on-request-path` is genuinely provable here (the rule ran
    // and found nothing on a real route), so it alone is scored.
    assert.equal(r.summary.ready, 1);
    assert.equal(dimension(r, "no-exit-on-request-path").status, "ready");
  });

  test("a failing observability check becomes a gap that names the routes", () => {
    const r = build({ observability: obs([route("/a", ["correlation-id"]), route("/b")]) });
    const d = dimension(r, "request-correlation");
    assert.equal(d.status, "gap");
    assert.match(d.detail, /1 of 2 route\(s\)/);
    assert.ok(d.evidence.length > 0, "the failing route is cited");
    assert.equal(dimension(r, "failure-logging").status, "ready", "the other checks are independent");
  });

  test("`no broken retry policy` is never reported as ready", () => {
    const d = dimension(build(), "resilience-policy");
    assert.equal(d.status, "not-proven", "absence of a bad policy is not presence of a good one");
    assert.match(d.detail, /not something this report can prove/);
  });

  test("a broken retry policy IS a gap", () => {
    const d = dimension(build({ findings: [finding("no-infinite-retry-without-backoff")] }), "resilience-policy");
    assert.equal(d.status, "gap");
  });
});

describe("readiness — the score only counts what was assessed", () => {
  test("not-applicable and not-proven are excluded from the denominator", () => {
    const r = build({
      observability: obs([route("/healthz")]),
      evidence: {
        ...NO_EVIDENCE,
        portBindings: ["s.js:1"],
        signalHandlers: ["s.js:2"],
        drainedServerFiles: ["s.js"],
        routePaths: ["/healthz"],
      },
    });
    const assessed = r.summary.ready + r.summary.gaps;
    assert.ok(assessed > 0);
    assert.equal(r.summary.notApplicable + r.summary.notProven, r.dimensions.length - assessed);
    assert.equal(r.score, Math.round((100 * r.summary.ready) / assessed));
  });

  test("the label thresholds match the rest of the tool (75 / 50)", () => {
    // Every assessable dimension green → 100 → "ready".
    const green = build({
      observability: obs([route("/healthz")]),
      evidence: {
        ...NO_EVIDENCE,
        portBindings: ["s.js:1"],
        signalHandlers: ["s.js:2"],
        drainedServerFiles: ["s.js"],
        routePaths: ["/healthz"],
      },
    });
    assert.equal(green.score, 100);
    assert.equal(green.label, "ready");

    // Everything that can fail, failing.
    const red = build({
      observability: obs([route("/users", CHECKS)]),
      evidence: { ...NO_EVIDENCE, portBindings: ["s.js:1"], routePaths: ["/users"] },
      findings: [
        finding("require-sigterm-handler"),
        finding("no-process-exit-in-request-path"),
        finding("no-retry-amplification"),
      ],
    });
    assert.equal(red.score, 0);
    assert.equal(red.label, "not ready");
  });

  test("an incomplete scan is carried into the summary", () => {
    const r = build({ complete: false, parseFailures: 3 });
    assert.equal(r.summary.complete, false);
    assert.equal(r.summary.parseFailures, 3);
  });

  test("every dimension always explains itself", () => {
    for (const d of build().dimensions) {
      assert.ok(d.detail.length > 20, `${d.id} has no real explanation`);
      assert.ok(d.title.length > 0);
    }
  });
});

describe("readiness — determinism", () => {
  test("identical input yields identical output", () => {
    const input: ReadinessInput = {
      findings: [finding("require-sigterm-handler"), finding("no-retry-amplification")],
      rulesRun: ALL_RULES,
      observability: obs([route("/a", ["correlation-id"]), route("/healthz")]),
      evidence: { ...NO_EVIDENCE, portBindings: ["s.js:1"], manifests: ["k8s/a.yaml"] },
      complete: true,
      parseFailures: 0,
    };
    assert.equal(JSON.stringify(buildReadinessReport(input)), JSON.stringify(buildReadinessReport(input)));
  });

  test("the dimension order is fixed", () => {
    assert.deepEqual(
      build().dimensions.map((d) => d.id),
      [
        "graceful-shutdown",
        "health-probes",
        "request-correlation",
        "failure-logging",
        "outbound-timeouts",
        "route-error-handling",
        "no-exit-on-request-path",
        "resource-limits",
        "resilience-policy",
      ],
    );
  });
});

describe("collectReadinessEvidence — applicability comes from the tree, not from findings", () => {
  const makeProject = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "nd-ready-"));
    await writeFile(join(dir, "package.json"), `{ "name": "r", "version": "1.0.0", "type": "module" }`);
    for (const [rel, src] of Object.entries(files)) {
      const full = join(dir, rel);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, src);
    }
    return dir;
  };

  test("a port binding and a SIGTERM handler are found with their locations", async () => {
    const dir = await makeProject({
      "src/server.js": `import express from "express";\nconst app = express();\napp.listen(3000);\nprocess.on("SIGTERM", () => server.close());\n`,
    });
    try {
      const e = await collectReadinessEvidence(dir);
      assert.deepEqual(e.portBindings, ["src/server.js:3"]);
      assert.deepEqual(e.signalHandlers, ["src/server.js:4"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("SIGTERM in a comment or a string is not a handler", async () => {
    const dir = await makeProject({
      "src/server.js": `app.listen(3000);\n// TODO: handle SIGTERM\nconst msg = "send SIGTERM to stop";\n`,
    });
    try {
      const e = await collectReadinessEvidence(dir);
      assert.deepEqual(e.portBindings, ["src/server.js:1"]);
      assert.deepEqual(e.signalHandlers, [], "the word is not the registration");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("SIGINT counts as a shutdown signal; SIGUSR2 does not", async () => {
    const dir = await makeProject({
      "src/a.js": `app.listen(1);\nprocess.on("SIGINT", stop);\n`,
      "src/b.js": `app.listen(2);\nprocess.on("SIGUSR2", reload);\n`,
    });
    try {
      const e = await collectReadinessEvidence(dir);
      assert.deepEqual(e.signalHandlers, ["src/a.js:2"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("only Kubernetes-shaped YAML counts as a manifest", async () => {
    const dir = await makeProject({
      "k8s/deploy.yaml": `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n`,
      "config/app.yml": `port: 3000\nlogLevel: info\n`,
    });
    try {
      const e = await collectReadinessEvidence(dir);
      assert.deepEqual(e.manifests, ["k8s/deploy.yaml"], "an app config file is not a manifest");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an empty project yields empty evidence rather than throwing", async () => {
    const dir = await makeProject({});
    try {
      const e = await collectReadinessEvidence(dir);
      assert.deepEqual(e, {
        portBindings: [],
        signalHandlers: [],
        drainedServerFiles: [],
        manifests: [],
        routePaths: [],
        unparsedFiles: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("evidence collection is deterministic", async () => {
    const dir = await makeProject({
      "src/b.js": `app.listen(2);\nprocess.on("SIGTERM", stop);\n`,
      "src/a.js": `server.listen(1);\n`,
    });
    try {
      const a = await collectReadinessEvidence(dir);
      const b = await collectReadinessEvidence(dir);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
      assert.deepEqual(a.portBindings, ["src/a.js:1", "src/b.js:1"], "sorted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readiness — CLI recognition", () => {
  // The dispatch switch ends in `case "scan": default:`, so a command that is
  // added to the union but not to the recognition Set silently runs a full scan
  // instead. That failure is invisible without this test.
  test("`readiness` and its aliases all resolve to the same command", () => {
    assert.equal(parseArgs(["readiness"]).command, "readiness");
    assert.equal(parseArgs(["ops"]).command, "readiness");
    assert.equal(parseArgs(["launch-review"]).command, "readiness");
  });

  test("a directory argument is carried through as a positional", () => {
    const args = parseArgs(["readiness", "packages/api"]);
    assert.equal(args.command, "readiness");
    assert.deepEqual(args.positionals, ["packages/api"]);
  });

  test("--json is honored", () => {
    assert.equal(parseArgs(["readiness", "--json"]).json, true);
    assert.equal(parseArgs(["readiness", "--json-compact"]).jsonCompact, true);
  });
});
