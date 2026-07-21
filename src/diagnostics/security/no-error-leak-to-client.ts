import { defineDiagnostic } from "../../core/types.ts";
import type { AstNode } from "../../core/types.ts";
import { getMethodName, rootObjectName, isFunctionLike } from "../../core/ast.ts";
import { collectDescendants, findDescendant } from "../../core/walk.ts";

/**
 * Sending a caught error's stack trace — or the raw error object — back in the
 * HTTP response. Stack traces leak absolute paths, dependency versions, and
 * internal structure that help an attacker, and the raw error can carry
 * driver-level details (SQL, connection strings).
 *
 * ❌ } catch (err) { res.status(500).send(err.stack); }
 * ❌ } catch (e) { res.json({ error: e }); }
 * ✅ } catch (err) { logger.error(err); res.status(500).json({ error: "Internal error" }); }
 */

const RESPONSE_SINKS = new Set(["send", "json", "jsonp", "end", "write"]);
const RESPONSE_RECEIVERS = new Set(["res", "response", "reply"]);

export const noErrorLeakToClient = defineDiagnostic({
  id: "no-error-leak-to-client",
  title: "Error stack or raw error sent to the client",
  severity: "error",
  category: "Security",
  tags: ["error-handling", "info-leak"],
  recommendation:
    "Log the error server-side and return a generic message (`res.status(500).json({ error: 'Internal error' })`). Never send `err.stack` or the raw error object — they leak paths, versions, and internal details.",
  create: (ctx) => {
    // Names bound as caught errors: `catch (err) { … }`.
    const errorNames = new Set<string>();

    const isRawError = (n: AstNode): boolean => n.type === "Identifier" && errorNames.has(n.name);
    const isErrorStack = (n: AstNode): boolean =>
      n.type === "MemberExpression" &&
      !n.computed &&
      n.property?.type === "Identifier" &&
      n.property.name === "stack" &&
      n.object?.type === "Identifier" &&
      errorNames.has(n.object.name);

    /** Does this argument expression carry a caught error's stack, or the error itself? */
    const leaksError = (arg: AstNode): boolean => {
      // The argument node itself (findDescendant does not test the root).
      if (isRawError(arg) || isErrorStack(arg)) return true;
      // Nested only flags `err.stack` (e.g. `{ error: err.stack }`) — not a raw
      // `err` or `err.message`, which serialize harmlessly / aren't sensitive.
      return findDescendant(arg, isErrorStack, isFunctionLike) !== null;
    };

    return {
      Program: (root) => {
        for (const clause of collectDescendants(root, (n) => n.type === "CatchClause")) {
          const param = clause.param as AstNode | undefined;
          if (param?.type === "Identifier") errorNames.add(param.name);
        }
      },
      CallExpression: (node) => {
        if (errorNames.size === 0) return;
        const method = getMethodName(node);
        if (!method || !RESPONSE_SINKS.has(method)) return;
        const receiver = rootObjectName(node.callee);
        if (!receiver || !RESPONSE_RECEIVERS.has(receiver.toLowerCase())) return;

        for (const arg of (node.arguments as AstNode[] | undefined) ?? []) {
          if (leaksError(arg)) {
            ctx.report(arg, "A caught error's stack (or the raw error) is sent to the client — this leaks internal paths and details.");
            return;
          }
        }
      },
    };
  },
});
