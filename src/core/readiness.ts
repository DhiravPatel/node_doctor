/**
 * §182 — Operational-Readiness Score (`node-doctor readiness`).
 *
 * "Is the code good?" and "can this be run in production?" are different
 * questions, and the health score answers only the first. A 100/100 codebase
 * with no SIGTERM handler drops every in-flight request on every deploy; a
 * service with no correlation ID in its logs is undebuggable at 3am however
 * clean its functions are. This is the number an SRE asks for before a launch
 * review, assembled from evidence rather than from a checklist someone filled in
 * by hand.
 *
 * IT ADDS NO NEW DETECTION. Every dimension is a roll-up of signals the engine
 * already computes: shipped diagnostics (§11 shutdown, §138 health, §136
 * timeouts, §25 limits) and the observability report (§151). What is new is the
 * aggregation, and the honesty model around it.
 *
 * THE HONESTY MODEL — this is the whole design.
 *
 * The obvious way to build this is a checklist where "no finding" means "pass".
 * That is a lie, and it is the specific lie this file exists to avoid. The
 * shutdown rule only fires in a file that binds a port; a repository with no
 * server produces zero findings, and reading that as "graceful shutdown: PASS"
 * would tell an SRE the opposite of the truth. Same for resource limits in a
 * repo with no manifests, and health probes in a repo with no routes.
 *
 * So every dimension carries FOUR possible verdicts, and only two of them touch
 * the score:
 *
 *   ready           — positive evidence exists (counts toward the score)
 *   gap             — a rule proved the gap (counts against the score)
 *   not-applicable  — the dimension provably does not apply here
 *   not-proven      — it applies, but we could not establish either answer
 *                     (the rule was disabled, or the evidence is out of reach)
 *
 * `not-applicable` and `not-proven` are excluded from the denominator and
 * printed with their reason. A codebase where nothing could be assessed scores
 * `null`, not 100 — "I could not tell" and "you are ready" must never render the
 * same. That principle is the same one §160 and §163 are built on, and it is the
 * only thing that makes a number like this worth reading.
 *
 * WHY NOT REUSE THE HEALTH SCORE. `calculateScore` is a DENSITY model —
 * weighted findings per thousand lines — which answers "how defective is this
 * per unit of size". Operational readiness is a binary-capability question: a
 * five-line service and a 500,000-line service with no SIGTERM handler are
 * equally unshippable, but per-kLOC normalization would score the large one near
 * 100. The arithmetic here is the observability model instead (passed over
 * applicable), and the 75/50 label thresholds are kept so the number reads
 * coherently next to the other two scores.
 *
 * Deterministic: dimensions in a fixed order, evidence sorted, no clock, no
 * randomness, and the score a pure function of the counts.
 */

import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";

import { BUILTIN_IGNORES, type NodeDoctorConfig } from "./config.ts";
import { parseSource } from "./parse.ts";
import { attachParents, collectDescendants } from "./walk.ts";
import { getMethodName, getStaticStringValue, rootObjectName } from "./ast.ts";
import { createLocator } from "./location.ts";
import { extractRoutes } from "./api-surface.ts";
import { isTestFile } from "./test-file.ts";
import type { AstNode, Finding } from "./types.ts";
import type { ObservabilityReport } from "./observability.ts";

const SOURCE_GLOB = "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";
const MANIFEST_GLOB = "**/*.{yml,yaml}";

/** Listener registrars for `process.on("SIGTERM", …)`. */
const LISTENER_METHODS = new Set([
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
]);

/** Signals a container runtime sends to ask for a graceful stop. */
const SHUTDOWN_SIGNALS = new Set(["SIGTERM", "SIGINT"]);

export type ReadinessStatus = "ready" | "gap" | "not-applicable" | "not-proven";

export interface ReadinessDimension {
  id: string;
  title: string;
  status: ReadinessStatus;
  /** Why this verdict — always specific, never "n/a". */
  detail: string;
  /** `file:line` (or path) evidence, sorted. Empty when there is none to give. */
  evidence: string[];
}

export type ReadinessLabel = "ready" | "needs work" | "not ready" | "unscored";

export interface ReadinessReport {
  /**
   * 0–100 over ASSESSED dimensions only (ready / (ready + gap)), or null when
   * nothing could be assessed. Null is a real answer, not a zero.
   */
  score: number | null;
  label: ReadinessLabel;
  dimensions: ReadinessDimension[];
  summary: {
    ready: number;
    gaps: number;
    notApplicable: number;
    notProven: number;
    /** Files the scan could not parse — anything here makes the score partial. */
    parseFailures: number;
    complete: boolean;
  };
}

/** Applicability evidence gathered from the tree, independent of any finding. */
export interface ReadinessEvidence {
  /** `file:line` of every `.listen(<port>)` — proof this process serves traffic. */
  portBindings: string[];
  /** `file:line` of every `process.on("SIGTERM"|"SIGINT", …)`. */
  signalHandlers: string[];
  /**
   * Files that BOTH bind a port and register a shutdown signal handler. The
   * pairing is what matters: a handler in some other module proves nothing about
   * the server, and an adversarial hunt showed the unpaired version reporting
   * "ready" for a repository whose only handler lived in a test fixture.
   */
  drainedServerFiles: string[];
  /** Kubernetes-shaped manifests actually present, normalized paths. */
  manifests: string[];
  /** Route paths registered anywhere in the tree, from the route extractor. */
  routePaths: string[];
  /**
   * Files that could not be parsed. Any of these makes "we found no X" mean
   * "we could not look everywhere", which must not render as a clean answer.
   */
  unparsedFiles: string[];
}

export interface ReadinessInput {
  findings: readonly Finding[];
  /**
   * Diagnostic ids that ACTUALLY RAN. A rule the user turned off, or one whose
   * capability gate was not met, cannot prove anything — its dimension becomes
   * `not-proven` rather than silently passing.
   */
  rulesRun: ReadonlySet<string>;
  observability: ObservabilityReport;
  evidence: ReadinessEvidence;
  complete: boolean;
  parseFailures: number;
}

// ---------------------------------------------------------------------------
// Evidence collection — one pass, only what the applicability tests need.
// ---------------------------------------------------------------------------

const site = (normalizedFilePath: string, line: number): string => `${normalizedFilePath}:${line}`;

/**
 * A Kubernetes manifest, cheaply: both `apiVersion:` and `kind:` at the start of
 * a line. Deliberately not a YAML parse — this establishes that the resource-
 * limits dimension APPLIES, and a wrong answer here costs an applicability call,
 * never a finding.
 */
const looksLikeK8sManifest = (text: string): boolean =>
  /^\s*apiVersion\s*:/m.test(text) && /^\s*kind\s*:/m.test(text);

/**
 * Paths whose contents describe how the code is tested, not how it is deployed.
 * A `app.listen(0)` in a supertest file is not a production server, and a
 * SIGTERM handler in a fixture is not this service's shutdown path.
 */
const NON_PRODUCTION_PATH =
  /(^|\/)(tests?|spec|specs|e2e|__tests__|__mocks__|__fixtures__|fixtures|examples?|benchmarks?|bench)\//i;

/**
 * Is this `.listen(...)` binding a PORT, or subscribing to something? An
 * in-process bus (`bus.listen("orders", handler)`) shares the method name, and
 * counting it made a worker with no HTTP surface report a missing SIGTERM
 * handler for a server it does not have. A string or template first argument is
 * a topic name, never a port.
 */
const isPortBinding = (call: AstNode): boolean => {
  const args = (call.arguments as AstNode[] | undefined) ?? [];
  const first = args[0];
  if (!first) return true; // `app.listen()` — Express picks a port
  if (first.type === "TemplateLiteral") return false;
  if (first.type === "Literal") return typeof first.value === "number";
  return true;
};

export const collectReadinessEvidence = async (
  rootDirectory: string,
  options: { config?: NodeDoctorConfig } = {},
): Promise<ReadinessEvidence> => {
  const config = options.config ?? {};
  const fg = (await import("fast-glob")).default;
  const ignore = [...BUILTIN_IGNORES, ...(config.ignore ?? [])];

  const sourceFiles = (
    await fg([SOURCE_GLOB], {
      cwd: rootDirectory,
      ignore,
      absolute: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    })
  ).sort();

  const portBindings: string[] = [];
  const signalHandlers: string[] = [];
  const drainedServerFiles: string[] = [];
  const routePaths: string[] = [];
  const unparsedFiles: string[] = [];

  for (const filePath of sourceFiles) {
    let sourceText: string;
    try {
      sourceText = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const normalizedFilePath = relative(rootDirectory, filePath).split(sep).join("/");
    const parsed = parseSource(filePath, sourceText);
    if (parsed.parseFailed) {
      unparsedFiles.push(normalizedFilePath);
      continue;
    }
    attachParents(parsed.program);
    const locate = createLocator(sourceText);

    // Test and fixture code describes how the service is TESTED. Reading a
    // fixture's SIGTERM handler as this service's shutdown path is exactly the
    // blind spot this report exists to avoid.
    if (NON_PRODUCTION_PATH.test(normalizedFilePath) || isTestFile(parsed.program, normalizedFilePath)) continue;

    for (const route of extractRoutes(parsed.program, normalizedFilePath, locate)) routePaths.push(route.path);

    let filePorts = 0;
    let fileSignals = 0;
    for (const call of collectDescendants(
      parsed.program,
      (n) => n.type === "CallExpression",
      undefined,
      true,
    )) {
      const method = getMethodName(call);
      if (!method) continue;

      if (method === "listen") {
        if (!isPortBinding(call)) continue;
        filePorts += 1;
        portBindings.push(site(normalizedFilePath, locate(call.start as number).line));
        continue;
      }
      if (LISTENER_METHODS.has(method) && rootObjectName(call) === "process") {
        const signal = getStaticStringValue(((call.arguments as AstNode[] | undefined) ?? [])[0]);
        if (signal !== null && SHUTDOWN_SIGNALS.has(signal)) {
          fileSignals += 1;
          signalHandlers.push(site(normalizedFilePath, locate(call.start as number).line));
        }
      }
    }
    if (filePorts > 0 && fileSignals > 0) drainedServerFiles.push(normalizedFilePath);
  }

  const manifestFiles = (
    await fg([MANIFEST_GLOB], {
      cwd: rootDirectory,
      ignore,
      absolute: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    })
  ).sort();

  const manifests: string[] = [];
  for (const filePath of manifestFiles) {
    try {
      const text = await readFile(filePath, "utf8");
      if (looksLikeK8sManifest(text)) {
        manifests.push(relative(rootDirectory, filePath).split(sep).join("/"));
      }
    } catch {
      // Unreadable is not evidence either way.
    }
  }

  return {
    portBindings: portBindings.sort(),
    signalHandlers: signalHandlers.sort(),
    drainedServerFiles: drainedServerFiles.sort(),
    manifests: manifests.sort(),
    routePaths: [...new Set(routePaths)].sort(),
    unparsedFiles: unparsedFiles.sort(),
  };
};

// ---------------------------------------------------------------------------
// Dimension assembly.
// ---------------------------------------------------------------------------

/** Path segment vocabulary for probe routes, matching §138's own definition. */
const norm = (seg: string): string => seg.toLowerCase().replace(/[-_]/g, "");
const pathSegments = (path: string): string[] =>
  path
    .replace(/[?#].*$/, "")
    .split("/")
    .filter(Boolean)
    .map(norm);
/**
 * Segments that can only plausibly be a probe. §138's own vocabulary is wider,
 * because being wrong there costs a missed finding; being wrong HERE costs a
 * "ready" verdict, so this list is the strict subset. A hunt found `/live` and
 * `/status` scoring a video app 100/100 on the strength of `/live/:channel` and
 * a public status page.
 */
const PROBE_SEGMENTS = new Set([
  "healthz",
  "healthcheck",
  "healthchecks",
  "health",
  "livez",
  "liveness",
  "readyz",
  "readiness",
  "ready",
]);

/**
 * Segments that MIGHT be a probe and might be an ordinary route. Their presence
 * makes the answer unproven — never a pass, never a gap.
 */
const AMBIGUOUS_PROBE_SEGMENTS = new Set(["live", "alive", "ping", "status"]);

const MAX_EVIDENCE = 6;

const trim = (items: string[]): string[] => [...new Set(items)].sort().slice(0, MAX_EVIDENCE);

export const buildReadinessReport = (input: ReadinessInput): ReadinessReport => {
  const { findings, rulesRun, observability, evidence } = input;

  const findingsFor = (ruleId: string): Finding[] => findings.filter((f) => f.diagnostic === ruleId);
  const sitesFor = (ruleId: string): string[] =>
    findingsFor(ruleId).map((f) => site(f.normalizedFilePath, f.line));
  const ran = (...ruleIds: string[]): boolean => ruleIds.every((id) => rulesRun.has(id));

  const routeCount = observability.summary.routes;

  /** Routes failing one observability check, as `file:line` sites. */
  const failing = (check: string): string[] =>
    observability.routes
      .filter((r) => r.checks[check] === "fail")
      .map((r) => site(r.normalizedFilePath, r.line));

  /** Routes where the check actually returned a verdict of "pass". */
  const passing = (check: string): number =>
    observability.routes.filter((r) => r.checks[check] === "pass").length;

  /**
   * A dimension backed purely by observability: applicable when there are
   * routes, ready when no route fails the check.
   */
  const observabilityDimension = (
    id: string,
    title: string,
    check: string,
    readyDetail: string,
    gapDetail: string,
  ): ReadinessDimension => {
    if (routeCount === 0) {
      return {
        id,
        title,
        status: "not-applicable",
        detail: "No HTTP routes were found, so there is nothing for this to apply to.",
        evidence: [],
      };
    }
    const fails = failing(check);
    if (fails.length > 0) {
      return {
        id,
        title,
        status: "gap",
        detail: `${fails.length} of ${routeCount} route(s): ${gapDetail}`,
        evidence: trim(fails),
      };
    }
    // No failures is NOT the same as evidence of success. §151 returns "na" for
    // a check it could not evaluate — a handler with no outbound call has no
    // timeout to verify — and folding those into "ready" scored an app with zero
    // logging, zero error handling and zero timeouts at 100/100. A dimension is
    // ready only when at least one route actually PASSED.
    if (passing(check) === 0) {
      return {
        id,
        title,
        status: "not-proven",
        detail: `No route was actually verified for this: the check returned no verdict on any of the ${routeCount} route(s), so there is nothing to pass or fail.`,
        evidence: [],
      };
    }
    return { id, title, status: "ready", detail: readyDetail, evidence: [] };
  };

  const dimensions: ReadinessDimension[] = [];

  // 1. Graceful shutdown ----------------------------------------------------
  dimensions.push(
    (() => {
      const id = "graceful-shutdown";
      const title = "Graceful shutdown";
      const gapSites = sitesFor("require-sigterm-handler");
      // The rule recognizes any `.listen(...)`, including an in-process bus
      // subscription (`bus.listen("orders.created", handler)`). Corroborating it
      // against evidence that a PORT is bound in that same file keeps a worker
      // with no HTTP surface from being told its server cannot drain.
      const boundFiles = new Set(evidence.portBindings.map((s) => s.slice(0, s.lastIndexOf(":"))));
      const corroborated = gapSites.filter((s) => boundFiles.has(s.slice(0, s.lastIndexOf(":"))));

      // The engine's own finding OUTRANKS positive evidence found elsewhere: it
      // proves a specific server file has no handler, and a handler in some
      // other module does not drain that server.
      if (corroborated.length > 0) {
        return {
          id,
          title,
          status: "gap" as const,
          detail:
            "A port is bound with no SIGTERM handler in the same file: every deploy and scale-down kills in-flight requests mid-response.",
          evidence: trim(corroborated),
        };
      }
      if (evidence.portBindings.length === 0) {
        if (gapSites.length > 0) {
          return {
            id,
            title,
            status: "not-proven" as const,
            detail:
              "`require-sigterm-handler` flagged a `.listen(...)` call, but no port-shaped binding was found — the call may be an in-process subscription rather than a server, so neither answer is asserted.",
            evidence: trim(gapSites),
          };
        }
        if (evidence.unparsedFiles.length > 0) {
          return {
            id,
            title,
            status: "not-proven" as const,
            detail: `No port binding was found, but ${evidence.unparsedFiles.length} file(s) could not be parsed — the server may be in one of them.`,
            evidence: trim(evidence.unparsedFiles),
          };
        }
        return {
          id,
          title,
          status: "not-applicable" as const,
          detail:
            "Nothing outside tests and fixtures binds a port, so there are no in-flight requests to drain on shutdown.",
          evidence: [],
        };
      }
      // Ready requires the handler and the port binding in the SAME file. A
      // SIGTERM handler in a fixture, an example, or an unwired helper module
      // proves nothing about this server — a hunt found all three.
      if (evidence.drainedServerFiles.length > 0) {
        return {
          id,
          title,
          status: "ready" as const,
          detail:
            "The file that binds the port also registers a SIGTERM/SIGINT handler, so a deploy can drain in-flight requests.",
          evidence: trim(evidence.drainedServerFiles),
        };
      }
      if (!ran("require-sigterm-handler")) {
        return {
          id,
          title,
          status: "not-proven" as const,
          detail:
            "No SIGTERM handler was found beside the port binding, but `require-sigterm-handler` did not run (disabled in config) — this is unverified, not clean.",
          evidence: trim(evidence.portBindings),
        };
      }
      // The rule ran, found nothing, and no handler sits beside the binding.
      // The rule's own gating (per-file) may differ from ours, so this is
      // reported as unproven rather than asserted as a gap.
      return {
        id,
        title,
        status: "not-proven" as const,
        detail:
          "A port is bound, and no shutdown handler was found in that file — but `require-sigterm-handler` did not flag it either, so the two signals disagree and neither is asserted.",
        evidence: trim(evidence.portBindings),
      };
    })(),
  );

  // 2. Health & readiness probes -------------------------------------------
  dimensions.push(
    (() => {
      const id = "health-probes";
      const title = "Health & readiness probes";
      const livenessFindings = sitesFor("no-liveness-check-with-dependency");
      if (livenessFindings.length > 0) {
        return {
          id,
          title,
          status: "gap" as const,
          detail:
            "A liveness probe depends on an external service, so one slow dependency makes the orchestrator restart a healthy process — and restart it again after every restart.",
          evidence: trim(livenessFindings),
        };
      }

      // Route paths come from the route EXTRACTOR, not from the observability
      // table: that table only lists routes whose handler could be identified,
      // and a handler written `(_req, res)` is invisible to it — which produced
      // the categorical claim "no probe endpoint" for a repo that had one.
      const paths = evidence.routePaths;
      if (paths.length === 0) {
        return {
          id,
          title,
          status: "not-applicable" as const,
          detail: "No HTTP routes were found outside tests, so there is nothing to probe.",
          evidence: [],
        };
      }

      const probes = paths.filter((p) => pathSegments(p).some((seg) => PROBE_SEGMENTS.has(seg)));
      if (probes.length > 0) {
        if (!ran("no-liveness-check-with-dependency")) {
          return {
            id,
            title,
            status: "not-proven" as const,
            detail: `${probes.length} probe endpoint(s) found, but \`no-liveness-check-with-dependency\` did not run, so whether they depend on an external service is unverified.`,
            evidence: trim(probes),
          };
        }
        return {
          id,
          title,
          status: "ready" as const,
          detail: `${probes.length} probe endpoint(s) found, none of which depend on an external service.`,
          evidence: trim(probes),
        };
      }

      // A `/status` page or a video app's `/live/:channel` is not evidence of a
      // probe — but it is not evidence of its absence either.
      const ambiguous = paths.filter((p) => pathSegments(p).some((seg) => AMBIGUOUS_PROBE_SEGMENTS.has(seg)));
      if (ambiguous.length > 0) {
        return {
          id,
          title,
          status: "not-proven" as const,
          detail: `No unambiguous probe endpoint, but ${ambiguous.length} route(s) could be one — a \`/status\` or \`/live\` path is as often a real feature as a health check.`,
          evidence: trim(ambiguous),
        };
      }
      const dynamic = paths.filter((p) => p === "<dynamic>");
      if (dynamic.length > 0 || evidence.unparsedFiles.length > 0) {
        return {
          id,
          title,
          status: "not-proven" as const,
          detail: `No probe endpoint was found, but ${dynamic.length} route path(s) are computed at runtime and ${evidence.unparsedFiles.length} file(s) could not be parsed — the probe may be among them.`,
          evidence: trim([...dynamic, ...evidence.unparsedFiles]),
        };
      }
      return {
        id,
        title,
        status: "gap" as const,
        detail:
          "No liveness or readiness endpoint among the routes — an orchestrator has no way to tell a wedged process from a healthy one.",
        evidence: [],
      };
    })(),
  );

  // 3–6. Observability-backed dimensions -----------------------------------
  dimensions.push(
    observabilityDimension(
      "request-correlation",
      "Request correlation",
      "correlation-id",
      "Every route carries a request/correlation id, so a log line can be tied back to the request that produced it.",
      "no request or correlation id, so their log lines cannot be tied to a request",
    ),
    observabilityDimension(
      "failure-logging",
      "Failure logging",
      "logs-on-failure",
      "Every route logs on its failure path.",
      "an error path with no log, so the failure is invisible in production",
    ),
    observabilityDimension(
      "outbound-timeouts",
      "Outbound timeouts",
      "timed-external-calls",
      "Every outbound call from a route carries a timeout.",
      "an outbound call with no timeout, so one slow dependency holds the request open indefinitely",
    ),
    observabilityDimension(
      "route-error-handling",
      "Route error handling",
      "error-handling",
      "Every route has an error path.",
      "no error path, so a rejection escapes to the framework's default handler",
    ),
  );

  // 7. No hard exit on a request path --------------------------------------
  dimensions.push(
    (() => {
      const id = "no-exit-on-request-path";
      const title = "No hard exit on a request path";
      if (routeCount === 0) {
        return {
          id,
          title,
          status: "not-applicable" as const,
          detail: "No HTTP routes were found.",
          evidence: [],
        };
      }
      if (!ran("no-process-exit-in-request-path")) {
        return {
          id,
          title,
          status: "not-proven" as const,
          detail: "`no-process-exit-in-request-path` did not run, so this could not be checked.",
          evidence: [],
        };
      }
      const sites = sitesFor("no-process-exit-in-request-path");
      return sites.length === 0
        ? {
            id,
            title,
            status: "ready" as const,
            detail: "No request path calls `process.exit()`.",
            evidence: [],
          }
        : {
            id,
            title,
            status: "gap" as const,
            detail:
              "A request path calls `process.exit()`: one crafted request takes down the process and every other in-flight request with it.",
            evidence: trim(sites),
          };
    })(),
  );

  // 8. Container resource limits -------------------------------------------
  dimensions.push(
    (() => {
      const id = "resource-limits";
      const title = "Container resource limits";
      if (evidence.manifests.length === 0) {
        return {
          id,
          title,
          status: "not-applicable" as const,
          detail: "No Kubernetes manifests were found in this repository.",
          evidence: [],
        };
      }
      if (!ran("k8s-missing-resource-limits")) {
        return {
          id,
          title,
          status: "not-proven" as const,
          detail: "`k8s-missing-resource-limits` did not run, so the manifests were not checked.",
          evidence: trim(evidence.manifests),
        };
      }
      const sites = sitesFor("k8s-missing-resource-limits");
      return sites.length === 0
        ? {
            id,
            title,
            status: "ready" as const,
            detail: `${evidence.manifests.length} manifest(s), all declaring resource limits.`,
            evidence: trim(evidence.manifests),
          }
        : {
            id,
            title,
            status: "gap" as const,
            detail:
              "A container declares no resource limits, so one leak can starve every other pod on the node.",
            evidence: trim(sites),
          };
    })(),
  );

  // 9. Resilience policy — one-sided, and labelled as such ------------------
  dimensions.push(
    (() => {
      const id = "resilience-policy";
      const title = "Retry & timeout policy";
      const RULES = [
        "no-infinite-retry-without-backoff",
        "no-retry-amplification",
        "no-inverted-timeout-budget",
      ];
      const sites = RULES.flatMap(sitesFor);
      if (sites.length > 0) {
        return {
          id,
          title,
          status: "gap" as const,
          detail:
            "A retry or timeout policy amplifies failure rather than containing it — a retry without backoff, nested retries multiplying the load, or an inner timeout longer than the outer one.",
          evidence: trim(sites),
        };
      }
      if (!ran(...RULES)) {
        return {
          id,
          title,
          status: "not-proven" as const,
          detail: "Not all retry/timeout rules ran, so this could not be checked.",
          evidence: [],
        };
      }
      // Nothing fired — but absence of a bad policy is not presence of a good
      // one. Proving a service HAS a retry policy is detection this report
      // deliberately does not add, so this is reported honestly as unproven.
      return {
        id,
        title,
        status: "not-proven" as const,
        detail:
          "No broken retry or timeout policy was found. Whether a deliberate policy EXISTS is not something this report can prove, so it is not scored as ready.",
        evidence: [],
      };
    })(),
  );

  const ready = dimensions.filter((d) => d.status === "ready").length;
  const gaps = dimensions.filter((d) => d.status === "gap").length;
  const notApplicable = dimensions.filter((d) => d.status === "not-applicable").length;
  const notProven = dimensions.filter((d) => d.status === "not-proven").length;

  const assessed = ready + gaps;
  const score = assessed === 0 ? null : Math.round((100 * ready) / assessed);
  const label: ReadinessLabel =
    score === null ? "unscored" : score >= 75 ? "ready" : score >= 50 ? "needs work" : "not ready";

  return {
    score,
    label,
    dimensions,
    summary: {
      ready,
      gaps,
      notApplicable,
      notProven,
      parseFailures: input.parseFailures,
      complete: input.complete,
    },
  };
};
