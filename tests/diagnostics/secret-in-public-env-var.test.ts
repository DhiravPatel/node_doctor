/**
 * `no-secret-in-public-env-var`.
 *
 * MEASURED by building two real apps, each with the same two variables in its
 * `.env`, and grepping the SHIPPED CLIENT OUTPUT for the values:
 *
 *   Next 16.3.4   NEXT_PUBLIC_API_SECRET  → FOUND in .next/static/chunks/0fj2_5j1epjqr.js
 *                 API_SECRET              → not present anywhere in .next/static
 *   Vite 7        VITE_API_SECRET         → FOUND in dist/assets/index-DqHaUkPg.js
 *                 API_SECRET              → not present anywhere in dist
 *
 * The prefix is the entire difference. Nothing warns, the build succeeds, and the
 * value is then in a CDN-cached static asset.
 *
 * The exclusions are the whole rule, because half the point of these prefixes is
 * to publish things ON PURPOSE. `API_KEY` is deliberately NOT a trigger word:
 * `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is the documented Maps pattern, and its key
 * is restricted by referrer and meant to ship.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noSecretInPublicEnvVar } from "../../src/diagnostics/security/no-secret-in-public-env-var.ts";

const CAPS = new Set(["node", "esm", "typescript"]);

const findings = (source: string) =>
  lintSource({
    filePath: "/repo/src/config.ts",
    sourceText: source,
    diagnostics: [noSecretInPublicEnvVar],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-secret-in-public-env-var");

const fires = (source: string) => {
  const found = findings(source);
  assert.ok(found.length > 0, `expected a FIRE on:\n${source}`);
  return found;
};
const silent = (source: string): void => {
  const found = findings(source);
  assert.equal(found.length, 0, `expected SILENCE on:\n${source}\ngot: ${found.map((f) => f.message).join("\n")}`);
};

describe("no-secret-in-public-env-var", () => {
  describe("the defect — inlined into the shipped bundle", () => {
    test("the classic catastrophic pair", () => {
      fires(`export const k = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;`);
      fires(`export const k = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;`);
    });

    test("every public prefix", () => {
      for (const prefix of ["NEXT_PUBLIC_", "VITE_", "REACT_APP_", "GATSBY_", "EXPO_PUBLIC_", "NUXT_PUBLIC_", "PUBLIC_"]) {
        fires(`export const k = process.env.${prefix}APP_SECRET;`);
      }
    });

    test("import.meta.env, which is how Vite reads them", () => {
      fires(`export const k = import.meta.env.VITE_API_SECRET;`);
      fires(`export const k = import.meta.env.VITE_DATABASE_URL;`);
    });

    test("every never-publishable word", () => {
      for (const word of [
        "SECRET", "PASSWORD", "PASSPHRASE", "PRIVATE_KEY", "SERVICE_ROLE", "SERVICE_ACCOUNT",
        "CREDENTIALS", "AUTH_TOKEN", "ACCESS_TOKEN", "REFRESH_TOKEN", "DATABASE_URL",
        "MONGODB_URI", "REDIS_URL", "CONNECTION_STRING",
      ]) {
        fires(`export const k = process.env.NEXT_PUBLIC_${word};`);
      }
    });

    test("the message names the prefix, the word and the measurement", () => {
      const [found] = fires(`export const k = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;`);
      assert.match(found!.message, /`NEXT_PUBLIC_` prefix/);
      assert.match(found!.message, /inlines the value into the JavaScript every visitor downloads/);
      assert.match(found!.message, /\.next\/static\/chunks/);
      assert.match(found!.message, /dist\/assets/);
      assert.match(found!.recommendation ?? "", /rotating it is the only remedy/);
    });
  });

  describe("silence — publishable by design is half the point of the prefix", () => {
    test("the credentials that are SUPPOSED to be in the bundle", () => {
      silent(`export const k = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;`);
      silent(`export const k = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;`);
      silent(`export const k = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;`);
      silent(`export const k = process.env.NEXT_PUBLIC_SENTRY_DSN;`);
      silent(`export const k = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;`);
      silent(`export const k = process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID;`);
    });

    test("API_KEY is deliberately not a trigger word", () => {
      // `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is the documented Maps pattern, and the
      // key is restricted by HTTP referrer rather than kept secret.
      silent(`export const k = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;`);
      silent(`export const k = process.env.NEXT_PUBLIC_API_KEY;`);
    });

    test("ordinary public configuration", () => {
      silent(`export const u = process.env.NEXT_PUBLIC_API_URL;`);
      silent(`export const u = process.env.NEXT_PUBLIC_SUPABASE_URL;`);
      silent(`export const u = process.env.VITE_APP_VERSION;`);
    });

    test("a publishable marker overrides a trigger word", () => {
      silent(`export const k = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_SECRET;`);
    });
  });

  describe("precision guards", () => {
    test("the same name WITHOUT a public prefix is the correct spelling", () => {
      // Measured: it appeared in neither build's client output.
      silent(`export const k = process.env.STRIPE_SECRET_KEY;`);
      silent(`export const k = process.env.DATABASE_URL;`);
      silent(`export const k = process.env.SUPABASE_SERVICE_ROLE_KEY;`);
    });

    test("a computed or dynamic read cannot be judged", () => {
      silent(`export const k = process.env[name];`);
      silent(`export const k = process.env["NEXT_PUBLIC_" + suffix];`);
    });

    test("an `env` on something that is not process or import.meta", () => {
      silent(`export const k = config.env.NEXT_PUBLIC_API_SECRET;`);
      silent(`export const k = ctx.env.NEXT_PUBLIC_API_SECRET;`);
    });

    test("a plain property that merely looks like one", () => {
      silent(`export const k = settings.NEXT_PUBLIC_API_SECRET;`);
    });
  });

  test("determinism — identical source yields identical findings", () => {
    const source = `export const a = process.env.NEXT_PUBLIC_API_SECRET;\nexport const b = import.meta.env.VITE_DATABASE_URL;`;
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
