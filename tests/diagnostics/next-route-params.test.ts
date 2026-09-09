/**
 * `no-unawaited-next-route-params`.
 *
 * Since Next 15 the App Router's `params` and `searchParams` props are
 * **Promises**. MEASURED against a running Next 16.3.4 server, every case a real
 * route fetched over HTTP:
 *
 *   route.js  GET(req, { params })       params.id             → 200 {"id":"undefined"}
 *   route.js  GET(req, { params })       params?.id ?? "MISS"  → 200 {"…":"MISS"}
 *   route.js  GET(req, { params: {id} }) id                    → 200 {"id":"undefined"}
 *   route.js  GET(req, ctx)              ctx.params.id         → 200 {"id":"undefined"}
 *   page.js   Page({ params, searchParams })  both reads       → 200 both "undefined"
 *   page.js   generateMetadata({ params })    params.id        → <title>user undefined</title>
 *   route.js  GET(req, { params })       await params          → 200 {"id":"abc"}   ✅
 *
 * `typeof params.then` was `"function"` in every failing case, and THE SERVER LOG
 * WAS EMPTY — no warning, no error, not one line. That is what separates this
 * from `no-unawaited-next-dynamic-api`: `cookies().get(…)` throws a 500 and Next
 * logs a specific complaint, whereas this answers 200 with the field silently
 * missing.
 *
 * The anchor is the App Router file convention, so the path matters as much as
 * the source — a Pages Router `getServerSideProps({ params })` receives a plain
 * object and must never be reported.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnawaitedNextRouteParams } from "../../src/diagnostics/frameworks/no-unawaited-next-route-params.ts";

const CAPS = new Set(["node", "esm", "typescript", "next", "next:15"]);
/** A Next 14 manifest grants `next` but NOT `next:15`, where `params` is a plain object. */
const NEXT_14 = new Set(["node", "esm", "typescript", "next"]);

const ROUTE = "/repo/app/api/users/[id]/route.ts";
const PAGE = "/repo/app/u/[id]/page.tsx";
const LAYOUT = "/repo/app/u/[id]/layout.tsx";

const findings = (source: string, filePath = ROUTE, capabilities = CAPS) =>
  lintSource({ filePath, sourceText: source, diagnostics: [noUnawaitedNextRouteParams], capabilities }).findings.filter(
    (f) => f.diagnostic === "no-unawaited-next-route-params",
  );

const fires = (source: string, filePath?: string) => {
  const found = findings(source, filePath);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string, filePath?: string): void => {
  const found = findings(source, filePath);
  assert.equal(found.length, 0, `expected SILENCE on:\n${source}\ngot: ${found.map((f) => f.message).join("\n")}`);
};

describe("no-unawaited-next-route-params", () => {
  describe("the defect — measured 200 with the field undefined", () => {
    test("a member read in a route handler", () => {
      fires(`export async function GET(req, { params }) { return db.find(params.id); }`);
    });

    test("the defensive spelling, which never fails and never works", () => {
      // Measured: `params?.id ?? "MISS"` answered 200 with "MISS".
      fires(`export async function GET(req, { params }) { return db.find(params?.id ?? "all"); }`);
    });

    test("destructured in the signature", () => {
      fires(`export async function GET(req, { params: { id } }) { return db.find(id); }`);
    });

    test("destructured in the body", () => {
      fires(`export async function GET(req, { params }) { const { id } = params; return db.find(id); }`);
    });

    test("the whole context object bound, then `ctx.params.id`", () => {
      fires(`export async function GET(req, ctx) { return db.find(ctx.params.id); }`);
    });

    test("a computed read", () => {
      fires(`export async function GET(req, { params }) { return db.find(params[key]); }`);
    });

    test("a spread, which yields {} because a Promise has no own enumerable keys", () => {
      fires(`export async function GET(req, { params }) { return db.find({ ...params }); }`);
    });

    test("every HTTP method export, and the const-arrow form", () => {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
        fires(`export async function ${method}(req, { params }) { return db.find(params.id); }`);
      }
      fires(`export const GET = async (req, { params }) => db.find(params.id);`);
    });

    test("a page's default export, both props", () => {
      const found = fires(
        `export default async function Page({ params, searchParams }) { return render(params.id, searchParams.q); }`,
        PAGE,
      );
      assert.equal(found.length, 2);
      assert.ok(found.some((f) => f.message.includes("`searchParams` is a **Promise**")));
    });

    test("an anonymous default export, and a default-exported const", () => {
      fires(`export default async function ({ params }) { return render(params.id); }`, PAGE);
      fires(`const Page = async ({ params }) => render(params.id);\nexport default Page;`, PAGE);
    });

    test("generateMetadata gets the same props", () => {
      // Measured: rendered `<title>user undefined</title>`.
      fires(`export async function generateMetadata({ params }) { return { title: params.id }; }`, PAGE);
    });

    test("the message names the prop and the measured result", () => {
      const [found] = fires(`export async function GET(req, { params }) { return db.find(params.id); }`);
      assert.match(found!.message, /`params` is a \*\*Promise\*\*/);
      assert.match(found!.message, /answers \*\*200\*\* with the field `"undefined"`/);
      assert.match(found!.message, /server logs nothing/);
      assert.match(found!.recommendation ?? "", /React\.use/);
    });
  });

  describe("silence — the Promise is treated as one", () => {
    test("await, in both spellings", () => {
      silent(`export async function GET(req, { params }) { const { id } = await params; return db.find(id); }`);
      silent(`export async function GET(req, { params }) { return db.find((await params).id); }`);
      silent(`export async function GET(req, ctx) { const { id } = await ctx.params; return db.find(id); }`);
    });

    test("React.use, the client-component form", () => {
      silent(`export default function Page({ params }) { const { id } = use(params); return render(id); }`, PAGE);
      silent(`export default function Page({ params }) { const p = React.use(params); return render(p.id); }`, PAGE);
    });

    test(".then / .catch / .finally", () => {
      silent(`export async function GET(req, { params }) { return params.then((p) => db.find(p.id)); }`);
      silent(`export async function GET(req, { params }) { return params.catch(noop); }`);
    });

    test("passing it onward unread", () => {
      silent(`export async function GET(req, { params }) { return handle(params); }`);
      silent(`export async function GET(req, { params }) { const p = params; return handle(p); }`);
      silent(`export async function GET(req, { params }) { return params; }`);
    });
  });

  describe("the file-convention anchor", () => {
    test("a Pages Router file is never reported", () => {
      // `getServerSideProps({ params })` receives a plain OBJECT, not a Promise.
      silent(
        `export async function getServerSideProps({ params }) { return { props: { id: params.id } }; }`,
        "/repo/pages/u/[id].tsx",
      );
    });

    test("an ordinary module that happens to destructure `params`", () => {
      silent(`export async function GET(req, { params }) { return db.find(params.id); }`, "/repo/src/lib/handlers.ts");
      silent(`export async function GET(req, { params }) { return db.find(params.id); }`, "/repo/app/lib/helpers.ts");
    });

    test("every reserved basename, and only under an `app/` segment", () => {
      const HANDLER = `export async function GET(req, { params }) { return db.find(params.id); }`;
      const VIEW = `export default async function V({ params }) { return render(params.id); }`;
      fires(HANDLER, ROUTE);
      fires(HANDLER, "/repo/src/app/api/x/route.js");
      // `default.tsx` is a parallel-route VIEW, so its entry is the default export.
      fires(VIEW, "/repo/app/u/[id]/default.tsx");
      silent(HANDLER, "/repo/app/u/[id]/default.tsx");
      silent(HANDLER, "/repo/routes/api/route.ts");
    });

    test("`searchParams` is a page prop, not a layout one", () => {
      // A layout is not re-rendered on a query-string change and never gets it.
      silent(`export default async function L({ searchParams }) { return render(searchParams.q); }`, LAYOUT);
      fires(`export default async function L({ params }) { return render(params.id); }`, LAYOUT);
    });

    test("`searchParams` is not a route-handler prop either", () => {
      silent(`export async function GET(req, { searchParams }) { return db.find(searchParams.q); }`);
    });

    test("a non-exported function in a route file is not an entry point", () => {
      silent(`async function helper(req, { params }) { return db.find(params.id); }`);
    });

    test("a route file's default export is not how Next calls it", () => {
      silent(`export default async function (req, { params }) { return db.find(params.id); }`);
    });
  });

  describe("precision guards", () => {
    test("a Next 14 manifest is silent, because params is a plain object there", () => {
      const body = `export async function GET(req, { params }) { return db.find(params.id); }`;
      assert.ok(findings(body).length > 0, "expected a FIRE under next:15");
      assert.equal(findings(body, ROUTE, NEXT_14).length, 0, "expected SILENCE under Next 14");
    });

    test("a reassignment repairs the binding", () => {
      silent(`export async function GET(req, { params }) { params = await params; return db.find(params.id); }`);
    });

    test("a nested declaration or parameter shadows the name", () => {
      silent(
        `export async function GET(req, { params }) { return list.map((params) => params.id); }`,
      );
      silent(
        `export async function GET(req, { params }) { const params2 = 1; { const params = await load(); return params.id; } }`,
      );
    });

    test("a renamed binding is followed", () => {
      fires(`export async function GET(req, { params: p }) { return db.find(p.id); }`);
      silent(`export async function GET(req, { params: p }) { return db.find((await p).id); }`);
    });

    test("a rest element or computed key is not a readable binding", () => {
      silent(`export async function GET(req, { ...rest }) { return db.find(rest.params.id); }`);
      silent(`export async function GET(req, { [k]: params }) { return db.find(params.id); }`);
    });

    test("a property named `params` on something else is untouched", () => {
      silent(`export async function GET(req, { params }) { return db.find(other.params.id); }`);
      silent(`export async function GET(req, ctx) { return db.find(ctx.query.id); }`);
    });
  });
});
