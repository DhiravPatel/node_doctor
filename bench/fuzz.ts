/**
 * Fuzz harness (§18). Feeds generated and mutated sources to the analyzer and
 * checks three oracles:
 *   - crash:      lintSource must never throw (a parse gap is fine; a throw is not),
 *   - slow:       each file must analyze within a time budget,
 *   - invariant:  every finding must land inside the file, and two runs of the
 *                 same input must be byte-identical (determinism).
 *
 *   node bench/fuzz.ts [iterations]
 *
 * Randomness is seeded by index (no Math.random) so a failing run is reproducible.
 */

import { lintSource } from "../src/core/scan.ts";
import { DIAGNOSTICS } from "../src/core/registry.ts";

const CAPS = new Set(["node", "esm", "express", "prisma", "jsonwebtoken", "fastify"]);
const PER_FILE_BUDGET_MS = 500;

const SEEDS = [
  `app.get("/x", async (req, res) => { const u = await db.user.findUnique({ where: { id: req.params.id } }); res.json(u); });`,
  `exec(\`tar -czf b.tgz \${req.body.dir}\`); const s = process.env.JWT_SECRET || "dev-secret-123";`,
  `users.forEach(async (u) => { await send(u); }); await Promise.all(rows.map((r) => fetch("/x/" + r.id)));`,
  `for (const o of orders) { o.items = await db.orderItem.findMany({ where: { orderId: o.id } }); }`,
  `const cache = new Map(); export function remember(k, v) { cache.set(k, v); }`,
  `try { await save(); } finally { throw new Error("x"); } new Promise(async (r) => { await r(); });`,
  `app.use(cors({ origin: true, credentials: true })); const full = path.join("./up", req.params.name);`,
  `class C { @Get("/p") async handler(req, res) { const x = require("fs").readFileSync("y"); res.send(x); } }`,
];

// A tiny seeded PRNG (mulberry32) — deterministic per fuzz index.
const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const NOISE = ["${", "`", "))", "async ", "await ", "{", "}", "//\n", "\n\n", "(", "req.body", "]["];

const mutate = (seed: string, rand: () => number): string => {
  let s = seed;
  const rounds = 1 + Math.floor(rand() * 6);
  for (let i = 0; i < rounds; i++) {
    const pick = rand();
    const pos = Math.floor(rand() * (s.length + 1));
    if (pick < 0.3) {
      // insert noise
      s = s.slice(0, pos) + NOISE[Math.floor(rand() * NOISE.length)] + s.slice(pos);
    } else if (pick < 0.5) {
      // delete a chunk
      const len = 1 + Math.floor(rand() * 8);
      s = s.slice(0, pos) + s.slice(pos + len);
    } else if (pick < 0.7) {
      // duplicate the whole thing (grow it)
      s = s + "\n" + seed;
    } else if (pick < 0.85) {
      // deep nesting
      s = "(".repeat(20) + s + ")".repeat(10);
    } else {
      // truncate
      s = s.slice(0, Math.max(0, Math.floor(s.length * rand())));
    }
  }
  return s;
};

interface Violation {
  kind: "crash" | "slow" | "invariant";
  detail: string;
  source: string;
}

const check = (index: number, source: string): Violation | null => {
  const filePath = index % 2 === 0 ? "fuzz.ts" : "fuzz.js";
  const totalLines = source.split("\n").length;

  let first;
  try {
    const start = Number(process.hrtime.bigint() / 1000n);
    first = lintSource({ filePath, sourceText: source, diagnostics: DIAGNOSTICS, capabilities: CAPS });
    const elapsedMs = (Number(process.hrtime.bigint() / 1000n) - start) / 1000;
    if (elapsedMs > PER_FILE_BUDGET_MS) {
      return { kind: "slow", detail: `${elapsedMs.toFixed(1)}ms > ${PER_FILE_BUDGET_MS}ms`, source };
    }
  } catch (err) {
    return { kind: "crash", detail: err instanceof Error ? err.message : String(err), source };
  }

  for (const d of first.findings) {
    if (d.line < 1 || d.column < 1 || d.line > totalLines + 1) {
      return { kind: "invariant", detail: `finding outside file: ${d.diagnostic} @ ${d.line}:${d.column} (lines=${totalLines})`, source };
    }
  }

  // Determinism: a second run must match exactly.
  const second = lintSource({ filePath, sourceText: source, diagnostics: DIAGNOSTICS, capabilities: CAPS });
  if (JSON.stringify(first.findings) !== JSON.stringify(second.findings)) {
    return { kind: "invariant", detail: "non-deterministic output across two runs", source };
  }
  return null;
};

const main = (): number => {
  const iterations = Number(process.argv[2]) || 2000;
  const violations: Violation[] = [];

  for (let i = 0; i < iterations; i++) {
    const rand = rng(i + 1);
    const seed = SEEDS[i % SEEDS.length]!;
    const source = mutate(seed, rand);
    const v = check(i, source);
    if (v) violations.push(v);
  }

  process.stdout.write(`fuzz: ${iterations} iterations · ${violations.length} violation(s)\n`);
  for (const v of violations.slice(0, 10)) {
    process.stdout.write(`  [${v.kind}] ${v.detail}\n    ${JSON.stringify(v.source.slice(0, 80))}\n`);
  }
  return violations.length === 0 ? 0 : 1;
};

process.exit(main());
