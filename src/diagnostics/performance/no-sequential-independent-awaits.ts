import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, rootObjectName, unwrapChain } from "../../core/ast.ts";
import { collectDescendants } from "../../core/walk.ts";

/**
 * §132 — static latency / parallelizable critical path.
 *
 * OPT-IN (defaultEnabled: false, advisory) — this is a latency *shape*, not a
 * correctness defect, so it must never touch the default self-scan.
 *
 * Two or more CONSECUTIVE, INDEPENDENT network reads (HTTP GETs) awaited one after
 * another inside the same block:
 *
 *   const a = await fetchUser(id);      // round trip #1 — 40ms
 *   const b = await fetchOrders(other); // round trip #2 — 40ms, waits for #1
 *
 * Nothing in the second call reads a value the first produced, yet the `await`
 * serializes them: the second request cannot even leave the process until the
 * first response has landed. Total latency is the *sum*. Wrapping them —
 * `const [a, b] = await Promise.all([fetchUser(id), fetchOrders(other)])` —
 * overlaps the round trips, and the total collapses to the *max*. This is the
 * high-value core of "identify awaits that are independent and could run in
 * parallel".
 *
 * WHY IT FIRES (the precise, high-confidence slice):
 *  - within a single BlockStatement statement list (never across blocks — control
 *    flow between blocks may intend the ordering),
 *  - a maximal run of ≥2 adjacent statements, each either
 *      `(const|let) X = await <call>(...)`  or  `await <call>(...)` (discarded),
 *  - where every awaited call is a provable NETWORK READ (a GET): bare
 *    `fetch`/`got`/`ky`/`$fetch`/`request`/`superagent`/`axios(url)`, or a
 *    `.get`/`.head` verb on `axios`/`got`/`ky`/`http`/`https`/`superagent`. DB is
 *    DELIBERATELY excluded — parallelizing two DB queries is safe on a pool but a
 *    bug on a single connection / inside a transaction, and those are
 *    indistinguishable from a receiver name, so DB advice is not reliably safe. A
 *    write (`.post`, `{ method: "POST" }`, a variable options object) is never a
 *    read and stays silent, and
 *  - the run is INDEPENDENT: no await in the run references a binding introduced by
 *    an EARLIER await in that same run. The moment a later await reads an
 *    earlier-bound name the ordering is *load-bearing*, so that await closes the
 *    current run (and opens a fresh one of its own).
 *
 * DELIBERATE SILENCE (precision-first — a false positive is a release blocker):
 *  - the second await reads a value the first bound (dependent — the entire reason
 *    to sequence). Detected structurally: any identifier reference (callee or
 *    arguments, property keys excluded) that matches an earlier-bound name.
 *  - any await that is NOT a provable network GET — a write, a DB call, a local async computation, a
 *    lock, a `sleep`, an in-memory cache `.get` — serializing those is intentional,
 *    and such a statement also *separates* the surrounding awaits (breaks the run).
 *  - a single await; awaits already wrapped in `Promise.all` / `allSettled` (that
 *    call is not itself a network read, so it never qualifies).
 *  - any non-await statement between two awaits (an `if`, a loop, a `try`, a bare
 *    call): control flow / a side effect may create an ordering, so it breaks the
 *    run.
 *  - a write-after-read (`const u = await fetchUser(); await db.save(u)`): the write
 *    reads the read's result, so it is dependent and never joins the run.
 *  - destructuring / non-identifier bindings, `var`, multi-declarator statements,
 *    and awaits that are not the *direct* init of the declarator — all treated as
 *    non-qualifying (they break the run) rather than risk mis-tracking the bound
 *    names. We would rather miss than mis-fire.
 *
 * The finding anchors on the SECOND statement of the run — the first `await` that
 * needlessly serializes — and reports the run size.
 */

// READ-ONLY, by design. Parallelizing two READ round trips is always safe — it can
// only change *when* they run, never the result. Parallelizing two WRITES is not:
// independent-looking writes routinely carry an implicit ordering (create the parent
// before the child, write the record before its audit log), share a transaction or
// connection that cannot run two statements at once, or change partial-failure
// semantics. So suggesting `Promise.all` for writes is unsafe advice — a false
// positive for a precision-first tool — and this rule fires ONLY on reads.

/** HTTP verb methods that are READS (safe to parallelize). */
const HTTP_READ_VERBS = new Set(["get", "head"]);
/** HTTP verb methods that MUTATE — never suggest parallelizing these. */
const HTTP_WRITE_VERBS = new Set(["post", "put", "patch", "delete", "del"]);

// `fetch`/`$fetch` take the URL as the FIRST argument (always a URL, never a config)
// and options SECOND. `got`/`ky`/`axios` can be called with a config object FIRST, so
// a bare variable first argument there is ambiguous (it could carry `method: "POST"`).
const FETCH_LIKE = new Set(["fetch", "$fetch"]);
const CLIENT_LIKE = new Set(["got", "ky", "axios"]);
/** Bare-identifier callees that are themselves a network request (GET by default). */
const NETWORK_BARE = new Set([...FETCH_LIKE, ...CLIENT_LIKE]);

/** Roots whose HTTP-verb methods (`axios.get`, `http.get`, …) are network calls. */
const NETWORK_ROOTS = new Set(["axios", "got", "ky", "superagent", "http", "https"]);

/** Does this options object carry a non-GET/HEAD `method` (a write, or a dynamic verb)? */
const objHasNonGetMethod = (obj: AstNode): boolean => {
  for (const prop of (obj.properties as AstNode[] | undefined) ?? []) {
    if (prop.type !== "Property" || prop.computed) continue;
    const key = prop.key as AstNode | undefined;
    const keyName = key?.type === "Identifier" ? key.name : key?.type === "Literal" ? key.value : null;
    if (typeof keyName !== "string" || keyName.toLowerCase() !== "method") continue;
    const v = prop.value as AstNode | undefined;
    if (v?.type === "Literal" && typeof v.value === "string") {
      const verb = v.value.toUpperCase();
      return verb !== "GET" && verb !== "HEAD";
    }
    return true; // a dynamic method — cannot prove GET, treat as possible write
  }
  return false;
};

/**
 * Is this bare network call a provable GET? Any inline options object with a
 * non-GET method disqualifies it. For `fetch`/`$fetch` the URL is the first arg
 * (any value) and the options are second (a NON-object second arg is an
 * unreadable options → silent). For `got`/`ky`/`axios` a bare variable first arg
 * could be a POST config, so only a string/template URL or an inline object first
 * arg qualifies.
 */
const isBareGet = (call: AstNode, name: string): boolean => {
  const args = (call.arguments as AstNode[] | undefined) ?? [];
  for (const a of args) if (a?.type === "ObjectExpression" && objHasNonGetMethod(a)) return false;
  const isUrlLiteral = (a: AstNode | undefined): boolean =>
    !!a && ((a.type === "Literal" && typeof a.value === "string") || a.type === "TemplateLiteral");
  if (FETCH_LIKE.has(name)) {
    const opts = args[1];
    return opts === undefined || opts.type === "ObjectExpression";
  }
  // CLIENT_LIKE — first arg must be a provable URL or an inline options object.
  const a0 = args[0];
  if (!isUrlLiteral(a0) && a0?.type !== "ObjectExpression") return false;
  const opts = args[1];
  return opts === undefined || opts.type === "ObjectExpression";
};

/**
 * Does this CallExpression cross a NETWORK boundary as a provable READ (GET/HEAD)?
 *
 * DB is deliberately NOT covered: parallelizing two DB queries is only safe on a
 * connection *pool* (which hands each query its own connection), and is a BUG on a
 * single connection or inside an interactive transaction (one connection cannot run
 * two statements at once). Those cannot be told apart from a receiver name
 * (`client`/`conn`/`db`/`tx` all appear in both), so advising `Promise.all` for a DB
 * read is not reliably safe — and unsafe advice is a false positive. HTTP GETs have
 * no such shared-connection hazard, so only network reads are flagged.
 */
const isNetworkReadCall = (call: AstNode): boolean => {
  const callee = unwrapChain(call.callee);
  // Bare `fetch(url)` / `got(url)` / `axios(url)` — a read only if provably a GET.
  if (callee && callee.type === "Identifier" && NETWORK_BARE.has(callee.name)) {
    return isBareGet(call, callee.name);
  }
  // `axios.get(...)` / `got.head(...)` / `http.get(...)` — the verb IS the method.
  const method = getMethodName(call);
  if (method && HTTP_READ_VERBS.has(method) && !HTTP_WRITE_VERBS.has(method)) {
    const root = rootObjectName(call);
    if (root && NETWORK_ROOTS.has(root)) return true;
  }
  return false;
};

/** The direct CallExpression an `await` awaits, unwrapping optional chaining, else null. */
const awaitedCallExpression = (awaitExpr: AstNode | null): AstNode | null => {
  if (!awaitExpr) return null;
  const arg = unwrapChain(awaitExpr.argument);
  return arg && arg.type === "CallExpression" ? arg : null;
};

/** Is this Identifier a non-computed property *name* (not a value reference)? */
const isPropertyKey = (n: AstNode): boolean => {
  const p = n.parent;
  if (p?.type === "MemberExpression" && !p.computed && p.property === n) return true;
  // A shorthand `{ x }` stores key and value as distinct nodes; only the key node
  // is excluded here, so the value node still counts as a real reference.
  if (p?.type === "Property" && !p.computed && p.key === n && p.value !== n) return true;
  return false;
};

/** Identifier names referenced by the awaited call (callee + arguments), keys excluded. */
const referencedNames = (call: AstNode): Set<string> => {
  const out = new Set<string>();
  const idents = collectDescendants(call, (n) => n.type === "Identifier", undefined, true);
  for (const id of idents) {
    if (isPropertyKey(id)) continue;
    out.add(id.name as string);
  }
  return out;
};

interface AwaitInfo {
  stmt: AstNode;
  boundName: string | null;
  refs: Set<string>;
}

/**
 * Classify a block statement as a qualifying network-read await (returning the info
 * needed to run the independence check) or `null` — anything else is a separator
 * that breaks the run.
 */
const classifyAwaitStatement = (stmt: AstNode): AwaitInfo | null => {
  let awaitExpr: AstNode | null = null;
  let boundName: string | null = null;

  if (stmt.type === "VariableDeclaration") {
    if (stmt.kind !== "const" && stmt.kind !== "let") return null;
    const decls = stmt.declarations as AstNode[];
    if (!Array.isArray(decls) || decls.length !== 1) return null;
    const decl = decls[0];
    if (!decl || decl.id?.type !== "Identifier") return null;
    if (!decl.init || decl.init.type !== "AwaitExpression") return null;
    awaitExpr = decl.init;
    boundName = decl.id.name as string;
  } else if (stmt.type === "ExpressionStatement") {
    const expr = stmt.expression as AstNode;
    if (!expr || expr.type !== "AwaitExpression") return null;
    awaitExpr = expr;
  } else {
    return null;
  }

  const call = awaitedCallExpression(awaitExpr);
  if (!call || !isNetworkReadCall(call)) return null;
  return { stmt, boundName, refs: referencedNames(call) };
};

export const noSequentialIndependentAwaits = defineDiagnostic({
  id: "no-sequential-independent-awaits",
  title: "Sequential independent network reads (parallelizable)",
  severity: "warn",
  category: "Performance",
  scope: "file",
  confidence: "high",
  tags: ["performance", "async"],
  defaultEnabled: false,
  recommendation:
    "Fire the independent round trips together and await them once: `const [a, b] = await Promise.all([fetchA(), fetchB()])`. The serial cost is the sum of the latencies; the parallel cost is the max.",
  create: (ctx) => {
    const check = (block: AstNode): void => {
      const body = block.body as AstNode[];
      if (!Array.isArray(body) || body.length < 2) return;

      let run: AwaitInfo[] = [];
      const bound = new Set<string>();

      const flush = (): void => {
        if (run.length >= 2) {
          ctx.report(
            run[1]!.stmt,
            `these ${run.length} awaited network reads (GET) are independent and run serially — wrap them in \`Promise.all([...])\` to overlap the round trips and cut latency. The serial cost is the sum of the latencies; the parallel cost is the max.`,
          );
        }
        run = [];
        bound.clear();
      };

      for (const stmt of body) {
        const info = classifyAwaitStatement(stmt);
        if (!info) {
          // A non-network-read await or any other statement separates the awaits.
          flush();
          continue;
        }
        // Reads a name an earlier await in this run bound → the ordering is
        // load-bearing. Close the current run; this await starts a fresh one.
        let dependent = false;
        for (const ref of info.refs) {
          if (bound.has(ref)) {
            dependent = true;
            break;
          }
        }
        if (dependent) flush();
        run.push(info);
        if (info.boundName) bound.add(info.boundName);
      }
      flush();
    };

    return { BlockStatement: check };
  },
});
