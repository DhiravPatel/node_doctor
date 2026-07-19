/**
 * Self-contained HTML report (`--html-out`). One file, inline CSS, no external
 * requests — open it anywhere or attach it to a PR. Shares the landing site's
 * dark aesthetic and status colors.
 */

import type { Category, Finding } from "../core/types.ts";
import { CATEGORIES } from "../core/types.ts";
import type { ScanReport } from "../core/scan.ts";

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const CATEGORY_COLORS: Record<Category, string> = {
  Security: "#3987e5",
  Reliability: "#008300",
  Bugs: "#d55181",
  Performance: "#c98500",
  Maintainability: "#199e70",
};

const statusColor = (score: number): string =>
  score >= 75 ? "#0ca30c" : score >= 50 ? "#fab219" : "#d03b3b";

const groupBy = <T, K>(items: T[], key: (t: T) => K): Map<K, T[]> => {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    (m.get(k) ?? m.set(k, []).get(k)!).push(it);
  }
  return m;
};

/** Render a scan report as a standalone HTML document. */
export const toHtml = (report: ScanReport, opts: { version?: string } = {}): string => {
  const { project, findings, score } = report;
  const errors = findings.filter((d) => d.severity === "error").length;
  const warnings = findings.length - errors;
  const color = statusColor(score.score);

  const byCategory = groupBy(findings, (d) => d.category);
  const orderedCats = [...byCategory.keys()].sort((a, b) => {
    const diff = byCategory.get(b)!.length - byCategory.get(a)!.length;
    return diff !== 0 ? diff : CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b);
  });

  const findingHtml = (diagnostic: string, diags: Finding[]): string => {
    const first = diags[0]!;
    const sites = diags
      .map((d) => `<div class="site">${esc(d.normalizedFilePath)}:${d.line}:${d.column}</div>`)
      .join("");
    return `<div class="finding sev-${first.severity}">
      <div class="finding-head"><span class="glyph">${first.severity === "error" ? "✖" : "⚠"}</span>
        <span class="ftitle">${esc(first.title)}</span><span class="fcount">${diags.length} site${diags.length === 1 ? "" : "s"}</span></div>
      <div class="fmsg">${esc(first.message)}</div>
      <div class="sites">${sites}</div>
      <div class="frec">→ ${esc(first.recommendation)}</div>
      <div class="fid">node-doctor/${esc(diagnostic)}</div>
    </div>`;
  };

  const categoryHtml = orderedCats
    .map((cat) => {
      const catDiags = byCategory.get(cat)!;
      const byRule = groupBy(catDiags, (d) => d.diagnostic);
      const rulesHtml = [...byRule.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([diagnostic, ds]) => findingHtml(diagnostic, ds))
        .join("");
      return `<section class="cat"><h2><span class="dot" style="background:${CATEGORY_COLORS[cat]}"></span>${cat} <span class="n">${catDiags.length}</span></h2>${rulesHtml}</section>`;
    })
    .join("");

  const findingsSection =
    findings.length === 0
      ? `<div class="clean">✓ No findings.</div>`
      : categoryHtml;

  const barPct = Math.max(0, Math.min(100, score.score));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>node.doctor report — ${esc(project.name)}</title>
<style>
:root{--bg:#0b0c0e;--s1:#121316;--s2:#17191d;--ink:#f4f5f6;--ink2:#b7bcc4;--ink3:#82888f;--line:rgba(255,255,255,.09)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:40px 24px 80px}
.mono{font-family:ui-monospace,"SF Mono",Menlo,monospace}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}.brand b{color:#3fb950}
.meta{color:var(--ink3);font-size:13px;font-family:ui-monospace,monospace;margin-bottom:24px}
.scorebox{display:flex;align-items:center;gap:22px;background:var(--s1);border:1px solid var(--line);border-radius:14px;padding:24px;margin-bottom:28px}
.score{font-size:44px;font-weight:800;color:${color}}.score small{font-size:16px;color:var(--ink3);font-weight:500}
.label{display:inline-block;font-family:ui-monospace,monospace;font-size:12px;padding:3px 10px;border-radius:999px;background:${color}22;color:${color};font-weight:700}
.bar{height:10px;background:#1d2025;border-radius:5px;overflow:hidden;flex:1}.bar>i{display:block;height:100%;width:${barPct}%;background:${color}}
.counts{margin-top:10px;font-family:ui-monospace,monospace;font-size:13px;color:var(--ink2)}
.cat{margin:28px 0}.cat h2{font-size:17px;display:flex;align-items:center;gap:8px;border-top:1px solid var(--line);padding-top:20px}
.cat h2 .n{color:var(--ink3);font-weight:500;font-size:14px}.dot{width:11px;height:11px;border-radius:3px;display:inline-block}
.finding{background:var(--s1);border:1px solid var(--line);border-left:3px solid var(--ink3);border-radius:10px;padding:16px;margin:12px 0}
.finding.sev-error{border-left-color:#d03b3b}.finding.sev-warn{border-left-color:#fab219}
.finding-head{display:flex;align-items:baseline;gap:8px}.glyph{color:#d03b3b}.sev-warn .glyph{color:#fab219}
.ftitle{font-weight:600}.fcount{color:var(--ink3);font-size:12px;font-family:ui-monospace,monospace;margin-left:auto}
.fmsg{color:var(--ink2);font-size:14px;margin:8px 0}.sites{font-family:ui-monospace,monospace;font-size:12.5px;color:#3987e5;margin:8px 0}.site{margin:1px 0}
.frec{color:var(--ink3);font-size:13px;margin-top:8px}.fid{color:var(--ink3);font-family:ui-monospace,monospace;font-size:11.5px;margin-top:6px}
.clean{color:#0ca30c;font-size:18px;padding:30px;text-align:center}
footer{margin-top:40px;color:var(--ink3);font-size:12px;font-family:ui-monospace,monospace;border-top:1px solid var(--line);padding-top:20px}
</style></head><body><div class="wrap">
<h1 class="brand">node<b>.</b>doctor <span class="mono" style="color:var(--ink3);font-size:13px;font-weight:400">${esc(opts.version ? "v" + opts.version : "")}</span></h1>
<div class="meta">${esc(project.name)} · ${project.analyzedFileCount} files · ${project.totalLines.toLocaleString("en-US")} lines · ${report.diagnosticsRun}/${report.diagnosticsAvailable} diagnostics${project.capabilities.filter((c) => c !== "node").length ? " · " + esc(project.capabilities.filter((c) => c !== "node").join(" ")) : ""}</div>
<div class="scorebox">
  <div class="score">${score.score}<small>/100</small></div>
  <div style="flex:1">
    <div class="bar"><i></i></div>
    <div class="counts"><span class="label">${score.label}</span> &nbsp; ${errors} errors · ${warnings} warnings · ${score.perThousandLines} weighted/kLOC</div>
  </div>
</div>
${project.complete ? "" : `<div class="meta" style="color:#fab219">⚠ ${project.parseFailures.length} file(s) failed to parse — results are incomplete, not "clean".</div>`}
${findingsSection}
<footer>Generated by node.doctor — deterministic, offline static analysis. No telemetry.</footer>
</div></body></html>`;
};
