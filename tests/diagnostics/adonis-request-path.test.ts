/**
 * AdonisJS controller methods as request handlers — and the three false-positive
 * classes that recognizing them exposed.
 *
 * Adonis registers routes in a DIFFERENT file, as a tuple naming a class and a
 * method by string: `router.post("/x", [AuthController, "encrypt"])`. Nothing in
 * the controller marks the method and nothing in the route file contains a
 * function, so neither handler-argument analysis nor the Express-signature
 * fallback could see it. `collectRequestHandlers` recognized ZERO Adonis
 * controllers, which made all EIGHT request-path-gated rules silent no-ops on the
 * corpus's dominant backend stack — a shipped rule that never runs is
 * indistinguishable, in a report, from a clean result.
 *
 * Recognition alone was not shippable. On one real controller it took handler
 * recognition from 0 to 107 methods and surfaced 119 findings, of which 116 were
 * false positives in three distinct classes. Each is pinned below.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noLargeJsonParseInRequestPath } from "../../src/diagnostics/event-loop/no-large-json-parse-in-request-path.ts";
import { noListenerAddedPerRequest } from "../../src/diagnostics/reliability/no-listener-added-per-request.ts";
import { noSyncIoInRequestPath } from "../../src/diagnostics/event-loop/no-sync-io-in-request-path.ts";

const CAPS = new Set(["node", "esm", "typescript", "adonis"]);
const findings = (source: string, rules: unknown[], filePath = "/repo/app/controllers/x_controller.ts") =>
  lintSource({ filePath, sourceText: source, diagnostics: rules as never, capabilities: CAPS }).findings;

/** A minimal but faithful Adonis controller. */
const controller = (body: string): string => `
  import type { HttpContext } from '@adonisjs/core/http'
  export default class XController {
    public async handle({ request, response }: HttpContext) {
      ${body}
    }
  }
`;

describe("AdonisJS controller methods are request handlers", () => {
  test("sync IO inside an Adonis controller method is on the request path", () => {
    // The payoff: 8 genuine findings in one corpus backend that were invisible.
    const found = findings(controller(`if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath)`), [
      noSyncIoInRequestPath,
    ]);
    assert.ok(found.length > 0, "fs.existsSync/mkdirSync block the event loop per request");
  });

  test("the HttpContext ANNOTATION is what identifies it, not the parameter names", () => {
    // `{ request, response }` is a shape plenty of ordinary helpers have. Without
    // the annotation there is no evidence this is a route handler at all.
    const withoutAnnotation = `
      export default class XController {
        public async handle({ request, response }) {
          if (!fs.existsSync(p)) fs.mkdirSync(p)
        }
      }
    `;
    assert.equal(findings(withoutAnnotation, [noSyncIoInRequestPath]).length, 0);
  });

  test("the Adonis import is required too, so the type name alone cannot carry it", () => {
    const foreignHttpContext = `
      import type { HttpContext } from './my-own-types.js'
      export default class XController {
        public async handle({ request, response }: HttpContext) {
          if (!fs.existsSync(p)) fs.mkdirSync(p)
        }
      }
    `;
    assert.equal(findings(foreignHttpContext, [noSyncIoInRequestPath]).length, 0);
  });

  test("Adonis 5's HttpContextContract spelling is recognized", () => {
    const v5 = `
      import type { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
      export default class XController {
        public async handle({ request, response }: HttpContextContract) {
          if (!fs.existsSync(p)) fs.mkdirSync(p)
        }
      }
    `;
    assert.ok(findings(v5, [noSyncIoInRequestPath]).length > 0);
  });
});

describe("FP class 1 — JSON.parse of a value the request merely INFLUENCED (94 findings)", () => {
  test("parsing a DB column the request selected is not caller-sized", () => {
    // This rule is about SIZE. Taint reaches `row` legitimately — a request field
    // chose which row — but the bytes come from the database, and no caller can
    // make a stored column megabytes by sending a large request.
    const found = findings(
      controller(`
        const id = request.input('id')
        const row = await locationsCollection.findOne({ location_id: id })
        const details = JSON.parse(row.location_details)
      `),
      [noLargeJsonParseInRequestPath],
    );
    assert.equal(found.length, 0);
  });

  test("the same shape with a `|| '{}'` fallback is also silent", () => {
    const found = findings(
      controller(`
        const id = request.input('id')
        const row = await coll.findOne({ id })
        const m = JSON.parse(row.mapping_details || '{}')
      `),
      [noLargeJsonParseInRequestPath],
    );
    assert.equal(found.length, 0);
  });

  test("but parsing the request payload itself still fires", () => {
    assert.ok(findings(controller(`const rows = JSON.parse(request.input('payload'))`), [
      noLargeJsonParseInRequestPath,
    ]).length > 0);
  });

  test("and a direct alias of the body still fires", () => {
    assert.ok(findings(controller(`const body = request.body; const rows = JSON.parse(body)`), [
      noLargeJsonParseInRequestPath,
    ]).length > 0);
  });
});

describe("FP class 2 & 3 — listeners on emitters created per request (17 + 5 findings)", () => {
  test("an inline fresh stream chain is not a long-lived emitter", () => {
    // `fs.createReadStream(p)` builds a new stream per call; its listeners are
    // collected with it. The chain roots at `fs`, a module, so the rule's
    // name-based per-request exclusion could never have seen this.
    const found = findings(
      controller(`fs.createReadStream(filePath).pipe(csv()).on('data', (r) => rows.push(r))`),
      [noListenerAddedPerRequest],
    );
    assert.equal(found.length, 0);
  });

  test("an emitter constructed into a local inside the handler is per-request", () => {
    const found = findings(
      controller(`
        const passThrough = new PassThrough()
        passThrough.on('data', (c) => chunks.push(c))
        const archive = archiver('zip')
        archive.on('error', reject)
      `),
      [noListenerAddedPerRequest],
    );
    assert.equal(found.length, 0, "both shapes die with the request");
  });

  test("a genuinely long-lived emitter still fires — this must not become a recall loss", () => {
    const found = findings(
      `
      import type { HttpContext } from '@adonisjs/core/http'
      const bus = getEventBus()
      export default class XController {
        public async handle({ request, response }: HttpContext) {
          bus.on('tick', () => response.send('.'))
        }
      }
      `,
      [noListenerAddedPerRequest],
    );
    assert.ok(found.length > 0, "an emitter that outlives the request is the real leak");
  });
});
