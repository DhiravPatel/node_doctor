/**
 * `no-nested-query-on-simple-parser`.
 *
 * Express 4's default query parser was `extended` (qs); Express 5's is `simple`
 * (`node:querystring`). MEASURED against Express 5.2.1, serving
 * `?filter[status]=open&tags[]=a&tags[]=b`:
 *
 *   default                             → { "filter[status]": "open", "tags[]": ["a","b"] }
 *   app.set("query parser", "extended") → { filter: { status: "open" }, tags: ["a","b"] }
 *   app.set("query parser", "simple")   → { "filter[status]": "open", "tags[]": ["a","b"] }
 *
 * So `req.query.filter.status` is `undefined` under the default. Nothing throws —
 * the filter is simply never applied, so the endpoint returns every row instead
 * of the matching ones.
 *
 * The soundness hinge is the builtin-member exclusion. Repeated keys still
 * produce ARRAYS under the simple parser (`?ids=a&ids=b` → `{ ids: ["a","b"] }`,
 * measured), so `req.query.ids.length` and `req.query.ids.map(…)` work, exactly
 * as `req.query.name.trim()` does on the string case. Only a read of a CUSTOM
 * property is evidence of the nested-object assumption.
 *
 * This is PROJECT-scope: the `app.set` and the nested read are never in the same
 * file, so the cross-file cases below are the ones that matter.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../../src/core/scan.ts";

const CONTROLLER = `
exports.list = async (req, res) => {
  const status = req.query.filter.status;
  const field = req.query.sort.field;
  const page = req.query.page;
  const count = req.query.ids.length;
  const name = req.query.name.trim();
  const first = req.query.ids[0];
  const mapped = req.query.ids.map(String);
  return res.json({ status, field, page, count, name, first, mapped });
};
`;

const project = async (bootstrap: string, expressRange = "^5.2.1"): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "nd-qp-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "qp", dependencies: { express: expressRange } }));
  await writeFile(join(root, "src", "orders.js"), CONTROLLER);
  await writeFile(join(root, "src", "app.js"), bootstrap);
  return root;
};

const findings = async (root: string) => {
  const report = await scanProject({ rootDirectory: root });
  return report.findings.filter((f) => f.diagnostic === "no-nested-query-on-simple-parser");
};

const PLAIN = `const express = require("express");\nconst app = express();\napp.use("/o", require("./orders").list);\nmodule.exports = app;\n`;

describe("no-nested-query-on-simple-parser", () => {
  test("fires on the nested reads, and only those", async () => {
    const root = await project(PLAIN);
    try {
      const lines = (await findings(root)).map((f) => f.line).sort((a, b) => a - b);
      // `filter.status` and `sort.field` only. Not `page` (one level), not
      // `ids.length` / `name.trim()` / `ids[0]` / `ids.map` (string & array
      // members, all of which work under the simple parser).
      assert.deepEqual(lines, [3, 4]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("silent when a DIFFERENT file sets the parser to extended", async () => {
    // The whole reason this rule is project-scope.
    const root = await project(
      `const express = require("express");\nconst app = express();\napp.set("query parser", "extended");\napp.use("/o", require("./orders").list);\nmodule.exports = app;\n`,
    );
    try {
      assert.equal((await findings(root)).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("silent when the parser is a custom function", async () => {
    const root = await project(
      `const express = require("express");\nconst qs = require("qs");\nconst app = express();\napp.set("query parser", (s) => qs.parse(s));\nmodule.exports = app;\n`,
    );
    try {
      assert.equal((await findings(root)).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("still fires when the parser is set explicitly to `simple`", async () => {
    // Measured: "simple" produces the same flat keys as the default, so opting
    // into it by name does not make the nested read work.
    const root = await project(
      `const express = require("express");\nconst app = express();\napp.set("query parser", "simple");\nmodule.exports = app;\n`,
    );
    try {
      assert.ok((await findings(root)).length > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("silent on Express 4, whose default parser IS extended", async () => {
    const root = await project(PLAIN, "^4.19.2");
    try {
      assert.equal((await findings(root)).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("silent with no Express at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "nd-qp-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "qp" }));
      await writeFile(join(root, "src", "orders.js"), CONTROLLER);
      assert.equal((await findings(root)).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a dynamic first key is not claimed", async () => {
    const root = await mkdtemp(join(tmpdir(), "nd-qp-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "qp", dependencies: { express: "^5.2.1" } }));
      await writeFile(
        join(root, "src", "orders.js"),
        `exports.list = (req, res) => res.json(req.query[key].status);\n`,
      );
      await writeFile(join(root, "src", "app.js"), PLAIN);
      assert.equal((await findings(root)).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
