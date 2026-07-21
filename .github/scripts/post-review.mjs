#!/usr/bin/env node
/**
 * Post node.doctor's introduced findings as inline PR review comments, mapping
 * each finding's file+line onto the PR diff so GitHub accepts it. Self-contained
 * (Node built-ins + global fetch), deduped, capped, and never fails the build.
 * Only meaningful on pull_request events.
 *
 *   node post-review.mjs <delta.json>
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GITHUB_API_URL.
 */

import { readFileSync } from "node:fs";

const MARKER = "<!-- node-doctor:review -->";
const MAX_COMMENTS = 50;

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/** Parse a unified-diff `patch` into the set of new-file line numbers it covers. */
const addedLines = (patch) => {
  const lines = new Set();
  if (typeof patch !== "string") return lines;
  let newLine = 0;
  for (const row of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (row.startsWith("-")) continue; // removed line — no new-file number
    if (row.startsWith("+") || row.startsWith(" ")) {
      // added or context line occupies a new-file line number
      if (newLine > 0) lines.add(newLine);
      newLine++;
    }
  }
  return lines;
};

const main = async () => {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const event = process.env.GITHUB_EVENT_PATH ? readJson(process.env.GITHUB_EVENT_PATH) : null;
  const prNumber = event?.pull_request?.number ?? event?.number;
  if (!token || !repo || !prNumber) {
    console.log("node.doctor: not a PR — skipping inline review.");
    return;
  }

  const introduced = readJson(process.argv[2] ?? "")?.introduced ?? [];
  if (introduced.length === 0) {
    console.log("node.doctor: no introduced findings — skipping inline review.");
    return;
  }

  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" };

  // Build a map of changed file → valid new-file line numbers.
  let files = [];
  try {
    files = await fetch(`${api}/repos/${repo}/pulls/${prNumber}/files?per_page=100`, { headers }).then((r) => (r.ok ? r.json() : []));
  } catch (err) {
    console.log(`node.doctor: could not fetch PR files — ${err?.message ?? err}`);
    return;
  }
  const diffLines = new Map();
  for (const f of Array.isArray(files) ? files : []) diffLines.set(f.filename, addedLines(f.patch));

  // Keep only findings that land on a changed line; dedupe; cap.
  const seen = new Set();
  const comments = [];
  for (const f of introduced) {
    if (comments.length >= MAX_COMMENTS) break;
    const key = `${f.normalizedFilePath}:${f.line}:${f.diagnostic}`;
    if (seen.has(key)) continue;
    const valid = diffLines.get(f.normalizedFilePath);
    if (!valid || !valid.has(f.line)) continue;
    seen.add(key);
    comments.push({
      path: f.normalizedFilePath,
      line: f.line,
      side: "RIGHT",
      body: `**node-doctor/${f.diagnostic}** (${f.severity})\n\n${f.message}\n\n_Fix:_ ${f.recommendation}`,
    });
  }

  if (comments.length === 0) {
    console.log("node.doctor: no introduced findings fall on changed lines — nothing to review.");
    return;
  }

  try {
    const res = await fetch(`${api}/repos/${repo}/pulls/${prNumber}/reviews`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        event: "COMMENT",
        body: `${MARKER}\nnode.doctor flagged ${comments.length} issue(s) introduced by this change.`,
        comments,
      }),
    });
    console.log(`node.doctor: posted ${comments.length} inline comment(s) (${res.status}).`);
  } catch (err) {
    console.log(`node.doctor: could not post review — ${err?.message ?? err}`);
  }
};

main();
