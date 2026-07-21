/**
 * Build a prefilled "report a false positive" GitHub issue URL for a finding.
 * A false positive is a bug in the diagnostic; this lowers the barrier to
 * reporting it instead of silently suppressing.
 */

import type { Finding } from "../core/types.ts";

/** Normalize a package.json `repository` field to an https GitHub base URL. */
export const normalizeRepoUrl = (raw?: string): string | undefined => {
  if (!raw) return undefined;
  let url = raw.trim();
  url = url.replace(/^git\+/, "").replace(/\.git$/, "");
  if (url.startsWith("git@github.com:")) url = `https://github.com/${url.slice("git@github.com:".length)}`;
  if (url.startsWith("git://")) url = `https://${url.slice("git://".length)}`;
  if (url.startsWith("ssh://git@")) url = `https://${url.slice("ssh://git@".length)}`;
  if (!/^https?:\/\//.test(url)) return undefined;
  return url.replace(/\/+$/, "");
};

export const buildIssueUrl = (finding: Finding, repositoryUrl?: string): string | undefined => {
  const base = normalizeRepoUrl(repositoryUrl);
  if (!base) return undefined;

  const title = `False positive: ${finding.diagnostic} at ${finding.normalizedFilePath}:${finding.line}`;
  const body = [
    `**Diagnostic:** node-doctor/${finding.diagnostic}`,
    `**Severity:** ${finding.severity}`,
    `**Category:** ${finding.category}`,
    `**Location:** ${finding.normalizedFilePath}:${finding.line}:${finding.column}`,
    "",
    `**Message:** ${finding.message}`,
    `**Recommended fix:** ${finding.recommendation}`,
    "",
    "**Why this is a false positive:**",
    "",
    "<!-- Describe why node.doctor is wrong here. Include the code if you can. -->",
  ].join("\n");

  const query = `title=${encodeURIComponent(title)}&labels=false-positive&body=${encodeURIComponent(body)}`;
  return `${base}/issues/new?${query}`;
};
