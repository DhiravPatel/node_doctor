import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import {
  getCalleeName,
  getMethodName,
  getReceiverName,
  getStaticStringValue,
  isFunctionLike,
} from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * A GET route that writes. GET is defined as safe and idempotent, and everything
 * downstream believes it: browsers and proxies prefetch links, crawlers follow
 * them, and any other site can fire one with `<img src="https://you/delete?id=7">`
 * — no form, no CORS preflight, cookies attached. CSRF tokens do not protect GET,
 * so a state-changing GET is a one-click account takeover primitive.
 *
 * Only a write with a *persistence-shaped receiver* (an ORM/repository/model)
 * or a raw INSERT/UPDATE/DELETE statement counts. `cache.set`, `res.cookie`,
 * `req.session.destroy`, loggers and metrics are not resource state.
 *
 * Opt-in. A GET that writes is usually a bug, but the exceptions are real and
 * protocol-mandated: an OAuth callback updating `lastLogin`, an email
 * verification or unsubscribe link, a view counter. Each is a legitimate GET
 * that writes, and each produced a verified false positive during review. Enable
 * it deliberately (`"no-state-change-on-get": "warn"`) once those routes are
 * known, rather than having it grade every repo by default.
 *
 * ❌ app.get("/users/:id/delete", (req, res) => db.users.deleteMany({ id }));
 * ✅ app.post("/users/:id/delete", (req, res) => db.users.deleteMany({ id }));
 * ✅ app.get("/users/:id", (req, res) => db.users.findMany({ id })); // read-only
 */

/** Methods that persist a change. Read verbs and counters are deliberately absent. */
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "bulkCreate",
  "insert",
  "insertOne",
  "insertMany",
  "update",
  "updateOne",
  "updateMany",
  "upsert",
  "replaceOne",
  "findOneAndUpdate",
  "findByIdAndUpdate",
  "findOneAndReplace",
  "findOneAndDelete",
  "findByIdAndDelete",
  "findByIdAndRemove",
  "delete",
  "deleteOne",
  "deleteMany",
  "destroy",
  "remove",
  "save",
  "bulkWrite",
  "drop",
  "truncate",
]);

/**
 * Receiver segments that are never a persisted resource. These names carry the
 * same verbs (`cache.delete`, `session.save`, `hash.update`, `map.delete`) and
 * firing on them would drown the real finding.
 */
const NON_RESOURCE_SEGMENTS = new Set([
  "cache",
  "caches",
  "session",
  "sessions",
  "req",
  "request",
  "res",
  "response",
  "reply",
  "cookie",
  "cookies",
  "headers",
  "console",
  "log",
  "logger",
  "logs",
  "metrics",
  "metric",
  "stats",
  "counter",
  "histogram",
  "gauge",
  "tracer",
  "span",
  "emitter",
  "bus",
  "socket",
  "ws",
  "hash",
  "hmac",
  "cipher",
  "decipher",
  "crypto",
  "map",
  "set",
  "window",
  "document",
  "localstorage",
  "sessionstorage",
  "process",
  "fs",
  "path",
  "timer",
  "clock",
]);

/** Receiver segments that mark a persistence layer (exact name or suffix). */
const PERSISTENCE_SEGMENT_RE =
  /^(db|database|prisma|knex|sequelize|mongoose|typeorm|orm|em|entitymanager|datasource|conn|connection|trx|tx|transaction)$|(repository|repositories|repo|models?|collections?|tables?|dao)$/;

/** Globals that are PascalCase but are not ORM models (`Object.create`, …). */
const GLOBAL_CONSTRUCTORS = new Set([
  "Object",
  "Array",
  "Promise",
  "Math",
  "JSON",
  "Buffer",
  "Date",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "Reflect",
  "Proxy",
  "Error",
  "RegExp",
  "Intl",
  "URL",
  "URLSearchParams",
  "Response",
  "Request",
  "Headers",
  "Blob",
  "File",
  "FormData",
  "Function",
  "Image",
]);

/** Calls whose first argument is a raw SQL string. */
const RAW_QUERY_METHODS = new Set([
  "query",
  "execute",
  "exec",
  "run",
  "raw",
  "unsafe",
  "$queryRaw",
  "$queryRawUnsafe",
  "$executeRaw",
  "$executeRawUnsafe",
  "sql",
]);

/** A statement that mutates rows — the trailing token keeps `"update available"` out. */
const SQL_WRITE_RE = /^\s*(insert\s+into|update\s+[\w"'`[]|delete\s+from|truncate\s+table|drop\s+table)/i;

/** Promise continuations: reaching one proves the call is async work, not a factory. */
const PROMISE_METHODS = new Set(["then", "catch", "finally"]);

const isModelIdentifier = (segment: string): boolean =>
  /^[A-Z][A-Za-z0-9]*$/.test(segment) && !GLOBAL_CONSTRUCTORS.has(segment);

/**
 * How persistence-shaped a receiver is:
 *  - "orm"   — an explicit ORM/repository/model path (`db.users`, `userRepository`).
 *  - "model" — a bare PascalCase identifier (`User.destroy(…)`), which is also how
 *    value-object factories look (`Money.create(5)`), so it needs a second signal.
 */
const receiverKind = (path: string | null): "orm" | "model" | null => {
  if (!path) return null;
  const segments = path.split(".");
  for (const segment of segments) {
    if (NON_RESOURCE_SEGMENTS.has(segment.toLowerCase())) return null;
  }
  if (segments.some((s) => PERSISTENCE_SEGMENT_RE.test(s.toLowerCase()))) return "orm";
  if (segments.some(isModelIdentifier)) return "model";
  return null;
};

/** Is the call awaited or continued with `.then`/`.catch`? (I/O, not a sync factory.) */
const isAsyncUse = (node: AstNode): boolean => {
  let current: AstNode = node;
  let parent: AstNode | null | undefined = node.parent;
  while (parent) {
    if (parent.type === "AwaitExpression") return true;
    if (parent.type === "ChainExpression" || parent.type === "TSNonNullExpression") {
      current = parent;
      parent = parent.parent;
      continue;
    }
    if (
      parent.type === "MemberExpression" &&
      parent.object === current &&
      !parent.computed &&
      parent.property?.type === "Identifier" &&
      PROMISE_METHODS.has(parent.property.name)
    ) {
      return true;
    }
    return false;
  }
  return false;
};

/** The static text of a literal / template / `+` concatenation. */
const staticText = (node: AstNode | null | undefined): string => {
  if (!node) return "";
  if (node.type === "TemplateLiteral") {
    return (node.quasis as AstNode[]).map((q) => q.value?.cooked ?? q.value?.raw ?? "").join(" ");
  }
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return `${staticText(node.left)} ${staticText(node.right)}`;
  }
  return "";
};

/** The leading write verb of a SQL string, uppercased, or null for a read. */
const sqlWriteVerb = (text: string): string | null => {
  if (!SQL_WRITE_RE.test(text)) return null;
  return text.trim().split(/\s+/)[0]!.toUpperCase();
};

/** A route path argument: `"/users/:id"`, `"*"` — never a cache key or a setting name. */
const isRoutePath = (node: AstNode | null | undefined): boolean => {
  const value = getStaticStringValue(node);
  return !!value && (value.startsWith("/") || value === "*");
};

export const noStateChangeOnGet = defineDiagnostic({
  id: "no-state-change-on-get",
  title: "GET route performs a write",
  severity: "warn",
  category: "Security",
  defaultEnabled: false,
  tags: ["csrf", "http"],
  recommendation:
    "Move the write to POST/PUT/PATCH/DELETE (and protect it with a CSRF token). GET must stay safe and idempotent: prefetchers, crawlers and a cross-site `<img src>` all trigger it with the victim's cookies, and CSRF defenses do not cover GET.",
  create: (ctx) => {
    // A handler can be reached twice (registered on two paths); report it once.
    const scanned = new Set<AstNode>();

    const collectHandlers = (arg: AstNode | null | undefined, out: AstNode[]): void => {
      if (!arg) return;
      if (isFunctionLike(arg)) {
        out.push(arg);
        return;
      }
      // Wrapper call — `asyncHandler(fn)` — and middleware arrays.
      if (arg.type === "CallExpression") {
        for (const inner of (arg.arguments as AstNode[]) ?? []) collectHandlers(inner, out);
        return;
      }
      if (arg.type === "ArrayExpression") {
        for (const el of (arg.elements as (AstNode | null)[]) ?? []) collectHandlers(el, out);
        return;
      }
      if (arg.type === "Identifier") {
        const binding = ctx.scope.getBinding(arg.name, arg);
        if (binding && binding.initNode && isFunctionLike(binding.initNode)) out.push(binding.initNode);
      }
    };

    /** A label for the write, e.g. "db.users.deleteMany". */
    const label = (call: AstNode): string => getCalleeName(call) ?? getMethodName(call) ?? "the write";

    /** The first persisted write inside a handler, in source order, or null. */
    const findWrite = (fn: AstNode): { node: AstNode; what: string } | null => {
      const calls = collectDescendants(
        fn,
        (n) => n.type === "CallExpression" || n.type === "TaggedTemplateExpression",
      );
      for (const call of calls) {
        if (call.type === "TaggedTemplateExpression") {
          const tag = getMethodName(call.tag);
          if (!tag || !RAW_QUERY_METHODS.has(tag)) continue;
          const verb = sqlWriteVerb(staticText(call.quasi));
          if (verb) return { node: call, what: `a raw ${verb} statement` };
          continue;
        }

        const method = getMethodName(call);
        if (!method) continue;

        // Raw SQL: the statement itself is unambiguous, whatever the receiver.
        if (RAW_QUERY_METHODS.has(method)) {
          const verb = sqlWriteVerb(staticText((call.arguments as AstNode[])?.[0]));
          if (verb) return { node: call, what: `a raw ${verb} statement via \`${label(call)}\`` };
        }

        if (!WRITE_METHODS.has(method)) continue;
        const kind = receiverKind(getReceiverName(call));
        if (!kind) continue;
        // A bare `Thing.create(…)` is only a write when it is real async work.
        if (kind === "model" && !isAsyncUse(call)) continue;
        return { node: call, what: `\`${label(call)}()\`` };
      }
      return null;
    };

    const inspect = (handler: AstNode): void => {
      if (scanned.has(handler)) return;
      scanned.add(handler);
      const write = findWrite(handler);
      if (!write) return;
      ctx.report(
        write.node,
        `A GET handler performs ${write.what} — GET must be safe and idempotent, and CSRF protection does not cover it, so a prefetch, a crawler, or a cross-site \`<img src>\` can trigger this write.`,
      );
    };

    return {
      CallExpression: (node) => {
        if (getMethodName(node) !== "get") return;
        const args = (node.arguments as AstNode[]) ?? [];
        // `app.get(path, handler)`, `router.get(name, path, handler)` (Koa).
        // Requiring a route-shaped path keeps `cache.get(key)` out.
        if (args.length < 2) return;
        if (!isRoutePath(args[0]) && !isRoutePath(args[1])) return;

        const handlers: AstNode[] = [];
        for (const arg of args.slice(1)) collectHandlers(arg, handlers);
        for (const handler of handlers) inspect(handler);
      },
      MethodDefinition: (node) => {
        if (!isFunctionLike(node.value)) return;
        for (const decorator of (node.decorators as AstNode[]) ?? []) {
          const expr = decorator.expression;
          const name =
            expr?.type === "CallExpression"
              ? getMethodName(expr)
              : expr?.type === "Identifier"
                ? expr.name
                : null;
          if (name === "Get") {
            inspect(node.value);
            return;
          }
        }
      },
    };
  },
});
