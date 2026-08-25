/**
 * `no-nest-res-without-send`.
 *
 * Injecting `@Res()` switches a Nest handler into library-specific mode: Nest
 * stops managing the response, the returned value is discarded, and nothing is
 * written to the socket. MEASURED against NestJS 11.2.3, each case booted as a
 * real server and fetched:
 *
 *   return value, no @Res                          → 200 {"ok":true}
 *   @Res, res.json({ok:true})                      → 200 {"ok":true}
 *   @Res({passthrough:true}), returns value        → 200 {"ok":true}
 *   @Res({passthrough:true}), setHeader + returns  → 200 {"ok":true}
 *   @Res, returns value, never sends               → NO RESPONSE, hung until timeout
 *   @Res, setHeader then returns                   → NO RESPONSE, hung until timeout
 *
 * The last row is the shape that actually occurs: someone needs one header,
 * reaches for `@Res()` to set it, and leaves the `return` that was already there.
 * Nothing throws and nothing is logged; the socket just stays open.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noNestResWithoutSend } from "../../src/diagnostics/frameworks/no-nest-res-without-send.ts";

const CAPS = new Set(["node", "esm", "typescript", "nest"]);
const controller = (members: string) =>
  `import { Controller, Get, Post, Body, Res, Response } from "@nestjs/common";\n` +
  `@Controller("users")\nexport class UsersController {\n${members}\n}`;

const findings = (members: string) =>
  lintSource({
    filePath: "/repo/src/users.controller.ts",
    sourceText: controller(members),
    diagnostics: [noNestResWithoutSend],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-nest-res-without-send");

const fires = (members: string) => {
  const found = findings(members);
  assert.ok(found.length > 0, `expected a FIRE on:\n${members}`);
  return found;
};
const silent = (members: string): void =>
  assert.equal(findings(members).length, 0, `expected SILENCE on:\n${members}`);

describe("no-nest-res-without-send", () => {
  describe("the defect", () => {
    test("@Res injected, value returned, response never touched", () => {
      fires(`  @Get() findAll(@Res() res) { return { ok: true }; }`);
    });

    test("only a header set, then a return — the shape that actually occurs", () => {
      // Measured: hangs until the client times out.
      fires(`  @Get() findAll(@Res() res) { res.setHeader("x-total", "1"); return items; }`);
    });

    test("@Response() is the same decorator by another name", () => {
      fires(`  @Get() findAll(@Response() res) { return { ok: true }; }`);
    });

    test("the response parameter need not be first", () => {
      fires(`  @Post() create(@Body() body, @Res() res) { return body; }`);
    });

    test("every HTTP method decorator counts", () => {
      for (const verb of ["Get", "Post", "Put", "Patch", "Delete", "All", "Options", "Head"]) {
        fires(`  @${verb}() m(@Res() res) { return { ok: true }; }`);
      }
    });

    test("the message names the mechanism and the measured behaviour", () => {
      const [found] = fires(`  @Get() findAll(@Res() res) { return { ok: true }; }`);
      assert.match(found!.message, /library-specific mode/);
      assert.match(found!.message, /no response at all/i);
      assert.match(found!.recommendation ?? "", /passthrough: true/);
    });
  });

  describe("silence — passthrough keeps Nest's handling", () => {
    test("@Res({ passthrough: true }) with a return", () => {
      silent(`  @Get() findAll(@Res({ passthrough: true }) res) { return { ok: true }; }`);
    });

    test("passthrough plus a header write — the correct fix for the defect above", () => {
      silent(`  @Get() findAll(@Res({ passthrough: true }) res) { res.setHeader("x-total", "1"); return items; }`);
    });
  });

  describe("silence — the response is actually sent", () => {
    test("a terminal call", () => {
      silent(`  @Get() findAll(@Res() res) { res.json({ ok: true }); }`);
      silent(`  @Get() findAll(@Res() res) { res.send("hi"); return; }`);
    });

    test("through a chain", () => {
      silent(`  @Get() findAll(@Res() res) { res.status(201).json({ ok: true }); return; }`);
      silent(`  @Get() findAll(@Res() res) { res.status(201).json({ ok: true }); return { ok: true }; }`);
    });

    test("redirect, sendFile, end and write all count", () => {
      for (const method of ["redirect", "sendFile", "end", "write", "render", "download"]) {
        silent(`  @Get() m(@Res() res) { res.${method}("x"); return { ok: true }; }`);
      }
    });
  });

  describe("precision guards — unfollowable use resolves to silence", () => {
    test("the response passed as an argument could be written by the callee", () => {
      silent(`  @Get() m(@Res() res) { stream.pipe(res); return { ok: true }; }`);
      silent(`  @Get() m(@Res() res) { sendReport(res); return { ok: true }; }`);
    });

    test("the response aliased to another binding", () => {
      silent(`  @Get() m(@Res() res) { const r = res; r.json({ ok: true }); return { ok: true }; }`);
    });

    test("no @Res at all — Nest is managing the response", () => {
      silent(`  @Get() findAll() { return { ok: true }; }`);
    });

    test("no returned value is a different shape and is not claimed", () => {
      // It may be piping a stream; this rule does not guess.
      silent(`  @Get() m(@Res() res) { res.setHeader("x", "1"); }`);
      silent(`  @Get() m(@Res() res) { res.setHeader("x", "1"); return; }`);
    });

    test("a plain helper on the controller is not a route", () => {
      silent(`  helper(@Res() res) { return { ok: true }; }`);
    });

    test("a return inside a nested function is not the method's return", () => {
      silent(`  @Get() m(@Res() res) { items.forEach(() => { return 1; }); res.end(); }`);
    });
  });
});
