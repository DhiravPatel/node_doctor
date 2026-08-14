/**
 * §9 — `no-error-response-with-success-status`.
 *
 * A caught exception reported with a 2xx. Every layer that reads the status
 * instead of the body then records a success: `res.ok` is true, axios resolves,
 * APM shows a 100% success rate, retries never fire.
 *
 * The shapes here are taken from a 220,042-file sweep, which found 138 real
 * instances in application controllers and zero in `node_modules` — the profile
 * of a team convention rather than a library mistake.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noErrorResponseWithSuccessStatus } from "../../src/diagnostics/http/no-error-response-with-success-status.ts";

const findings = (source: string, filePath = "/repo/src/controllers/orders.ts") =>
  lintSource({
    filePath,
    sourceText: source,
    diagnostics: [noErrorResponseWithSuccessStatus],
    capabilities: new Set(["node", "esm", "typescript", "express"]),
  }).findings.filter((f) => f.diagnostic === "no-error-response-with-success-status");

const fires = (source: string, filePath?: string) => {
  const found = findings(source, filePath);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string, filePath?: string): void =>
  assert.equal(findings(source, filePath).length, 0, `expected SILENCE on:\n${source}`);

describe("no-error-response-with-success-status", () => {
  describe("the defect", () => {
    test("the shape found in the corpus: status(200) with the caught error", () => {
      fires(`
        async function getCombo({ response }) {
          try { await complete() } catch (error) {
            return response.status(200).json({
              status: false, error: 'Combo completion failed', details: error?.message,
            })
          }
        }
      `);
    });

    test("no status at all — Express, Adonis and Fastify all default to 200", () => {
      fires(`
        app.get('/x', async (req, res) => {
          try { await go() } catch (e) { res.json({ success: false, error: e.message }) }
        })
      `);
    });

    test("any 2xx, not only 200", () => {
      fires(`
        app.get('/x', async (req, res) => {
          try { await go() } catch (e) { res.status(201).json({ error: 'nope' }) }
        })
      `);
      fires(`
        app.get('/x', async (req, res) => {
          try { await go() } catch (e) { res.status(202).json({ error: 'nope' }) }
        })
      `);
    });

    test("Fastify's reply.code(200).send(object)", () => {
      fires(`
        async function h(req, reply) {
          try { await go() } catch (e) { return reply.code(200).send({ error: e.message }) }
        }
      `);
    });

    test("status set as its own statement rather than chained", () => {
      fires(`
        app.get('/x', async (req, res) => {
          try { await go() } catch (e) { res.status(200); res.json({ error: 'x' }) }
        })
      `);
    });

    test("a failure flag alone is enough — the error need not be serialized", () => {
      fires(`
        app.post('/t', async (req, res) => {
          try { JSON.parse(raw) } catch (e) {
            return res.status(200).json({ status: false, data: null, message: 'AI response was not valid JSON' })
          }
        })
      `);
    });

    test("the message names the status it found", () => {
      const [finding] = fires(`
        app.get('/x', async (req, res) => {
          try { await go() } catch (e) { res.status(200).json({ error: e.message }) }
        })
      `);
      assert.match(finding!.message, /HTTP 200/);
    });
  });

  describe("the status must be provably 2xx", () => {
    test("a correct 500 is silent", () => {
      silent(`
        app.get('/x', async (req, res) => {
          try { await go() } catch (e) { res.status(500).json({ error: e.message }) }
        })
      `);
    });

    test("a 4xx the caller can act on is silent", () => {
      silent(`
        app.get('/x', async (req, res) => {
          try { await go() } catch (e) { res.status(400).json({ error: 'bad input' }) }
        })
      `);
    });

    test("a computed status is unknown, and unknown is silence", () => {
      silent(`
        app.get('/x', async (req, res) => {
          try { await go() } catch (e) { res.status(e.statusCode).json({ error: e.message }) }
        })
      `);
    });

    test("a non-2xx set as its own statement is silence", () => {
      silent(`
        app.get('/x', async (req, res) => {
          try { await go() } catch (e) { res.status(500); res.json({ error: 'x' }) }
        })
      `);
    });
  });

  describe("the payload must evidence failure", () => {
    test("a catch that recovers and returns real data is correct", () => {
      silent(`
        app.get('/x', async (req, res) => {
          try { await primary() } catch (e) { const d = await fallback(); res.json({ data: d }) }
        })
      `);
    });

    test("an `error: null` kept for response shape is not a failure claim", () => {
      silent(`
        app.get('/x', async (req, res) => {
          try { await primary() } catch (e) { const d = await fallback(); res.json({ data: d, error: null }) }
        })
      `);
    });

    test("`errors: []` is the absence of errors", () => {
      silent(`
        app.get('/x', async (req, res) => {
          try { await go() } catch (e) { res.json({ data: 1, errors: [] }) }
        })
      `);
    });

    test("a success flag set true is not a failure claim", () => {
      silent(`
        app.get('/x', async (req, res) => {
          try { await fresh() } catch (e) { res.json({ success: true, cached: true }) }
        })
      `);
    });
  });

  describe("exclusions found in real code", () => {
    test("GraphQL's { data, errors } envelope — 200 is what the spec requires", () => {
      silent(`
        app.post('/graphql', async (req, res) => {
          try { await exec() } catch (e) {
            res.json({ data: null, errors: [{ message: e.message }] })
          }
        })
      `);
    });

    test("a file that imports a GraphQL server is not judged", () => {
      silent(`
        import { graphql } from 'graphql';
        app.post('/g', async (req, res) => {
          try { await go() } catch (e) { res.json({ error: e.message }) }
        })
      `);
    });

    test("a webhook acknowledgement is deliberate — it stops provider retries", () => {
      silent(`
        async function handleStripeWebhook(req, res) {
          try { await process(req.body) } catch (e) { res.json({ error: e.message }) }
        }
      `);
    });

    test("an OAuth callback route is not judged", () => {
      silent(
        `app.get('/cb', async (req, res) => {
          try { await go() } catch (e) { res.json({ error: e.message }) }
        })`,
        "/repo/src/routes/oauth-callback.ts",
      );
    });

    test("an HTML page is not an API error envelope", () => {
      silent(
        "app.get('/x', async (req, res) => { try { await go() } catch (e) { res.send(`<html>${e.message}</html>`) } })",
      );
    });

    test("a plain string body is not judged", () => {
      silent(`
        app.get('/x', async (req, res) => {
          try { await go() } catch (e) { res.send('failed') }
        })
      `);
    });
  });

  describe("scope", () => {
    test("a non-response receiver is not judged", () => {
      silent(`try { go() } catch (e) { logger.json({ error: e.message }) }`);
    });

    test("a response outside any catch is not judged", () => {
      silent(`app.get('/x', (req, res) => { res.json({ error: 'validation failed' }) })`);
    });

    test("no catch clause at all", () => {
      silent(`app.get('/x', (req, res) => { res.status(200).json({ ok: true }) })`);
    });
  });
});
