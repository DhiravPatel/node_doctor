import { lintSource } from "../src/core/scan.ts";
import { noSequentialIndependentAwaits as D } from "../src/diagnostics/performance/no-sequential-independent-awaits.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src) =>
  lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [D], capabilities: caps }).findings.length;

const cases = {
  // --- Baseline sanity: known-true positive (two independent reads) ---
  "TP: two independent reads (fetchUser/fetchOrders via db)": `
async function f(id, other) {
  const a = await db.user.findUnique({ where: { id } });
  const b = await db.order.findMany({ where: { userId: other } });
  return [a, b];
}`,

  // --- FP hunt 1: two independent WRITES (create/create) ---
  "WRITES: db.user.create + db.log.create (ordering/tx semantics)": `
async function f() {
  const a = await db.user.create({ data: {} });
  const b = await db.log.create({ data: {} });
  return [a, b];
}`,

  "WRITES: repo.save + repo.save": `
async function f(u1, u2) {
  const a = await userRepo.save(u1);
  const b = await auditRepo.save(u2);
  return [a, b];
}`,

  "WRITES: db.account.update + db.ledger.insert (financial ordering)": `
async function transfer() {
  const a = await db.account.update({ where: { id: 1 }, data: { bal: 100 } });
  const b = await db.ledger.insert({ amount: 100 });
  return [a, b];
}`,

  "WRITES: db.a.deleteMany + db.b.deleteMany": `
async function f() {
  const a = await db.parent.deleteMany({});
  const b = await db.child.deleteMany({});
  return [a, b];
}`,

  // --- FP hunt 2: same-transaction serial queries ---
  "SAME-TX: db.tx.query(q1) + db.tx.query(q2)": `
async function f(q1, q2) {
  const a = await db.tx.query(q1);
  const b = await db.tx.query(q2);
  return [a, b];
}`,

  "SAME-TX: tx.query(q1) + tx.query(q2) (bare tx receiver)": `
async function f(q1, q2) {
  const a = await tx.query(q1);
  const b = await tx.query(q2);
  return [a, b];
}`,

  "SAME-TX: trx.insert + trx.update (knex-style transaction handle)": `
async function f() {
  const a = await trx.insert({ id: 1 });
  const b = await trx.update({ id: 2 });
  return [a, b];
}`,

  "SAME-TX: conn.query + conn.query (single connection)": `
async function f(q1, q2) {
  const a = await conn.query(q1);
  const b = await conn.query(q2);
  return [a, b];
}`,

  "SAME-TX: client.query + client.query (pg client, one connection)": `
async function f(q1, q2) {
  const a = await client.query(q1);
  const b = await client.query(q2);
  return [a, b];
}`,

  // --- FP hunt 3: fetch with intentional rate-limit/throttle ---
  "THROTTLE: two fetch() calls (rate-limited API)": `
async function f(x, y) {
  const a = await fetch(x);
  const b = await fetch(y);
  return [a, b];
}`,

  // --- FP hunt 4: non-HTTP local helpers named request/got ---
  "LOCAL-HELPER: request(cfg) + request(cfg2) (local queue helper)": `
async function f(cfg, cfg2) {
  const a = await request(cfg);
  const b = await request(cfg2);
  return [a, b];
}`,

  "LOCAL-HELPER: got(x) + got(y) (local getter, not the http lib)": `
async function f(x, y) {
  const a = await got(x);
  const b = await got(y);
  return [a, b];
}`,

  // --- FP hunt 5: DB hint breadth on non-DB objects ---
  "HINT-BREADTH: apiClient.create + apiClient.update (non-DB API client)": `
async function f(x, y) {
  const a = await apiClient.create(x);
  const b = await apiClient.update(y);
  return [a, b];
}`,

  "HINT-BREADTH: client.create + client.update (bare 'client', non-DB)": `
async function f(x, y) {
  const a = await client.create(x);
  const b = await client.update(y);
  return [a, b];
}`,

  "HINT-BREADTH: model.count + model.aggregate (some non-DB 'model')": `
async function f(x, y) {
  const a = await model.count(x);
  const b = await model.aggregate(y);
  return [a, b];
}`,

  "HINT-BREADTH: collection.insert + collection.save (non-DB 'collection')": `
async function f(x, y) {
  const a = await collection.insert(x);
  const b = await collection.save(y);
  return [a, b];
}`,

  "HINT-BREADTH: stripeClient.create + stripeClient.update (stripe SDK)": `
async function f(x, y) {
  const a = await stripeClient.create(x);
  const b = await stripeClient.update(y);
  return [a, b];
}`,

  // --- FP hunt 6: cache.get boundary ambiguity ---
  "CACHE: cache.get(k1) + cache.get(k2)": `
async function f(k1, k2) {
  const a = await cache.get(k1);
  const b = await cache.get(k2);
  return [a, b];
}`,

  "CACHE: redisClient.get + redisClient.get (client hint => DB)": `
async function f(k1, k2) {
  const a = await redisClient.get(k1);
  const b = await redisClient.get(k2);
  return [a, b];
}`,

  // --- Extra: writes on a real DB same table, upsert pair ---
  "WRITES: db.user.upsert + db.user.upsert (same model, ordering)": `
async function f() {
  const a = await db.user.upsert({ where: { id: 1 }, create: {}, update: {} });
  const b = await db.user.upsert({ where: { id: 2 }, create: {}, update: {} });
  return [a, b];
}`,

  // --- Extra: mixed read then write independent ---
  "MIXED: db.user.findMany + db.audit.create (read then independent write)": `
async function f() {
  const a = await db.user.findMany({});
  const b = await db.audit.create({ data: {} });
  return [a, b];
}`,
};

for (const [label, src] of Object.entries(cases)) {
  let out;
  try {
    out = n(src);
  } catch (e) {
    out = "ERR:" + e.message;
  }
  console.log(`${out}\t${label}`);
}
