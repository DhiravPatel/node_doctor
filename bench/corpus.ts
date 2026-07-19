/**
 * Corpus / benchmark harness.
 *
 * "Zero false positives on our fixtures" is weak evidence. This scans a set of
 * real directories, reports timing and weighted-finding density per repo, and
 * writes a JSON summary you can triage. It does NOT decide truth — a human
 * triages the sampled findings to compute the real false-positive rate.
 *
 *   node bench/corpus.ts <dir> [<dir> ...]
 *   node bench/corpus.ts --sample 20 ~/code/*        # print up to 20 findings/repo
 *
 * Point it at the top ~200 Node repos (cloned locally) to measure the actual FP
 * rate, as §18 requires.
 */

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { scanProject } from "../src/core/scan.ts";

interface Row {
  dir: string;
  files: number;
  lines: number;
  findings: number;
  perKloc: number;
  score: number;
  ms: number;
  complete: boolean;
}

const parseArgs = (argv: string[]): { dirs: string[]; sample: number } => {
  const dirs: string[] = [];
  let sample = 0;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sample") {
      sample = Number(argv[++i]) || 10;
    } else {
      dirs.push(argv[i]!);
    }
  }
  return { dirs, sample };
};

const hrms = (): number => Number(process.hrtime.bigint() / 1_000_000n);

const main = async (): Promise<number> => {
  const { dirs, sample } = parseArgs(process.argv.slice(2));
  if (dirs.length === 0) {
    process.stderr.write("usage: node bench/corpus.ts [--sample N] <dir> [<dir> ...]\n");
    return 2;
  }

  const rows: Row[] = [];
  for (const raw of dirs) {
    const dir = resolve(raw);
    // Skip non-directories quietly.
    try {
      await readdir(dir);
    } catch {
      continue;
    }
    const start = hrms();
    const report = await scanProject({ rootDirectory: dir });
    const ms = hrms() - start;
    rows.push({
      dir,
      files: report.project.analyzedFileCount,
      lines: report.project.totalLines,
      findings: report.findings.length,
      perKloc: report.score.perThousandLines,
      score: report.score.score,
      ms,
      complete: report.project.complete,
    });

    if (sample > 0) {
      process.stdout.write(`\n${dir}\n`);
      for (const d of report.findings.slice(0, sample)) {
        process.stdout.write(`  ${d.severity === "error" ? "✖" : "⚠"} ${d.normalizedFilePath}:${d.line} ${d.diagnostic} — ${d.message}\n`);
      }
    }
  }

  // Summary table.
  const totalFiles = rows.reduce((a, r) => a + r.files, 0);
  const totalLines = rows.reduce((a, r) => a + r.lines, 0);
  const totalFindings = rows.reduce((a, r) => a + r.findings, 0);
  const totalMs = rows.reduce((a, r) => a + r.ms, 0);

  process.stdout.write("\n=== corpus summary ===\n");
  for (const r of rows.sort((a, b) => b.perKloc - a.perKloc)) {
    process.stdout.write(
      `${r.perKloc.toFixed(1).padStart(7)} w/kLOC  ${String(r.findings).padStart(5)} findings  ${String(r.files).padStart(5)} files  ${String(r.ms).padStart(6)}ms  ${r.complete ? " " : "!"} ${r.dir}\n`,
    );
  }
  process.stdout.write(
    `\nrepos: ${rows.length}  files: ${totalFiles}  lines: ${totalLines}  findings: ${totalFindings}  total: ${totalMs}ms\n`,
  );
  process.stdout.write(
    `Triage the sampled findings by hand to compute the true false-positive rate.\n`,
  );
  return 0;
};

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`bench: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(2);
  },
);
