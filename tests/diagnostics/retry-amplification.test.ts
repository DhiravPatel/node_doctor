/**
 * §135 no-retry-amplification (Reliability, opt-in).
 *
 * Self-contained: imports the diagnostic module directly and lints with an
 * explicit one-rule list, so it does NOT depend on the generated registry.
 * Each SILENT case is a deliberate precision guard — the correct single-layer
 * retry pattern is the common case and must never fire.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noRetryAmplification } from "../../src/diagnostics/reliability/no-retry-amplification.ts";
import type { Diagnostic } from "../../src/core/types.ts";

const CAPS = new Set(["node", "esm", "typescript"]);

const findingsFor = (diagnostic: Diagnostic, source: string): number => {
  const { findings, parseFailed } = lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [diagnostic],
    capabilities: CAPS,
  });
  assert.ok(!parseFailed, `source failed to parse:\n${source}`);
  return findings.filter((f) => f.diagnostic === diagnostic.id).length;
};

const fires = (diagnostic: Diagnostic, source: string): void =>
  assert.ok(findingsFor(diagnostic, source) > 0, `expected ${diagnostic.id} to FIRE on:\n${source}`);

const silent = (diagnostic: Diagnostic, source: string): void =>
  assert.equal(findingsFor(diagnostic, source), 0, `expected ${diagnostic.id} to STAY SILENT on:\n${source}`);

describe("no-retry-amplification", () => {
  const R = noRetryAmplification;

  // FIRES -------------------------------------------------------------------
  test("fires: two retry wrappers nested (pRetry inside pRetry)", () => {
    fires(R, `pRetry(() => pRetry(() => call()));`);
  });
  test("fires: block body awaits a nested asyncRetry", () => {
    fires(R, `retry(async () => { await asyncRetry(() => db()); });`);
  });
  // Client detections are gated on the SDK actually being imported (a receiver
  // merely named like a client is not enough).
  test("fires: retry wrapper around an AWS SDK v3 client .send()", () => {
    fires(R, `import { S3Client } from "@aws-sdk/client-s3";\npRetry(() => s3Client.send(cmd));`);
  });
  test("fires: retry wrapper around got() (retries by default)", () => {
    fires(R, `import got from "got";\npRetry(() => got("https://x"));`);
  });
  test("fires: retry wrapper around a stripe.* SDK call", () => {
    fires(R, `import Stripe from "stripe";\npromiseRetry(() => stripe.charges.create({ amount: 1 }));`);
  });
  test("fires: retry wrapper around got.<method>()", () => {
    fires(R, `import got from "got";\nwithRetry(() => got.post("https://x", {}));`);
  });
  test("fires: dynamoClient.send() with @aws-sdk imported", () => {
    fires(R, `import { DynamoDBClient } from "@aws-sdk/client-dynamodb";\nbackOff(() => dynamoClient.send(cmd));`);
  });
  test("silent: .send() on a *Client receiver WITHOUT an @aws-sdk import (custom client)", () => {
    silent(R, `pRetry(() => emailClient.send(msg));`);
    silent(R, `pRetry(() => queueClient.send(job));`);
    silent(R, `import got from "got";\npRetry(() => s3Client.send(cmd));`); // got imported, not aws
  });
  test("fires: axios call when axios-retry is imported in the file", () => {
    fires(R, `import axiosRetry from "axios-retry"; pRetry(() => axios.get("https://x"));`);
  });
  test("fires: FunctionExpression operation containing a nested retry wrapper", () => {
    fires(R, `pRetry(function () { return retry(() => x()); });`);
  });
  test("fires: nested wrapper inside a try/catch in the operation body", () => {
    fires(R, `pRetry(async () => { try { return await pRetryable(() => hit()); } catch {} });`);
  });

  // MUST BE SILENT ----------------------------------------------------------
  test("silent: retry wrapper around a plain fetch (does not retry itself)", () => {
    silent(R, `pRetry(() => fetch(url));`);
  });
  test("silent: retry wrapper around a plain db call", () => {
    silent(R, `pRetry(() => db.query(sql));`);
  });
  test("silent: a lone retry wrapper (correct single-layer usage)", () => {
    silent(R, `retry(() => work());`);
  });
  test("silent: fluent .retry(3) config — first arg is a number, not a function", () => {
    silent(R, `client.retry(3);`);
  });
  test("silent: `retry` bound to a value, never called", () => {
    silent(R, `const retry = 5; use(retry);`);
  });
  test("silent: axios call WITHOUT axios-retry imported", () => {
    silent(R, `pRetry(() => axios.get("https://x"));`);
  });
  test("silent: client method is not .send (emailClient.sendMail)", () => {
    silent(R, `pRetry(() => emailClient.sendMail(msg));`);
  });
  test("silent: inner retry lives in an uninvoked nested closure (pruned)", () => {
    silent(R, `pRetry(() => { const h = () => retry(() => x()); return h(); });`);
  });
  test("silent: .send on a non-client receiver (socket)", () => {
    silent(R, `pRetry(() => socket.send(data));`);
  });
  test("silent: a plain function merely named like stripe (stripeCharge)", () => {
    silent(R, `pRetry(() => stripeCharge(x));`);
  });
  test("silent: inner .retry(3) fluent config is not a nested wrapper", () => {
    silent(R, `pRetry(() => client.retry(3));`);
  });
  test("silent: retry-wrapper name called with a number (not a wrapper call)", () => {
    silent(R, `withRetry(42);`);
  });
});
