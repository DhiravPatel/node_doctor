import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { scanProject } from "../../src/core/scan.ts";

const fixture = fileURLToPath(new URL("../fixtures/taintchain", import.meta.url));
const goodApp = fileURLToPath(new URL("../fixtures/good-app", import.meta.url));

const scan = () => scanProject({ rootDirectory: fixture });
const hits = async () =>
  (await scan()).findings.filter((f) => f.diagnostic === "no-tainted-sink-via-helper");

describe("no-tainted-sink-via-helper (§56 interprocedural taint)", () => {
  test("follows taint across three files into the sink", async () => {
    const found = await hits();
    assert.equal(found.length, 1, "exactly the one genuinely-tainted sink");
    assert.equal(found[0]!.normalizedFilePath, "src/repo.js");
  });

  test("names the full hop trail so the path is explainable", async () => {
    const [f] = await hits();
    assert.match(f!.message, /routes\.js/, "starts at the handler");
    assert.match(f!.message, /service\.js:lookup/, "through the intermediate helper");
    assert.match(f!.message, /repo\.js:findUser/, "ends at the sink helper");
    assert.match(f!.message, /SQL injection/);
  });

  test("silent on a parameterized query fed the same tainted value", async () => {
    const found = await hits();
    assert.ok(!found.some((f) => f.normalizedFilePath === "src/safe.js"), "bound parameters are safe");
  });

  test("silent on an identical sink no handler reaches", async () => {
    const found = await hits();
    assert.ok(
      !found.some((f) => f.normalizedFilePath === "src/orphan.js"),
      "unreachable from any handler → not caller-controlled",
    );
  });

  test("high confidence — a proven path, not a heuristic", async () => {
    const [f] = await hits();
    assert.equal(f!.confidence, "high");
  });

  test("does not fire on the clean canary", async () => {
    const report = await scanProject({ rootDirectory: goodApp });
    assert.equal(report.findings.filter((f) => f.diagnostic === "no-tainted-sink-via-helper").length, 0);
  });

  test("deterministic across runs", async () => {
    const a = await hits();
    const b = await hits();
    assert.deepEqual(a.map((f) => f.id), b.map((f) => f.id));
  });
});
