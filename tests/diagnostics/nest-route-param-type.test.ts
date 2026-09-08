/**
 * `no-unparsed-nest-route-param`.
 *
 * A NestJS `@Param()` / `@Query()` value is ALWAYS the raw request string. The
 * `number` / `boolean` annotation crosses a decorator, so TypeScript never checks
 * it. MEASURED against NestJS 11 on platform-express, four handlers under three
 * pipelines:
 *
 *                            no pipe         ValidationPipe()  ValidationPipe({transform:true})
 *   page + 1   (?page=2)     {"next":"21"}   {"next":"21"}     {"next":3}
 *   id === 1   (/admin/1)    false           false             true
 *   deleted ?  (=false)      INCLUDE         INCLUDE           exclude
 *   if (dry)   (?dry=false)  dry run         dry run           DELETED EVERYTHING
 *
 * The middle column is the whole point: adding a `ValidationPipe` does NOT
 * convert primitives unless `transform: true` is set, so the reflex fix leaves
 * the bug in place. `@Param("id", ParseIntPipe)` was measured to convert.
 *
 * PROJECT-scope: the pipeline lives in `main.ts` and the lie in a controller, so
 * the cross-file cases below are the ones that matter.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../../src/core/scan.ts";

const BARE_MAIN = `
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
bootstrap();
`;

const project = async (controller: string, main: string = BARE_MAIN): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "nd-nrp-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "n", dependencies: { "@nestjs/core": "^11.0.0", "@nestjs/common": "^11.0.0" } }),
  );
  await writeFile(join(root, "src", "users.controller.ts"), controller);
  await writeFile(join(root, "src", "main.ts"), main);
  return root;
};

const run = async (controller: string, main?: string) => {
  const root = await project(controller, main);
  try {
    const report = await scanProject({ rootDirectory: root });
    return report.findings.filter((f) => f.diagnostic === "no-unparsed-nest-route-param");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

/** Wrap handler bodies in a controller class. */
const controller = (members: string) => `
import { Controller, Get, Param, Query } from "@nestjs/common";
@Controller("users")
export class UsersController {
${members}
}
`;

const fires = async (members: string, main?: string) => {
  const found = await run(controller(members), main);
  assert.ok(found.length > 0, `expected a FIRE on:\n${members}`);
  return found;
};
const silent = async (members: string, main?: string): Promise<void> => {
  const found = await run(controller(members), main);
  assert.equal(found.length, 0, `expected SILENCE on:\n${members}\ngot: ${found.map((f) => f.message).join("\n")}`);
};

describe("no-unparsed-nest-route-param", () => {
  describe("the defect — a string used where a number was promised", () => {
    test("`page + 1` concatenates (measured: {\"next\":\"21\"})", async () => {
      await fires(`  @Get() list(@Query("page") page: number) { return { next: page + 1 }; }`);
    });

    test("`id === 1` is never true (measured: false for /admin/1)", async () => {
      await fires(`  @Get(":id") one(@Param("id") id: number) { return { isAdmin: id === 1 }; }`);
    });

    test("`!==` against a number literal is always true", async () => {
      await fires(`  @Get(":id") one(@Param("id") id: number) { if (id !== 0) return "no"; return "yes"; }`);
    });

    test("a default value does not change the supplied case", async () => {
      // `?page=2` still arrives as "2"; the default only fills an ABSENT key.
      await fires(`  @Get() list(@Query("page") page: number = 1) { return { next: page + 1 }; }`);
    });
  });

  describe("the defect — a string used where a boolean was promised", () => {
    test("`if (dry)` takes the true branch for ?dry=false", async () => {
      await fires(`  @Get() run(@Query("dry") dry: boolean) { if (dry) return "dry"; return "DELETED"; }`);
    });

    test("a ternary test", async () => {
      await fires(`  @Get() list(@Query("deleted") deleted: boolean) { return deleted ? "include" : "exclude"; }`);
    });

    test("`!flag` is always false", async () => {
      await fires(`  @Get() list(@Query("raw") raw: boolean) { if (!raw) return "cooked"; return "raw"; }`);
    });

    test("`flag && x` and `flag === true`", async () => {
      await fires(`  @Get() a(@Query("f") f: boolean) { return f && 1; }`);
      await fires(`  @Get() b(@Query("f") f: boolean) { return f === true; }`);
    });

    test("the message names the binding, the annotation and the measurement", async () => {
      const [found] = await fires(`  @Get() run(@Query("dry") dry: boolean) { if (dry) return 1; return 2; }`);
      assert.match(found!.message, /`@Query\("dry"\)`/);
      assert.match(found!.message, /string\*\* at runtime/);
      assert.match(found!.message, /plain `new ValidationPipe\(\)` does not convert/);
    });
  });

  describe("silence — the pipeline converts", () => {
    test("a pipe on the binding (measured: ParseIntPipe gives number 2)", async () => {
      await silent(`  @Get(":id") one(@Param("id", ParseIntPipe) id: number) { return id === 1; }`);
      await silent(`  @Get() run(@Query("dry", new ParseBoolPipe()) dry: boolean) { if (dry) return 1; return 2; }`);
    });

    test("a global ValidationPipe with transform: true (measured: converts)", async () => {
      const main = BARE_MAIN.replace(
        "await app.listen",
        "app.useGlobalPipes(new ValidationPipe({ transform: true }));\n  await app.listen",
      );
      await silent(`  @Get() list(@Query("page") page: number) { return page + 1; }`, main);
    });

    test("an unreadable global pipe resolves to silence", async () => {
      const main = BARE_MAIN.replace("await app.listen", "app.useGlobalPipes(buildPipe());\n  await app.listen");
      await silent(`  @Get() list(@Query("page") page: number) { return page + 1; }`, main);
      const spread = BARE_MAIN.replace(
        "await app.listen",
        "app.useGlobalPipes(new ValidationPipe({ ...opts }));\n  await app.listen",
      );
      await silent(`  @Get() list(@Query("page") page: number) { return page + 1; }`, spread);
    });

    test("APP_PIPE hides its options behind a provider", async () => {
      const module = `
import { APP_PIPE } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
export const providers = [{ provide: APP_PIPE, useClass: ValidationPipe }];
`;
      await silent(`  @Get() list(@Query("page") page: number) { return page + 1; }`, module);
    });

    test("@UsePipes on the method or the class", async () => {
      await silent(`  @Get() @UsePipes(new ValidationPipe({ transform: true })) list(@Query("p") p: number) { return p + 1; }`);
      const root = await project(
        `
import { Controller, Get, Query, UsePipes, ValidationPipe } from "@nestjs/common";
@Controller("u")
@UsePipes(new ValidationPipe())
export class C { @Get() list(@Query("p") p: number) { return p + 1; } }
`,
      );
      try {
        const report = await scanProject({ rootDirectory: root });
        assert.equal(report.findings.filter((f) => f.diagnostic === "no-unparsed-nest-route-param").length, 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("a bare ValidationPipe() is READABLE and does not convert — still fires", async () => {
      // The measured middle column: the reflex fix leaves the bug in place.
      const main = BARE_MAIN.replace(
        "await app.listen",
        "app.useGlobalPipes(new ValidationPipe({ whitelist: true }));\n  await app.listen",
      );
      await fires(`  @Get() list(@Query("page") page: number) { return page + 1; }`, main);
      const off = BARE_MAIN.replace(
        "await app.listen",
        "app.useGlobalPipes(new ValidationPipe({ transform: false }));\n  await app.listen",
      );
      await fires(`  @Get() list(@Query("page") page: number) { return page + 1; }`, off);
    });
  });

  describe("silence — the use is not broken by a string", () => {
    test("operators that coerce and work", async () => {
      // "2" * 2 === 4, "2" - 1 === 1, "2" > 1 is true. Same line as no-tofixed-as-number.
      await silent(`  @Get() a(@Query("p") p: number) { return p * 2; }`);
      await silent(`  @Get() b(@Query("p") p: number) { return p - 1; }`);
      await silent(`  @Get() c(@Query("p") p: number) { if (p > 1) return 1; return 2; }`);
      await silent(`  @Get() d(@Query("p") p: number) { return p == 1; }`);
    });

    test("`+` against something not provably numeric", async () => {
      await silent(`  @Get() a(@Query("p") p: number) { return p + offset; }`);
    });

    test("merely binding it is not a defect", async () => {
      await silent(`  @Get(":id") one(@Param("id") id: number) { return this.svc.find(id); }`);
    });

    test("a string or DTO annotation is honest", async () => {
      await silent(`  @Get(":id") one(@Param("id") id: string) { return id === "1"; }`);
      await silent(`  @Get() list(@Query() q: ListDto) { return q; }`);
    });
  });

  describe("precision guards — the binding must be the one we reason about", () => {
    test("a reassignment repairs the value", async () => {
      await silent(`  @Get() list(@Query("p") p: number) { p = Number(p); return p + 1; }`);
    });

    test("a nested declaration or parameter shadows the name", async () => {
      await silent(`  @Get() list(@Query("p") p: number) { const p2 = 1; { const p = 2; return p + 1; } }`);
      await silent(`  @Get() list(@Query("p") p: number) { return [1].map((p) => p + 1); }`);
    });

    test("a decorator we do not model could itself transform", async () => {
      await silent(`  @Get() list(@Transform() @Query("p") p: number) { return p + 1; }`);
    });

    test("a non-literal key is not a single-key bind", async () => {
      await silent(`  @Get() list(@Query(KEY) p: number) { return p + 1; }`);
      await silent(`  @Get() list(@Query() p: number) { return p + 1; }`);
    });

    test("a plain class method that is not a route is untouched", async () => {
      await silent(`  helper(p: number) { return p + 1; }`);
    });
  });
});
