/**
 * §50 — the conventions generator.
 *
 * node.doctor's thesis is that agents write the Node code, and the cheapest defect
 * is the one that is never written. A scan corrects; a conventions file *prevents*.
 * So we emit `AGENTS.md` / `CLAUDE.md` / `.cursorrules` / `.windsurfrules` derived
 * from the project's OWN detected stack — the Express-4 async-rejection rule only
 * appears when Express 4 is actually installed, the Prisma N+1 rule only when
 * Prisma is — because a rules file full of advice for libraries the project does
 * not use trains the agent to skim it.
 *
 * The citations are gated the same way. A rule that cites `node-doctor/<id>` is
 * claiming "the scanner enforces this here", so the citation is emitted only when
 * that diagnostic's own `requires`/`disabledWhen` are satisfied by this project's
 * capabilities — a Drizzle project is not told that `require-pagination-limit`
 * (Prisma-only) has its back. The predicate is `capabilitiesSatisfied`, not
 * `shouldEnableDiagnostic`: an opt-in diagnostic is still a real, enableable rule,
 * whereas a capability-gated one can never run here at all. Citing a rule the
 * scanner will never report is the one failure mode that teaches an agent to
 * distrust the whole file.
 *
 * `generateConventions` is pure (ProjectInfo in, markdown out): no fs, no clock, no
 * absolute paths in the content, so identical capabilities always produce a
 * byte-identical file. `writeConventions` owns discovery and the (non-destructive)
 * write.
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { capabilitiesSatisfied, discoverProject } from "./project.ts";
import type { ProjectInfo } from "./project.ts";
import { DIAGNOSTICS_BY_ID } from "./registry.ts";

export interface ConventionTarget {
  /** Stable id used by `--target`. */
  id: string;
  label: string;
  /** Path relative to the project root. */
  path: string;
}

/** Where each agent client reads project-level conventions from. */
export const CONVENTION_TARGETS: ConventionTarget[] = [
  { id: "agents", label: "AGENTS.md (cross-client)", path: "AGENTS.md" },
  { id: "claude", label: "Claude Code", path: "CLAUDE.md" },
  { id: "cursor", label: "Cursor", path: ".cursorrules" },
  { id: "windsurf", label: "Windsurf", path: ".windsurfrules" },
];

// ---------------------------------------------------------------------------
// Formatting helpers — a fixed wrap width keeps the output stable and diffable.
// ---------------------------------------------------------------------------

const WRAP = 88;

/** Wrap on spaces only (never inside a token), with a hanging indent. */
const wrapWords = (text: string, hanging: string): string => {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length > WRAP) {
      lines.push(current);
      current = hanging + word;
    } else {
      current = `${current} ${word}`;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.join("\n");
};

const para = (text: string): string => wrapWords(text, "");
const bullet = (text: string): string => wrapWords(`- ${text}`, "  ");
const list = (items: readonly string[]): string => items.map(bullet).join("\n");
const section = (heading: string, items: readonly string[]): string => `## ${heading}\n\n${list(items)}`;

/** Does this diagnostic actually run for a project with these capabilities? */
const applies = (id: string, capabilities: Set<string>): boolean => {
  const diagnostic = DIAGNOSTICS_BY_ID.get(id);
  return diagnostic !== undefined && capabilitiesSatisfied(diagnostic, capabilities);
};

/**
 * Trailing citation for a rule: ` \`node-doctor/a\`, \`node-doctor/b\``, keeping the
 * declared order (never a Set/Map iteration) and dropping any id that cannot fire
 * for this project. Empty — not a dangling separator — when none apply.
 */
const cite = (capabilities: Set<string>, ...ids: readonly string[]): string => {
  const applicable = ids.filter((id) => applies(id, capabilities));
  if (applicable.length === 0) return "";
  return ` ${applicable.map((id) => `\`node-doctor/${id}\``).join(", ")}`;
};

/** Mid-sentence citation: ` (\`node-doctor/id\`)`, or nothing at all. */
const paren = (capabilities: Set<string>, id: string): string =>
  applies(id, capabilities) ? ` (\`node-doctor/${id}\`)` : "";

// ---------------------------------------------------------------------------
// Capability-derived content. Every table is an ordered array (never a Set/Map
// iteration) so section order is a property of this file, not of detection order.
// Bullets are functions of the capability set because their citations are.
// ---------------------------------------------------------------------------

/** A section body, rendered against the project's capabilities. */
type Bullets = (capabilities: Set<string>) => readonly string[];

interface GatedSection {
  /** Capability token that makes this section appear at all. */
  token: string;
  heading: string;
  bullets: Bullets;
}

const nodeMajorOf = (capabilities: Set<string>): number | null => {
  let lowest: number | null = null;
  for (const token of capabilities) {
    const match = token.match(/^node:(\d+)$/);
    if (!match) continue;
    const major = Number.parseInt(match[1]!, 10);
    if (lowest === null || major < lowest) lowest = major;
  }
  return lowest;
};

const EXPRESS_4: Bullets = (caps) => [
  `Express 4 does **not** catch a rejected promise from an \`async\` handler. Every async handler needs an explicit error path — a \`try/catch\` that calls \`next(err)\`, or one shared wrapper (\`const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)\`) used on every route. Without it a post-\`await\` throw hangs the client until the socket times out.${cite(caps, "express-async-handler-unprotected")}`,
  `\`res.json(...)\` does not end the function — \`return\` after you respond, or the next branch sends a second time and throws \`ERR_HTTP_HEADERS_SENT\`.${cite(caps, "express-missing-return-after-response", "no-send-after-next")}`,
  `Register exactly one 4-arity error middleware \`(err, req, res, next)\` **last**, and have it log the error server-side while sending the client a status and a generic message — never \`err.stack\` or a driver message.${cite(caps, "require-error-handling-middleware", "no-error-leak-to-client")}`,
  `Bound the body at the parser: \`express.json({ limit: "100kb" })\`. The default lets a single caller allocate megabytes per request.${cite(caps, "no-missing-body-size-limit")}`,
  `\`app.set("trust proxy", ...)\` takes a hop count or a subnet, never \`true\` — \`true\` lets any caller forge \`X-Forwarded-For\` and defeat rate limiting.${cite(caps, "no-trust-proxy-true")}`,
];

const EXPRESS_5: Bullets = (caps) => [
  `Express 5 forwards a rejected \`async\` handler to the error middleware, so no \`next(err)\` wrapper is needed — but the middleware has to exist. Register one 4-arity \`(err, req, res, next)\` handler last, or a rejection becomes a default 500 with a stack trace.${cite(caps, "require-error-handling-middleware")}`,
  `Still \`return\` after responding — Express 5 does not stop the function body, and a second send throws \`ERR_HTTP_HEADERS_SENT\`.${cite(caps, "express-missing-return-after-response", "no-send-after-next")}`,
  `The error middleware logs server-side and sends the client a status plus a generic message — never \`err.stack\` or a driver message.${cite(caps, "no-error-leak-to-client")}`,
  `Bound the body at the parser: \`express.json({ limit: "100kb" })\`.${cite(caps, "no-missing-body-size-limit")}`,
  `\`app.set("trust proxy", ...)\` takes a hop count or a subnet, never \`true\`.${cite(caps, "no-trust-proxy-true")}`,
];

const FASTIFY: Bullets = (caps) => [
  `Every route declares a \`schema\` (\`body\`, \`querystring\`, \`params\`, \`response\`). It is the validation boundary *and* the fast serializer — a route without one runs the handler on unvalidated input and serializes with the slow path.${cite(caps, "fastify-missing-schema")}`,
  `Either \`return\` the payload from an async handler or call \`reply.send(...)\` — never both, and never after an \`await\` that already replied.`,
  `Fastify awaits your handler, so a rejection reaches the error handler; set one explicitly (\`setErrorHandler\`) that logs the cause and replies with a generic body.${cite(caps, "no-error-leak-to-client")}`,
  `Set \`bodyLimit\` on the instance or the route rather than relying on the default — the Fastify default is 1 MiB, which is a ceiling, not a policy.`,
  `Log through \`request.log\` — it carries the request id; \`console.log\` does not and is not sampled.${cite(caps, "no-console-log-in-committed-code")}`,
];

const NEST: Bullets = (caps) => [
  `Register a global \`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })\` and give every route a DTO. Without \`whitelist\`, caller-supplied extra fields flow straight through the DTO into services and ORM calls.${cite(caps, "nest-missing-validation-pipe")}`,
  `Authorization belongs in a guard, not inline in the controller — an inline check is invisible to the next route that forgets it.`,
  `Throw \`HttpException\` subclasses and let one exception filter shape the response. Never pass an internal error's \`message\`/\`stack\` to the client.${cite(caps, "no-error-leak-to-client")}`,
  `Providers are process singletons: anything you cache in one needs an eviction story (max size or TTL), or it is a slow leak.${cite(caps, "no-unbounded-module-cache")}`,
  `Long work belongs in a queue processor, not in the request lifecycle — a blocking provider method stalls every concurrent request.`,
];

const KOA: Bullets = (caps) => [
  `\`await next()\` in **every** middleware. A missing \`await\` breaks downstream error propagation and lets the response finish before the downstream work does.`,
  `Raise with \`ctx.throw(status, message)\` and format it in one error middleware registered first; anything else escapes to the default handler.${cite(caps, "no-error-leak-to-client")}`,
  `Wrap the whole chain in \`app.on("error", ...)\` for logging — a swallowed \`catch\` in a middleware silently drops the request.${cite(caps, "no-swallowed-error-empty-catch")}`,
  `Bound the body parser explicitly (\`jsonLimit\`/\`formLimit\`); the body parser's default is not a size policy.`,
];

const HONO: Bullets = (caps) => [
  `Validate at the edge with a \`validator\` middleware and read \`c.req.valid(...)\` in the handler — never the raw \`c.req.json()\` shape.`,
  `Return a \`Response\` from every branch; a handler that falls through returns a 404 the caller cannot diagnose.`,
  `Use \`app.onError\`/\`app.notFound\` for the terminal cases, and keep the error body generic.${cite(caps, "no-error-leak-to-client")}`,
  `Handler code shared across runtimes must not reach for Node-only APIs (\`node:fs\`, \`node:child_process\`) unless the Node adapter is the only target.`,
];

const ADONIS: Bullets = (caps) => [
  `Validate every request through a validator (\`request.validateUsing(...)\`) and pass the validated object on — never \`request.all()\` straight into a Lucid model.`,
  `Authorization goes in a middleware or a bouncer policy, not in the controller body.`,
  `Let exceptions reach the exception handler and map them to a status there; do not build error responses per controller.${cite(caps, "no-error-leak-to-client")}`,
  `Lucid relations are loaded with \`preload\`, never with a query per model inside a loop.${cite(caps, "no-query-in-loop")}`,
];

const FRAMEWORK_SECTIONS: readonly GatedSection[] = [
  { token: "fastify", heading: "Fastify — the request path", bullets: FASTIFY },
  { token: "nest", heading: "NestJS — the request path", bullets: NEST },
  { token: "adonis", heading: "AdonisJS — the request path", bullets: ADONIS },
  { token: "koa", heading: "Koa — the request path", bullets: KOA },
  { token: "hono", heading: "Hono — the request path", bullets: HONO },
];

const sharedDataRules = (caps: Set<string>, label: string): readonly string[] => [
  `One client/pool for the process, created at module scope. A connection opened per request exhausts the pool under the first burst.${cite(caps, "no-db-connection-per-request")}`,
  `Never hold a transaction open across an HTTP call or any other network round trip — the connection is pinned for the whole latency of that call.${cite(caps, "no-external-call-inside-open-transaction")}`,
  `\`await\` every ${label} call. An un-awaited query is a floating promise: the handler responds before the write lands and the rejection is unhandled.${cite(caps, "no-missing-await-on-query")}`,
];

const DATA_SECTIONS: readonly GatedSection[] = [
  {
    token: "prisma",
    heading: "Data access — Prisma",
    bullets: (caps) => [
      `Never query inside a loop. One round trip for a set: \`findMany({ where: { id: { in: ids } } })\` with \`include\`/\`select\`, not a \`findUnique\` per element.${cite(caps, "no-query-in-loop")}`,
      `Every \`findMany\` carries \`take\` (plus \`cursor\`/\`skip\` for paging). An unbounded list query is fine on dev data and an OOM on production data.${cite(caps, "require-pagination-limit")}`,
      `Filter, sort, and aggregate in the query (\`where\`/\`orderBy\`), not with \`.filter()\` after the rows are already over the wire.${cite(caps, "no-findmany-then-filter-in-js")}`,
      `\`$queryRaw\` tagged templates bind their parameters; \`$queryRawUnsafe\` does not. Caller input never becomes SQL text.${cite(caps, "no-sql-template-interpolation")}`,
      ...sharedDataRules(caps, "Prisma"),
    ],
  },
  {
    token: "drizzle",
    heading: "Data access — Drizzle",
    bullets: (caps) => [
      `Never query inside a loop. One round trip for a set: \`.where(inArray(table.id, ids))\` plus a join, not a select per iteration.${cite(caps, "no-query-in-loop")}`,
      `\`.limit(n)\` on every list select — and an \`.offset()\`/cursor when the caller pages.${cite(caps, "require-pagination-limit")}`,
      `Filter and order in the query builder, not in JavaScript after the rows arrive.${cite(caps, "no-findmany-then-filter-in-js")}`,
      `The \`sql\` tagged template binds its interpolations; \`sql.raw\` does not. Never build a predicate by concatenating caller input.${cite(caps, "no-sql-template-interpolation")}`,
      ...sharedDataRules(caps, "Drizzle"),
    ],
  },
  {
    token: "sequelize",
    heading: "Data access — Sequelize",
    bullets: (caps) => [
      `Never query inside a loop. One round trip for a set: \`findAll({ where: { id: { [Op.in]: ids } }, include: [...] })\`, not \`findByPk\` per element.${cite(caps, "no-query-in-loop")}`,
      `\`limit\` on every \`findAll\` that can grow with the data.${cite(caps, "require-pagination-limit")}`,
      `\`sequelize.query(sql, { replacements })\` or \`bind\` — never an interpolated SQL string.${cite(caps, "no-sql-template-interpolation")}`,
      ...sharedDataRules(caps, "Sequelize"),
    ],
  },
  {
    token: "typeorm",
    heading: "Data access — TypeORM",
    bullets: (caps) => [
      `Never query inside a loop. One round trip for a set: \`find({ where: { id: In(ids) }, relations: { ... } })\`, not a \`findOne\` per element.${cite(caps, "no-query-in-loop")}`,
      `\`take\` on every \`find\`/query-builder call that returns a list.${cite(caps, "require-pagination-limit")}`,
      `\`.where("user.id = :id", { id })\` — the parameter object binds; a template literal spliced into \`where\` does not.${cite(caps, "no-sql-template-interpolation")}`,
      ...sharedDataRules(caps, "TypeORM"),
    ],
  },
  {
    token: "mongoose",
    heading: "Data access — Mongoose",
    bullets: (caps) => [
      `Never query inside a loop. One round trip for a set: \`find({ _id: { $in: ids } })\` with \`populate\`, not \`findById\` per element.${cite(caps, "no-query-in-loop")}`,
      `\`.limit(n)\` on every list query, and \`.lean()\` when you only read — hydrating documents you never mutate is pure overhead.${cite(caps, "require-pagination-limit")}`,
      `Coerce caller-controlled values to a scalar (\`String(req.query.q)\`) before they enter a filter. A JSON object from the body becomes a query operator (\`{ "$ne": null }\`) and turns a lookup into an auth bypass.${cite(caps, "no-nosql-object-injection")}`,
      ...sharedDataRules(caps, "Mongoose"),
    ],
  },
  {
    token: "knex",
    heading: "Data access — Knex",
    bullets: (caps) => [
      `Never query inside a loop. One round trip for a set: \`.whereIn("id", ids)\` plus a join, not \`.where("id", id)\` per iteration.${cite(caps, "no-query-in-loop")}`,
      `\`.limit(n)\` on every list query.${cite(caps, "require-pagination-limit")}`,
      `\`knex.raw("... = ?", [value])\` with bindings — never string concatenation into \`raw\`.${cite(caps, "no-sql-template-interpolation")}`,
      ...sharedDataRules(caps, "Knex"),
    ],
  },
];

const AUTH_SECTIONS: readonly GatedSection[] = [
  {
    token: "jsonwebtoken",
    heading: "Auth — jsonwebtoken",
    bullets: (caps) => [
      `\`jwt.verify(token, secret, { algorithms: ["HS256"] })\` for **any** authorization decision. \`jwt.decode\` only base64-decodes — it checks no signature, so a caller can mint whatever payload it likes.${cite(caps, "no-jwt-decode-as-verify")}`,
      `Always pass an explicit \`algorithms\` allowlist to \`verify\`; without it the token's own \`alg\` header picks the verifier. Never accept \`"none"\`.${cite(caps, "require-jwt-algorithms-allowlist", "no-jwt-none-algorithm")}`,
      `Always \`jwt.sign(payload, secret, { expiresIn: "15m" })\`. A token with no expiry is a permanent credential that no logout can revoke.${cite(caps, "jwt-missing-expiration")}`,
      `Read the secret from an env var validated at boot and fail fast if it is missing. \`process.env.JWT_SECRET || "dev-secret"\` ships the fallback to production.${cite(caps, "secret-in-env-fallback", "no-hardcoded-secret-literal")}`,
      `A JWT is signed, not encrypted — nothing secret goes in the payload.`,
    ],
  },
  {
    token: "jose",
    heading: "Auth — jose",
    bullets: (caps) => [
      `\`jwtVerify(token, key, { algorithms: [...], issuer, audience })\` for any authorization decision. \`decodeJwt\` parses without verifying and must never gate access.${cite(caps, "no-jwt-decode-as-verify")}`,
      `Pin \`algorithms\` explicitly and reject \`"none"\`; verify \`issuer\` and \`audience\` in the same call rather than afterwards.${cite(caps, "require-jwt-algorithms-allowlist", "no-jwt-none-algorithm")}`,
      `\`new SignJWT(claims).setIssuedAt().setExpirationTime("15m")\` — always an expiry.${cite(caps, "jwt-missing-expiration")}`,
      `Key material comes from validated env or a cached JWKS at boot, never a literal in source and never an \`||\` fallback.${cite(caps, "secret-in-env-fallback", "no-hardcoded-secret-literal")}`,
    ],
  },
];

const ESM_RULES: Bullets = (caps) => [
  `This package is ESM (\`"type": "module"\`): \`import\`/\`export\` only, and builtins carry the \`node:\` prefix — \`import { readFile } from "node:fs/promises"\`.${cite(caps, "prefer-node-protocol-imports")}`,
  `\`require\`, \`__dirname\`, and \`__filename\` do not exist. Use \`import.meta.dirname\`, or \`new URL("./file", import.meta.url)\` for a bundled asset.`,
  `Top-level \`await\` is available: do boot-time async work at module scope so a failure crashes the process, instead of firing a floating promise nobody awaits.`,
];

const CJS_RULES: Bullets = (caps) => [
  `This package is CommonJS: \`require\`/\`module.exports\`, with the \`node:\` prefix on builtins — \`require("node:fs/promises")\`.${cite(caps, "prefer-node-protocol-imports")}`,
  `There is no top-level \`await\`. Wrap boot in an async IIFE **with** a \`.catch\` that logs and exits non-zero; a boot promise without one fails silently and leaves a half-initialized process serving traffic.${cite(caps, "no-missing-catch-on-async-iife")}`,
  `An ESM-only dependency is reachable only through \`await import("pkg")\` from inside an async function — not \`require\`.`,
];

const TYPESCRIPT_RULES: Bullets = () => [
  `A value that crossed the network is \`unknown\` until it is validated. Typing a request body as a DTO interface is a compile-time assertion and checks nothing at runtime — parse and validate at the boundary, then trust the result.`,
  `\`catch (err: unknown)\` and narrow before reading \`.message\`; a thrown non-\`Error\` is normal in Node (drivers reject with plain objects).`,
  `Types do not survive to runtime — never rely on a type to bound a list, sanitize a string, or prove a field is present.`,
];

/** Express 5 only counts when Express itself is installed — `express:5` never stands alone. */
const isExpress5 = (capabilities: Set<string>): boolean =>
  capabilities.has("express") && capabilities.has("express:5");

/** The framework-appropriate answer to "where does a post-await rejection go?". */
const rejectionMechanism = (capabilities: Set<string>): string => {
  if (isExpress5(capabilities)) return "Express 5's automatic forwarding **plus** a registered error middleware";
  if (capabilities.has("express")) return "a `try/catch` that calls `next(err)`, or the shared async wrapper";
  if (capabilities.has("fastify")) return "the handler's own rejection reaching `setErrorHandler`";
  if (capabilities.has("nest")) return "an `HttpException` reaching the exception filter";
  if (capabilities.has("koa")) return "`ctx.throw` reaching the first middleware";
  if (capabilities.has("hono")) return "a thrown error reaching `app.onError`";
  if (capabilities.has("adonis")) return "the exception reaching the exception handler";
  return "an explicit `try/catch` or the framework's error hook";
};

const stackLines = (project: ProjectInfo): string[] => {
  const caps = project.capabilities;
  const lines: string[] = [];

  const major = nodeMajorOf(caps);
  lines.push(
    major === null
      ? "**Runtime** — Node.js, no `engines.node` pin (target the active LTS and keep CI on the same major)"
      : `**Runtime** — Node.js ${major}+ (\`engines.node\`)`,
  );
  lines.push(
    caps.has("esm")
      ? '**Modules** — ESM (`"type": "module"`)'
      : "**Modules** — CommonJS (no `\"type\": \"module\"`)",
  );
  lines.push(caps.has("typescript") ? "**Language** — TypeScript" : "**Language** — JavaScript");

  const frameworks: string[] = [];
  if (caps.has("express")) frameworks.push(isExpress5(caps) ? "Express 5" : "Express 4");
  for (const [token, label] of [
    ["fastify", "Fastify"],
    ["nest", "NestJS"],
    ["adonis", "AdonisJS"],
    ["koa", "Koa"],
    ["hono", "Hono"],
  ] as const) {
    if (caps.has(token)) frameworks.push(label);
  }
  if (frameworks.length > 0) lines.push(`**Framework** — ${frameworks.join(", ")}`);

  const data = DATA_SECTIONS.filter((s) => caps.has(s.token)).map((s) => s.heading.replace("Data access — ", ""));
  if (data.length > 0) lines.push(`**Data access** — ${data.join(", ")}`);

  const auth = AUTH_SECTIONS.filter((s) => caps.has(s.token)).map((s) => s.heading.replace("Auth — ", ""));
  if (auth.length > 0) lines.push(`**Auth** — ${auth.join(", ")}`);

  return lines;
};

const FOUR_QUESTIONS = (caps: Set<string>): string => {
  const items = [
    `**Where does a post-\`await\` rejection go?** Name the mechanism — ${rejectionMechanism(caps)}. An unhandled rejection after the first \`await\` hangs the client until the socket times out.`,
    `**Does anything block the event loop?** A \`*Sync\` call, a large \`JSON.parse\`, a CPU loop, or a backtracking-prone regex on the request path freezes *every* concurrent request, not just this one.${cite(caps, "no-sync-io-in-request-path", "no-large-json-parse-in-request-path", "no-redos-prone-regex")}`,
    `**Does the code fan out proportionally to caller input?** \`Promise.all\` over a caller-supplied array opens one socket or connection per element — bound the concurrency, or the first large request is a self-inflicted DoS.${cite(caps, "no-unbounded-promise-all")}`,
    `**Which values crossed the network, and where do they land?** Follow caller input to every sink: shell → \`execFile(cmd, [args])\`, never \`exec\` with an interpolated string${paren(caps, "no-exec-with-interpolation")}; SQL → bound parameters, never a template literal${paren(caps, "no-sql-template-interpolation")}; filesystem → resolve, then check containment against the base directory${paren(caps, "no-path-traversal")}; and no \`eval\`, \`new Function\`, or \`vm\` on caller data — there is no safe version${paren(caps, "no-eval-with-input")}.`,
  ];
  return [
    "## Every request handler — answer these four questions",
    "",
    para(
      "The scanner is deterministic and largely intra-file. A clean scan means \"no *detected* defect\", never \"correct\". Before you call a handler done, answer these yourself — then follow the call into each helper and answer them again there.",
    ),
    "",
    items.map((item, index) => wrapWords(`${index + 1}. ${item}`, "   ")).join("\n"),
  ].join("\n");
};

/** The version-sensitivity example, drawn from a dependency this project actually has. */
const versionExample = (capabilities: Set<string>): string => {
  if (isExpress5(capabilities)) return "the Express-4 async-handler rule does not apply to the Express 5 installed here";
  if (capabilities.has("express")) return "an async-handler bug on the Express 4 installed here is a non-issue on Express 5";
  return "a rule that holds for one major of a dependency often does not hold for the next";
};

const VERIFY = (capabilities: Set<string>): string => [
  "## Verify — do not guess",
  "",
  para(
    `Do not reason from memory about whether this code has these defects. Run the scanner: it resolves this project's actual installed versions, and the version changes the verdict (${versionExample(capabilities)}).`,
  ),
  "",
  "```bash",
  "npx node-doctor@latest .",
  "```",
  "",
  para(
    "Cheaper still, check the code *before* it reaches disk: with the node.doctor MCP server connected, call the `node_doctor_check_snippet` tool with the fragment you are about to write and fix what it reports first. Prevention costs one tool call; correction costs an edit, a re-scan, and a review.",
  ),
  "",
  para("Resolve every finding at or above `error` before declaring a backend task complete."),
].join("\n");

const STANCE = [
  "## The stance on suppressions",
  "",
  para(
    "Fix the root cause; never suppress. A finding names the exact mechanism to apply — apply it, do not paper over it and do not add a disable comment to make a scan pass. If a finding is wrong, say so explicitly and explain why: a false positive is a bug in the diagnostic, to be reported (`node-doctor explain <id>`), not silenced. Any suppression that does legitimately exist must carry a reason — one without is itself reported.",
  ),
].join("\n");

/**
 * Render the conventions markdown for a project. Pure and deterministic: the same
 * `ProjectInfo` always yields a byte-identical string (no clock, no fs, no paths).
 */
export const generateConventions = (project: ProjectInfo): string => {
  const caps = project.capabilities;
  const blocks: string[] = [];

  blocks.push(`# Node.js conventions — ${project.name}`);
  blocks.push(
    para(
      "Generated by node.doctor from this project's own `package.json`. It describes the stack that is actually installed here so that code written against it is right the first time, instead of being corrected afterwards. Regenerate after any dependency change.",
    ),
  );
  blocks.push(section("Detected stack", stackLines(project)));
  blocks.push(
    para(
      "Everything below is derived from that list. If a library is not named here, this project does not install it — do not write conventions for it, and do not assume one framework's error semantics apply to another.",
    ),
  );

  if (caps.has("express")) {
    blocks.push(
      section(
        isExpress5(caps) ? "Express 5 — the request path" : "Express 4 — the request path",
        isExpress5(caps) ? EXPRESS_5(caps) : EXPRESS_4(caps),
      ),
    );
  }
  for (const framework of FRAMEWORK_SECTIONS) {
    if (caps.has(framework.token)) blocks.push(section(framework.heading, framework.bullets(caps)));
  }
  for (const data of DATA_SECTIONS) {
    if (caps.has(data.token)) blocks.push(section(data.heading, data.bullets(caps)));
  }
  for (const auth of AUTH_SECTIONS) {
    if (caps.has(auth.token)) blocks.push(section(auth.heading, auth.bullets(caps)));
  }

  blocks.push(
    section(caps.has("esm") ? "Modules — ESM" : "Modules — CommonJS", caps.has("esm") ? ESM_RULES(caps) : CJS_RULES(caps)),
  );
  if (caps.has("typescript")) blocks.push(section("Language — TypeScript", TYPESCRIPT_RULES(caps)));

  blocks.push(FOUR_QUESTIONS(caps));
  blocks.push(VERIFY(caps));
  blocks.push(STANCE);

  return `${blocks.join("\n\n")}\n`;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export interface WriteConventionsOptions {
  /** Project directory to discover and write into. */
  rootDirectory: string;
  /** Target ids from `CONVENTION_TARGETS`; omit for all of them. */
  targets?: string[];
  /** Replace a file that already exists (default: keep it and report it skipped). */
  overwrite?: boolean;
}

export interface WriteConventionsResult {
  written: string[];
  skipped: string[];
}

/**
 * Discover the project, render its conventions, and write them to the selected
 * targets. Non-destructive by default: an existing file is a human's file until
 * `overwrite` says otherwise. Both result lists follow `CONVENTION_TARGETS` order,
 * never the caller's argument order, so the output is deterministic.
 */
export const writeConventions = async (options: WriteConventionsOptions): Promise<WriteConventionsResult> => {
  const requested = options.targets;
  if (requested) {
    for (const id of requested) {
      if (!CONVENTION_TARGETS.some((target) => target.id === id)) {
        throw new Error(
          `unknown conventions target "${id}". Known: ${CONVENTION_TARGETS.map((target) => target.id).join(", ")}`,
        );
      }
    }
  }

  const selected = CONVENTION_TARGETS.filter((target) => !requested || requested.includes(target.id));
  const project = await discoverProject(options.rootDirectory);
  const content = generateConventions(project);

  const written: string[] = [];
  const skipped: string[] = [];

  for (const target of selected) {
    const full = resolve(join(options.rootDirectory, target.path));
    if (!options.overwrite && (await exists(full))) {
      skipped.push(full);
      continue;
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    written.push(full);
  }

  return { written, skipped };
};
