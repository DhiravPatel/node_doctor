/**
 * §77 — OpenAPI Generation From Code.
 *
 * Covers path-parameter conversion, query-parameter mining (dot, bracket and
 * destructured forms), request-body presence, status-code extraction, security
 * from the middleware chain, tags/operationIds, the dynamic-route refusal, and
 * determinism.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildOpenApiDocument, type OpenApiResult } from "../../src/core/openapi.ts";

const makeProject = async (files: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-openapi-"));
  for (const [rel, src] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, src);
  }
  return dir;
};

const APP = `
import express from "express";
const app = express();

app.get("/users/:id", (req, res) => {
  const { include } = req.query;
  if (!req.params.id) return res.status(400).json({ error: "bad" });
  res.status(200).json({ id: req.params.id, include });
});

app.post("/users", requireAuth, (req, res) => {
  const created = save(req.body);
  res.status(201).json(created);
});

app.get("/orders", requireAuth, (req, res) => {
  const page = req.query.page;
  const size = req.query["size"];
  res.json(list(page, size));
});

app.delete("/orders/:orderId", requireAuth, (req, res) => {
  res.sendStatus(204);
});

app.get("/health", (req, res) => res.json({ ok: true }));
`;

const build = async (files: Record<string, string>): Promise<OpenApiResult> => {
  const dir = await makeProject(files);
  try {
    return await buildOpenApiDocument(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const FULL = {
  "package.json": `{ "name": "orders-api", "version": "2.1.0" }`,
  "src/routes.ts": APP,
};

describe("buildOpenApiDocument — document shape", () => {
  test("info comes from package.json; the document is OpenAPI 3.1", async () => {
    const { document } = await build(FULL);
    assert.equal(document.openapi, "3.1.0");
    assert.deepEqual(document.info, { title: "orders-api", version: "2.1.0" });
  });

  test("every route becomes an operation under its converted path", async () => {
    const { document, summary } = await build(FULL);
    assert.deepEqual(Object.keys(document.paths).sort(), [
      "/health",
      "/orders",
      "/orders/{orderId}",
      "/users",
      "/users/{id}",
    ]);
    assert.equal(summary.operations, 5);
  });

  test("path parameters are converted and marked required", async () => {
    const { document } = await build(FULL);
    const op = document.paths["/users/{id}"]!.get!;
    const idParam = op.parameters!.find((p) => p.name === "id")!;
    assert.equal(idParam.in, "path");
    assert.equal(idParam.required, true);
  });

  test("query parameters are mined from dot, bracket and destructured reads", async () => {
    const { document } = await build(FULL);
    const orders = document.paths["/orders"]!.get!;
    assert.deepEqual(
      orders.parameters!.filter((p) => p.in === "query").map((p) => p.name),
      ["page", "size"],
      "req.query.page and req.query[\"size\"]",
    );
    const user = document.paths["/users/{id}"]!.get!;
    assert.ok(
      user.parameters!.some((p) => p.in === "query" && p.name === "include"),
      "const { include } = req.query",
    );
  });

  test("a request body is documented by PRESENCE, never by an invented schema", async () => {
    const { document } = await build(FULL);
    const post = document.paths["/users"]!.post!;
    assert.equal(post.requestBody?.required, true);
    const schema = post.requestBody!.content["application/json"]!.schema;
    assert.deepEqual(schema, { type: "object", additionalProperties: true });
  });

  test("status codes come from res.status()/res.sendStatus() literals", async () => {
    const { document } = await build(FULL);
    assert.deepEqual(Object.keys(document.paths["/users/{id}"]!.get!.responses).sort(), ["200", "400"]);
    assert.deepEqual(Object.keys(document.paths["/users"]!.post!.responses), ["201"]);
    assert.deepEqual(Object.keys(document.paths["/orders/{orderId}"]!.delete!.responses), ["204"]);
  });

  test("a handler with no readable status code is documented as 200 and counted", async () => {
    const { document, summary } = await build(FULL);
    assert.deepEqual(Object.keys(document.paths["/health"]!.get!.responses), ["200"]);
    assert.equal(summary.inferredResponses, 2, "/health and /orders");
  });

  test("authenticated routes carry a security requirement + a scheme component", async () => {
    const { document, summary } = await build(FULL);
    assert.deepEqual(document.paths["/users"]!.post!.security, [{ bearerAuth: [] }]);
    assert.equal(document.paths["/health"]!.get!.security, undefined);
    assert.deepEqual(document.components?.securitySchemes.bearerAuth, { type: "http", scheme: "bearer" });
    assert.equal(summary.securedOperations, 3);
  });

  test("tags come from the first concrete path segment; operationIds are readable", async () => {
    const { document } = await build(FULL);
    assert.deepEqual(document.paths["/orders/{orderId}"]!.delete!.tags, ["orders"]);
    assert.equal(document.paths["/users/{id}"]!.get!.operationId, "getUsersById");
    assert.equal(document.paths["/health"]!.get!.operationId, "getHealth");
  });

  test("no security component when nothing is authenticated", async () => {
    const { document } = await build({
      "package.json": `{ "name": "open", "version": "1.0.0" }`,
      "src/r.ts": `app.get("/ping", (req, res) => res.json({ ok: true }));`,
    });
    assert.equal(document.components, undefined);
  });
});

describe("buildOpenApiDocument — honesty over coverage", () => {
  test("a GET body read never produces a requestBody", async () => {
    const { document } = await build({
      "package.json": `{ "name": "g", "version": "1.0.0" }`,
      "src/r.ts": `app.get("/search", (req, res) => { res.json(find(req.body)); });`,
    });
    assert.equal(document.paths["/search"]!.get!.requestBody, undefined);
  });

  test("a non-literal status code contributes nothing (falls back to 200)", async () => {
    const { document } = await build({
      "package.json": `{ "name": "d", "version": "1.0.0" }`,
      "src/r.ts": `app.get("/x", (req, res) => { res.status(computeCode()).end(); });`,
    });
    assert.deepEqual(Object.keys(document.paths["/x"]!.get!.responses), ["200"]);
  });

  test("duplicate registrations across files union their facts", async () => {
    const { document } = await build({
      "package.json": `{ "name": "dup", "version": "1.0.0" }`,
      "src/a.ts": `app.get("/thing", (req, res) => { const a = req.query.alpha; res.status(200).json(a); });`,
      "src/b.ts": `app.get("/thing", requireAuth, (req, res) => { const b = req.query.beta; res.status(404).end(); });`,
    });
    const op = document.paths["/thing"]!.get!;
    assert.deepEqual(op.parameters!.map((p) => p.name), ["alpha", "beta"]);
    assert.deepEqual(Object.keys(op.responses).sort(), ["200", "404"]);
    assert.deepEqual(op.security, [{ bearerAuth: [] }], "auth from either registration wins");
  });

  test("a project with no routes yields an empty but valid document", async () => {
    const { document, summary } = await build({
      "package.json": `{ "name": "none", "version": "1.0.0" }`,
      "src/util.ts": `export const add = (a, b) => a + b;`,
    });
    assert.deepEqual(document.paths, {});
    assert.equal(summary.operations, 0);
  });
});

describe("buildOpenApiDocument — determinism", () => {
  test("identical input yields byte-identical JSON across runs", async () => {
    const dir = await makeProject(FULL);
    try {
      const a = await buildOpenApiDocument(dir);
      const b = await buildOpenApiDocument(dir);
      assert.equal(JSON.stringify(a.document), JSON.stringify(b.document));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("paths and methods are emitted in a stable order", async () => {
    const { document } = await build({
      "package.json": `{ "name": "ord", "version": "1.0.0" }`,
      "src/r.ts": `
        app.post("/z", (req, res) => res.sendStatus(201));
        app.get("/z", (req, res) => res.json({}));
        app.delete("/a", (req, res) => res.sendStatus(204));
      `,
    });
    assert.deepEqual(Object.keys(document.paths), ["/a", "/z"], "paths sorted");
    assert.deepEqual(Object.keys(document.paths["/z"]!), ["get", "post"], "methods in fixed order");
  });
});
