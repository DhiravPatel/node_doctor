/**
 * `no-unawaited-next-dynamic-api`.
 *
 * Since Next 15, `cookies()`, `headers()` and `draftMode()` return Promises.
 * MEASURED against a running Next 16.3.2 server over real route handlers:
 *
 *   const c = cookies();        typeof c.get  → "undefined"
 *   const h = headers();        typeof h.get  → "undefined"
 *   const c = await cookies();  typeof c.get  → "function"
 *
 * and the server logged, verbatim:
 *
 *   Route "/api/sync" used `cookies().get`. `cookies()` returns a Promise and
 *   must be unwrapped with `await` or `React.use()` before accessing its
 *   properties.
 *
 * The shipped declarations agree — Next 16.3.2 exports
 * `cookies(): Promise<ReadonlyRequestCookies>` — and the synchronous-access shim
 * Next 15 provided is gone, so this is a hard failure now, not a warning.
 *
 * The optional-chained spelling is the one worth the rule: `c?.get?.("role")`
 * does not throw, it just silently always fails, turning a broken auth check
 * into one that quietly denies or quietly allows.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnawaitedNextDynamicApi } from "../../src/diagnostics/frameworks/no-unawaited-next-dynamic-api.ts";

const CAPS = new Set(["node", "esm", "typescript", "next"]);
const IMPORT = `import { cookies, headers, draftMode } from "next/headers";\n`;

const findings = (body: string, prelude = IMPORT) =>
  lintSource({
    filePath: "/repo/app/api/users/route.ts",
    sourceText: prelude + body,
    diagnostics: [noUnawaitedNextDynamicApi],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-unawaited-next-dynamic-api");

const fires = (body: string, prelude?: string) => {
  const found = findings(body, prelude);
  assert.ok(found.length > 0, `expected a FIRE on:\n${body}`);
  return found;
};
const silent = (body: string, prelude?: string): void =>
  assert.equal(findings(body, prelude).length, 0, `expected SILENCE on:\n${body}`);

describe("no-unawaited-next-dynamic-api", () => {
  describe("the defect", () => {
    test("a member access directly on the call", () => {
      fires(`export async function GET() { return Response.json(cookies().get("session")); }`);
    });

    test("through a binding — the common spelling", () => {
      fires(`
        export async function GET() {
          const c = cookies();
          return Response.json(c.get("session"));
        }
      `);
    });

    test("destructuring the Promise", () => {
      fires(`
        export async function GET() {
          const { get } = cookies();
          return Response.json(get("session"));
        }
      `);
    });

    test("the optional-chained form, which does NOT throw", () => {
      // This is the expensive one: no TypeError, the check just always fails.
      fires(`
        export async function GET() {
          const c = cookies();
          if (c?.get?.("role") === "admin") return Response.json({ admin: true });
          return Response.json({ admin: false });
        }
      `);
    });

    test("headers() and draftMode() are the same contract", () => {
      fires(`export async function GET() { return Response.json(headers().get("x-user")); }`);
      fires(`export async function GET() { return Response.json(draftMode().isEnabled); }`);
    });

    test("an aliased import is still the same function", () => {
      fires(
        `export async function GET() { return Response.json(getCookies().get("s")); }`,
        `import { cookies as getCookies } from "next/headers";\n`,
      );
    });

    test("the message names the mechanism and the measured behaviour", () => {
      const [found] = fires(`export async function GET() { return Response.json(cookies().get("s")); }`);
      assert.match(found!.message, /returns a \*\*Promise\*\* since Next 15/);
      assert.match(found!.message, /"undefined"/);
      assert.match(found!.recommendation ?? "", /await cookies\(\)|React\.use/);
    });
  });

  describe("silence — the Promise is treated as one", () => {
    test("awaited, in both spellings", () => {
      silent(`export async function GET() { const c = await cookies(); return Response.json(c.get("s")); }`);
      silent(`export async function GET() { return Response.json((await cookies()).get("s")); }`);
    });

    test("returned", () => {
      silent(`export async function GET() { return cookies(); }`);
    });

    test("chained as a promise", () => {
      silent(`export async function GET() { return cookies().then((c) => Response.json(c.get("s"))); }`);
      silent(`export async function GET() { return cookies().catch(fallback); }`);
    });

    test("React.use(), the documented alternative to await", () => {
      silent(`export async function GET() { const c = use(cookies()); return Response.json(c.get("s")); }`);
      silent(`export async function GET() { const c = React.use(cookies()); return Response.json(c.get("s")); }`);
    });

    test("collected into Promise.all", () => {
      silent(`
        export async function GET() {
          const [c, h] = await Promise.all([cookies(), headers()]);
          return Response.json({ s: c.get("s"), u: h.get("x-user") });
        }
      `);
    });

    test("the Promise is passed onward, never read", () => {
      silent(`export async function GET() { const p = cookies(); return handle(p); }`);
    });
  });

  describe("precision guards — it must be Next's function", () => {
    test("a same-named import from somewhere else", () => {
      silent(
        `export async function GET() { return Response.json(cookies().get("s")); }`,
        `import { cookies } from "./my-cookies";\n`,
      );
    });

    test("a locally-declared cookies()", () => {
      silent(`
        function cookies() { return { get: (k) => k }; }
        export async function GET() { return Response.json(cookies().get("s")); }
      `, "");
    });

    test("no next/headers import at all", () => {
      silent(`export async function GET() { return Response.json(cookies().get("s")); }`, "");
    });

    test("a non-dynamic export of next/headers is not claimed", () => {
      silent(
        `export async function GET() { return Response.json(something().get("s")); }`,
        `import { something } from "next/headers";\n`,
      );
    });

    test("a computed member access is not claimed", () => {
      silent(`export async function GET() { return Response.json(cookies()["get"]("s")); }`);
    });
  });
});
