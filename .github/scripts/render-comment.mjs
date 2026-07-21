#!/usr/bin/env node
/**
 * Render a node.doctor baseline-delta as Markdown, write it to the job summary,
 * and upsert a single PR comment (found/replaced by a hidden marker). Self-
 * contained: only Node built-ins + global fetch. Never fails the build.
 *
 *   node render-comment.mjs <delta.json> [current.json]
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GITHUB_API_URL,
 *      GITHUB_STEP_SUMMARY.
 */

import { readFileSync, appendFileSync } from "node:fs";

const MARKER = "<!-- node-doctor:summary -->";
const SEVERITY_ICON = { error: "🔴", warn: "🟡" };
const scoreEmoji = (s) => (s >= 75 ? "🟢" : s >= 50 ? "🟡" : "🔴");
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ").trim();

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const rows = (findings, limit = 50) => {
  const body = findings
    .slice(0, limit)
    .map((f) => `| ${SEVERITY_ICON[f.severity] ?? ""} ${f.severity} | \`${f.diagnostic}\` | \`${cell(f.normalizedFilePath)}:${f.line}\` | ${cell(f.message)} |`)
    .join("\n");
  const more = findings.length > limit ? `\n\n…and ${findings.length - limit} more.` : "";
  return `| Severity | Diagnostic | Location | Message |\n| --- | --- | --- | --- |\n${body}${more}`;
};

const render = (delta, score) => {
  const { introduced = [], resolved = [] } = delta ?? {};
  const lines = [MARKER, "## node.doctor", ""];
  if (score) lines.push(`Health score: **${scoreEmoji(score.score)} ${score.score}/100** (${score.label})`, "");
  if (introduced.length === 0) {
    lines.push("✅ **No new findings introduced by this change.**");
  } else {
    const errs = introduced.filter((f) => f.severity === "error").length;
    lines.push(`### ⚠️ ${introduced.length} new finding(s) introduced — ${errs} error(s), ${introduced.length - errs} warning(s)`, "");
    lines.push(rows(introduced));
  }
  if (resolved.length > 0) lines.push("", `✅ ${resolved.length} finding(s) resolved by this change.`);
  lines.push("", "<sub>Reports only findings this change introduced (evidence-based baseline delta).</sub>");
  return lines.join("\n");
};

const main = async () => {
  const delta = readJson(process.argv[2] ?? "");
  const current = readJson(process.argv[3] ?? "");
  const score = current?.score ? { score: current.score.score, label: current.score.label } : null;
  const markdown = render(delta, score);

  // 1. Job summary (always).
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
    } catch {
      /* non-fatal */
    }
  }

  // 2. PR comment (only when we have a token + a PR number).
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const event = process.env.GITHUB_EVENT_PATH ? readJson(process.env.GITHUB_EVENT_PATH) : null;
  const prNumber = event?.pull_request?.number ?? event?.number;
  if (!token || !repo || !prNumber) {
    console.log("node.doctor: no PR context — wrote job summary only.");
    return;
  }

  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" };
  const base = `${api}/repos/${repo}/issues/${prNumber}/comments`;
  try {
    const list = await fetch(`${base}?per_page=100`, { headers }).then((r) => (r.ok ? r.json() : []));
    const existing = Array.isArray(list) ? list.find((c) => typeof c.body === "string" && c.body.includes(MARKER)) : null;
    const target = existing ? `${api}/repos/${repo}/issues/comments/${existing.id}` : base;
    const res = await fetch(target, { method: existing ? "PATCH" : "POST", headers, body: JSON.stringify({ body: markdown }) });
    console.log(`node.doctor: ${existing ? "updated" : "created"} PR comment (${res.status}).`);
  } catch (err) {
    console.log(`node.doctor: could not post PR comment — ${err?.message ?? err}`);
  }
};

main();
