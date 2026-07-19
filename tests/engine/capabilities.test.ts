import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { detectCapabilities, shouldEnableDiagnostic, capabilitiesSatisfied, majorVersion } from "../../src/core/project.ts";
import { DIAGNOSTICS_BY_ID } from "../../src/core/registry.ts";

describe("detectCapabilities", () => {
  test("express 4 does not add express:5", () => {
    const caps = detectCapabilities({ dependencies: { express: "^4.18.2" } });
    assert.ok(caps.has("express"));
    assert.ok(!caps.has("express:5"));
  });

  test("express 5 adds express:5", () => {
    const caps = detectCapabilities({ dependencies: { express: "^5.0.0" } });
    assert.ok(caps.has("express"));
    assert.ok(caps.has("express:5"));
  });

  test("type: module → esm; otherwise cjs", () => {
    assert.ok(detectCapabilities({ type: "module" }).has("esm"));
    assert.ok(detectCapabilities({}).has("cjs"));
  });

  test("typescript from a tsconfig even without the dep", () => {
    assert.ok(detectCapabilities({}, { hasTsconfig: true }).has("typescript"));
  });

  test("orm + framework tokens", () => {
    const caps = detectCapabilities({
      dependencies: { fastify: "^4", "@prisma/client": "^5", jsonwebtoken: "^9" },
    });
    for (const t of ["fastify", "prisma", "jsonwebtoken"]) assert.ok(caps.has(t), t);
  });

  test("node major from engines", () => {
    assert.ok(detectCapabilities({ engines: { node: ">=20.19" } }).has("node:20"));
  });

  test("majorVersion parses ranges", () => {
    assert.equal(majorVersion("^5.0.0"), 5);
    assert.equal(majorVersion(">=4.17.1 <5"), 4);
    assert.equal(majorVersion(undefined), null);
  });
});

describe("diagnostic gating", () => {
  const asyncHandler = DIAGNOSTICS_BY_ID.get("express-async-handler-unprotected")!;
  const jwtRule = DIAGNOSTICS_BY_ID.get("no-jwt-decode-as-verify")!;

  test("express-async diagnostic runs on express 4", () => {
    assert.ok(shouldEnableDiagnostic(asyncHandler, new Set(["node", "express"])));
  });
  test("express-async diagnostic retires on express 5", () => {
    assert.ok(!shouldEnableDiagnostic(asyncHandler, new Set(["node", "express", "express:5"])));
  });
  test("express-async diagnostic silent without express", () => {
    assert.ok(!shouldEnableDiagnostic(asyncHandler, new Set(["node"])));
  });
  test("jwt diagnostic requires jsonwebtoken", () => {
    assert.ok(!capabilitiesSatisfied(jwtRule, new Set(["node"])));
    assert.ok(capabilitiesSatisfied(jwtRule, new Set(["node", "jsonwebtoken"])));
  });
});
