import { lintSource } from "../src/core/scan.ts";
import { noRetryAmplification } from "../src/diagnostics/reliability/no-retry-amplification.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src: string): number =>
  lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [noRetryAmplification], capabilities: caps }).findings.length;

const cases: Array<[string, string]> = [
  // ---- Suspected false positives (legit code) ----
  ["FP1 emailClient.send (nodemailer transport)", `pRetry(() => emailClient.send(msg))`],
  ["FP2 queueClient.send (custom queue)", `retry(() => queueClient.send(job))`],
  ["FP3 grpcClient.send (grpc)", `pRetry(() => grpcClient.send(req))`],
  ["FP4 local got shadow", `const got = createHelper(); pRetry(() => got())`],
  ["FP5 local stripe object", `const stripe = { charge(){} }; retry(() => stripe.charge())`],
  ["FP6 axios.get WITHOUT axios-retry", `pRetry(() => axios.get(x))`],
  ["FP7 got.extend factory inside wrapper", `pRetry(() => got.extend({ prefixUrl: "https://x" }))`],

  // ---- receiver 'client' exactly vs 's3Client' ----
  ["client exactly (no cap C)", `pRetry(() => client.send(cmd))`],
  ["s3Client (AWS)", `pRetry(() => s3Client.send(cmd))`],

  // ---- Legit single-layer retries (must be SILENT) ----
  ["fetch single-layer", `pRetry(() => fetch(url))`],
  ["db.query single-layer", `retry(() => db.query(sql))`],
  ["processLocally single-layer", `withRetry(() => processLocally())`],

  // ---- extra receiver-name variants ----
  ["httpClient.send", `pRetry(() => httpClient.send(payload))`],
  ["apiClient.send", `retry(() => apiClient.send(data))`],
  ["mailClient.send", `pRetry(() => mailClient.send(m))`],
  ["redisClient.send", `pRetry(() => redisClient.send(cmd))`],
  ["kafkaClient.send", `retry(() => kafkaClient.send(evt))`],
  ["wsClient.send websocket", `withRetry(() => wsClient.send(frame))`],
  ["transport.send (no Client name)", `pRetry(() => transport.send(mail))`],
  ["emailClient.sendMail (not 'send')", `pRetry(() => emailClient.sendMail(msg))`],
  ["emailClient.send() no arg", `pRetry(() => emailClient.send())`],

  // ---- got shadow variants ----
  ["got.get local shadow", `const got = makeThing(); pRetry(() => got.get())`],
  ["got() true positive (real got, imported)", `import got from "got"; pRetry(() => got(url))`],

  // ---- stripe variants ----
  ["stripe.charge local (member call)", `const stripe = {charge(){}}; pRetry(() => stripe.charge())`],
  ["stripe() bare call not member", `retry(() => stripe(x))`],
  ["stripe.charges.create nested member", `retry(() => stripe.charges.create(x))`],

  // ---- true positive nested wrappers (sanity) ----
  ["nested pRetry (TP)", `pRetry(() => pRetry(() => call()))`],

  // ---- axios WITH axios-retry imported ----
  ["axios WITH axios-retry import", `import axiosRetry from "axios-retry"; pRetry(() => axios.get(x))`],
  ["axios.post WITHOUT import member", `pRetry(() => axios.post(x, y))`],

  // ---- block body with other statements ----
  ["block body emailClient.send", `pRetry(async () => { const m = build(); await emailClient.send(m); })`],
];

for (const [label, src] of cases) {
  let count: number | string;
  try {
    count = n(src);
  } catch (e) {
    count = "ERR:" + (e as Error).message;
  }
  console.log(`${String(count).padEnd(6)} | ${label}`);
}
