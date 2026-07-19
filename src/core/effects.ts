/**
 * Per-function effect summaries (Phase B input).
 *
 * A summary answers, for one function: does it do sync IO? spawn a shell? run a
 * query? fan out unboundedly? call `process.exit`? In Phase B these summaries
 * flow along the call graph so an effect reachable from a handler *through
 * helpers* can be flagged. The summarizer itself is intra-function and pure.
 */

import type { AstNode } from "./types.ts";
import { collectDescendants } from "./walk.ts";
import { getMethodName, getCalleeName } from "./ast.ts";
import { SYNC_IO_METHODS, SHELL_EXEC } from "./signals.ts";

export interface EffectSummary {
  syncIo: boolean;
  shell: boolean;
  processExit: boolean;
  /** Names of the sync-IO methods observed (for message sharpening). */
  syncIoCalls: string[];
}

const EMPTY: EffectSummary = { syncIo: false, shell: false, processExit: false, syncIoCalls: [] };

/**
 * Summarize the *direct* effects in a function body (including inline callbacks,
 * which run synchronously). Calls into other functions are resolved later by the
 * graph, not here.
 */
export const summarizeEffects = (fn: AstNode | null | undefined): EffectSummary => {
  if (!fn) return EMPTY;
  const body = fn.body ?? fn;
  const calls = collectDescendants(body, (n) => n.type === "CallExpression");

  const syncIoCalls: string[] = [];
  let shell = false;
  let processExit = false;

  for (const call of calls) {
    const method = getMethodName(call);
    if (method && SYNC_IO_METHODS.has(method)) {
      syncIoCalls.push(method);
    }
    if (method && SHELL_EXEC.has(method)) {
      shell = true;
    }
    const callee = getCalleeName(call);
    if (callee === "process.exit" || callee === "process.abort") {
      processExit = true;
    }
  }

  return {
    syncIo: syncIoCalls.length > 0,
    shell,
    processExit,
    syncIoCalls,
  };
};
