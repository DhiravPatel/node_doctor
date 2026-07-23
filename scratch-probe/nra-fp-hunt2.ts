import { lintSource } from "../src/core/scan.ts";
import { noRetryAmplification } from "../src/diagnostics/reliability/no-retry-amplification.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (src: string): number =>
  lintSource({ filePath: "a.ts", sourceText: src, diagnostics: [noRetryAmplification], capabilities: caps }).findings.length;

const cases: Array<[string, string]> = [
  ["this.emailClient.send member root", `class M { run(){ pRetry(() => this.emailClient.send(m)); } }`],
  ["deep chain svc.mailClient.send", `pRetry(() => svc.mailClient.send(m))`],
  ["Client casing lower 'client' var", `pRetry(() => Client.send(cmd))`],
  ["ftpClient.send", `retry(() => ftpClient.send(file))`],
  ["socketClient.send", `withRetry(() => socketClient.send(data))`],
  ["mqttClient.send", `pRetry(() => mqttClient.send(topic))`],
  ["backOff wrapper emailClient.send", `backOff(() => emailClient.send(m))`],
  ["asyncRetry wrapper grpcClient.send", `asyncRetry(() => grpcClient.send(r))`],
  ["promiseRetry emailClient.send", `promiseRetry(() => emailClient.send(m))`],
  ["retryAsync queueClient.send", `retryAsync(() => queueClient.send(j))`],
];

for (const [label, src] of cases) {
  let count: number | string;
  try { count = n(src); } catch (e) { count = "ERR:" + (e as Error).message; }
  console.log(`${String(count).padEnd(6)} | ${label}`);
}
