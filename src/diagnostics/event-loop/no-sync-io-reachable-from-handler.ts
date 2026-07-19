import { defineDiagnostic } from "../../core/types.ts";

/**
 * A blocking synchronous call (`*Sync`) inside a **helper reachable from a
 * request handler** — the cross-file version of `no-sync-io-in-request-path`.
 *
 * Real code rarely blocks *inside* the handler; it blocks three modules away:
 * `handler → userService.load() → cache.warm() → readFileSync`. The intra-file
 * diagnostic sees none of that. This project-scope diagnostic follows the call graph from
 * every request handler and flags a `*Sync` sink in any helper it reaches — while
 * staying silent on a helper only ever called from non-handler code (a boot
 * loader, a CLI).
 *
 * ❌ routes.js: app.get("/r", (req,res) => warm(res));   // warm() is in cache.js
 *    cache.js:  export function warm(res){ res.send(fs.readFileSync("x")); }
 * ✅ boot.js:   bootOnly();  // only called at module scope → its readFileSync is fine
 */
export const noSyncIoReachableFromHandler = defineDiagnostic({
  id: "no-sync-io-reachable-from-handler",
  title: "Blocking synchronous I/O reachable from a request handler",
  severity: "error",
  category: "Performance",
  scope: "project",
  tags: ["event-loop", "fs", "performance"],
  recommendation:
    "Make the helper async and have the handler await it (`await fs.promises.readFile(...)`, `await execFile(...)`). A synchronous call in a helper on the request path blocks the event loop exactly as one written inline does.",
  create: (ctx) => ({
    Program: () => {
      if (!ctx.graph) return;
      const sites = ctx.graph.reachableSyncIoSites().filter((s) => s.filePath === ctx.filePath);
      for (const s of sites) {
        ctx.report(
          s.node,
          `\`${s.method}\` runs synchronously in a helper reachable from a request handler — it blocks the event loop for every concurrent request, just as sync I/O written inside the handler would.`,
        );
      }
    },
  }),
});
