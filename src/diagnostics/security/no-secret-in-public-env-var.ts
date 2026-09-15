import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";

/**
 * A credential read through a bundler's PUBLIC env prefix. Those prefixes are not
 * a naming convention — they are the switch that decides whether the value is
 * inlined into the JavaScript every visitor downloads.
 *
 *   ❌ process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY
 *   ❌ import.meta.env.VITE_DATABASE_URL
 *   ✅ process.env.STRIPE_SECRET_KEY              // server-only, never bundled
 *   ✅ process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY  // publishable by design
 *
 * MEASURED by building two real apps, each with the same two variables in its
 * `.env`, and grepping the SHIPPED CLIENT OUTPUT for the values:
 *
 *   Next 16.3.4   NEXT_PUBLIC_API_SECRET  → FOUND in .next/static/chunks/0fj2_5j1epjqr.js
 *                 API_SECRET              → not present anywhere in .next/static
 *   Vite 7        VITE_API_SECRET         → FOUND in dist/assets/index-DqHaUkPg.js
 *                 API_SECRET              → not present anywhere in dist
 *
 * The prefix is the entire difference. Nothing warns at build time, the build
 * succeeds, and the value is then in a static asset served from a CDN — cached by
 * intermediaries, indexed by anyone who looks, and present in every browser that
 * has ever loaded the page. Rotating it is the only remedy, and you cannot know
 * who already has it.
 *
 * PRECISION MODEL, and the exclusions are the whole rule, because half the point
 * of these prefixes is to publish things ON PURPOSE.
 *
 * The read must be `process.env.<NAME>` or `import.meta.env.<NAME>` with a
 * statically readable `<NAME>` that begins with a known public prefix —
 * `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `GATSBY_`, `EXPO_PUBLIC_`,
 * `NUXT_PUBLIC_`, `PUBLIC_` — and the remainder must contain a word that is
 * NEVER publishable.
 *
 * That list is deliberately short and does not include `API_KEY`, which was the
 * obvious candidate and is wrong: `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is the
 * documented pattern for Maps, whose key is restricted by HTTP referrer and is
 * meant to ship. The same reasoning excludes `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
 * `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SENTRY_DSN`,
 * `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` and every `_CLIENT_ID` — all of which are
 * credentials of a kind, and all of which are supposed to be in the bundle.
 *
 * What is left is the set of words with no publishable counterpart at all:
 * `SECRET` in any position (which alone covers `CLIENT_SECRET`, `JWT_SECRET`,
 * `WEBHOOK_SECRET` and AWS's `SECRET_ACCESS_KEY`), a password, a private key, a
 * service-role or service-account credential, a database or cache connection
 * string, and the token families that grant access rather than identify.
 */

/** Prefixes a bundler treats as "inline this into the client bundle". */
const PUBLIC_PREFIXES = [
  "NEXT_PUBLIC_",
  "VITE_",
  "REACT_APP_",
  "GATSBY_",
  "EXPO_PUBLIC_",
  "NUXT_PUBLIC_",
  "PUBLIC_",
];

/**
 * Words with no publishable counterpart. Kept short on purpose: `API_KEY`,
 * `CLIENT_ID`, `SITE_KEY`, `ANON` and `DSN` are all absent because each names a
 * credential that is SUPPOSED to be in the bundle.
 */
const NEVER_PUBLIC = [
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "PRIVATE_KEY",
  "PRIVATEKEY",
  "SERVICE_ROLE",
  "SERVICE_ACCOUNT",
  "CREDENTIALS",
  "AUTH_TOKEN",
  "ACCESS_TOKEN",
  "REFRESH_TOKEN",
  "SESSION_TOKEN",
  "DATABASE_URL",
  "DB_URL",
  "MONGODB_URI",
  "MONGO_URL",
  "POSTGRES_URL",
  "POSTGRESQL_URL",
  "MYSQL_URL",
  "REDIS_URL",
  "CONNECTION_STRING",
];

/** Markers that say "publishable by design", which override everything above. */
const PUBLISHABLE_MARKERS = ["PUBLISHABLE", "ANON", "SITE_KEY", "CLIENT_ID", "MEASUREMENT_ID", "PUBLIC_KEY"];

/** Is this `process` or `import.meta` — the two roots that carry an `env`? */
const isEnvRoot = (node: AstNode | undefined): boolean => {
  if (node?.type === "Identifier") return String(node.name) === "process";
  if (node?.type !== "MetaProperty") return false;
  const meta = node.meta as AstNode | undefined;
  const property = node.property as AstNode | undefined;
  return (
    meta?.type === "Identifier" &&
    String(meta.name) === "import" &&
    property?.type === "Identifier" &&
    String(property.name) === "meta"
  );
};

/** The env var this member read names, or null when it is not one. */
const envVarName = (node: AstNode): string | null => {
  if (node.type !== "MemberExpression" || node.computed) return null;
  const property = node.property as AstNode | undefined;
  if (property?.type !== "Identifier") return null;

  // `<root>.env.<NAME>`
  const object = node.object as AstNode | undefined;
  if (object?.type !== "MemberExpression" || object.computed) return null;
  const envProperty = object.property as AstNode | undefined;
  if (envProperty?.type !== "Identifier" || String(envProperty.name) !== "env") return null;
  if (!isEnvRoot(object.object as AstNode)) return null;

  return String(property.name);
};

export const noSecretInPublicEnvVar = defineDiagnostic({
  id: "no-secret-in-public-env-var",
  title: "Credential read through a bundler's public env prefix, so it ships to every browser",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["secrets", "bundler", "owasp:a02"],
  recommendation:
    "Drop the public prefix and read it only on the server (a route handler, a server action, `getServerSideProps`), then return just the derived result to the client. These prefixes are not a naming convention — measured by building both, Next 16.3.4 inlined `NEXT_PUBLIC_API_SECRET` into `.next/static/chunks/` and Vite inlined `VITE_API_SECRET` into `dist/assets/`, while the same variable without the prefix appeared in neither. Nothing warns, the build succeeds, and the value is then in a CDN-cached static asset. If it has already shipped, rotating it is the only remedy.",
  create: (ctx) => ({
    MemberExpression: (node) => {
      const name = envVarName(node);
      if (name === null) return;

      const prefix = PUBLIC_PREFIXES.find((p) => name.startsWith(p));
      if (prefix === undefined) return;

      const rest = name.slice(prefix.length);
      // Publishable by design — half the point of these prefixes.
      if (PUBLISHABLE_MARKERS.some((marker) => rest.includes(marker))) return;
      const word = NEVER_PUBLIC.find((w) => rest.includes(w));
      if (word === undefined) return;

      ctx.report(
        node,
        `\`${name}\` carries the \`${prefix}\` prefix, which is not a naming convention — it is the switch that **inlines the value into the JavaScript every visitor downloads**, and \`${word}\` names something that has no publishable counterpart. Measured by building both: Next 16.3.4 put \`NEXT_PUBLIC_API_SECRET\` into \`.next/static/chunks/\` and Vite put \`VITE_API_SECRET\` into \`dist/assets/\`, while the same variable **without** the prefix appeared in neither build. Nothing warns and the build succeeds, so the value ends up in a CDN-cached static asset that every browser which loaded the page already has. Read it server-side under the unprefixed name, and rotate it if this has shipped.`,
      );
    },
  }),
});
