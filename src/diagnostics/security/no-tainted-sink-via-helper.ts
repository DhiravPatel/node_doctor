import { defineDiagnostic } from "../../core/types.ts";

/**
 * Caller-controlled data reaching an injection sink **inside a helper**, having
 * been passed there from a request handler — possibly several modules away.
 *
 * This is the cross-file counterpart of the intra-file injection diagnostics, and
 * it is the shape real code actually takes: the handler looks clean because it
 * only forwards `req.query.name`; the repository looks clean because it just
 * interpolates "a string". Neither file is wrong on its own. The project call
 * graph carries taint across the boundary by argument position, so the sink is
 * reported with the hop trail that fed it.
 *
 * ❌ routes.js: app.get("/u", (req,res) => res.json(lookup(req.query.name)))
 *    repo.js:   export const findUser = (n) => db.query(`SELECT … = ${n}`)
 * ✅ repo.js:   export const findUser = (n) => db.query("SELECT … = $1", [n])
 */

const MESSAGE = {
  eval: "reaches `eval` in this helper — this is arbitrary code execution",
  shell: "reaches a shell command in this helper — this is command injection",
  sql: "is interpolated into a query in this helper — this is SQL injection",
} as const;

export const noTaintedSinkViaHelper = defineDiagnostic({
  id: "no-tainted-sink-via-helper",
  title: "Caller-controlled data reaches an injection sink in a helper",
  severity: "error",
  category: "Security",
  scope: "project",
  confidence: "high",
  tags: ["injection", "taint"],
  recommendation:
    "Parameterize the sink where it lives: bind SQL parameters (`db.query('… = $1', [value])`), use `execFile`/`spawn` with an argument array instead of a shell string, and never pass request data to `eval`/`Function`. Validating in the handler is not enough — the helper is the sink.",
  create: (ctx) => ({
    Program: () => {
      if (!ctx.graph) return;
      // Sites are computed on the graph's AST; Phase B re-parses each file, so we
      // filter to this file and report the node by offset (same source text).
      const sites = ctx.graph.taintedSinkSites().filter((s) => s.filePath === ctx.filePath);
      for (const site of sites) {
        const via = site.via.length > 1 ? ` (${site.via.join(" → ")})` : "";
        ctx.report(site.node, `Caller-controlled data ${MESSAGE[site.kind]}${via}.`);
      }
    },
  }),
});
