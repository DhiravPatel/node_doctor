import pc from "picocolors";
import type { DeslopResult } from "../deslop/index.ts";

const identity = (s: string): string => s;

/** Render a deslop result for the terminal. */
export const renderDeslop = (result: DeslopResult, opts: { color?: boolean } = {}): string => {
  const color = opts.color ?? true;
  const dim = color ? pc.dim : identity;
  const bold = color ? pc.bold : identity;
  const yellow = color ? pc.yellow : identity;
  const green = color ? pc.green : identity;
  const cyan = color ? pc.cyan : identity;

  const red = color ? pc.red : identity;
  const total =
    result.unusedFiles.length +
    result.unusedExports.length +
    result.unusedDependencies.length +
    result.undeclaredDependencies.length;
  const lines: string[] = ["", `  ${bold("node-deslop")}  ${dim(`${result.scannedFiles} files scanned`)}`, ""];

  if (total === 0) {
    lines.push(green("  ✓ No unused files/exports/deps, and no undeclared imports."));
    lines.push("");
    return lines.join("\n");
  }

  if (result.unusedFiles.length > 0) {
    lines.push(`  ${yellow("Unused files")} ${dim(`(${result.unusedFiles.length})`)}`);
    for (const f of result.unusedFiles) lines.push(cyan(`     ${f}`));
    lines.push("");
  }
  if (result.unusedExports.length > 0) {
    lines.push(`  ${yellow("Unused exports")} ${dim(`(${result.unusedExports.length})`)}`);
    for (const e of result.unusedExports) lines.push(`     ${cyan(e.file)} ${dim("→")} ${e.name}`);
    lines.push("");
  }
  if (result.unusedDependencies.length > 0) {
    lines.push(`  ${yellow("Unused dependencies")} ${dim(`(${result.unusedDependencies.length})`)}`);
    for (const d of result.unusedDependencies) lines.push(`     ${d}`);
    lines.push("");
  }
  if (result.undeclaredDependencies.length > 0) {
    lines.push(`  ${red("Undeclared dependencies")} ${dim(`(${result.undeclaredDependencies.length}) — imported but not in package.json`)}`);
    for (const d of result.undeclaredDependencies) lines.push(`     ${d}`);
    lines.push(dim("     These resolve today only via a hoisted transitive dep; a clean/--production"));
    lines.push(dim("     install or a tree change will break them. Add them to dependencies."));
    lines.push("");
  }

  lines.push(dim("  Dead-code detection is heuristic — treat these as candidates to review, not"));
  lines.push(dim("  automatic deletions. A dep used only via config/CLI, or an export that is your"));
  lines.push(dim("  public API, may show up here."));
  lines.push("");
  return lines.join("\n");
};
