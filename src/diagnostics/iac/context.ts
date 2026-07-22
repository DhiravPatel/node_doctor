/**
 * Shared context helpers for the IaC diagnostics.
 *
 * Infrastructure files are the one place where a single line is the whole
 * breach: an ACL, an ingress CIDR, an IAM wildcard. But the same *token* is
 * benign or catastrophic depending on the block it sits in — `0.0.0.0/0` is a
 * disaster on ingress and completely normal on egress. These helpers give each
 * diagnostic that block context, and gate YAML/JSON so we never fire on the
 * ordinary config and CI files that happen to share a file extension.
 */

/** Terraform/HCL and Terraform-vars files are unambiguously IaC by extension. */
const HCL_EXT_RE = /\.(tf|tfvars)$/i;

/**
 * A YAML/JSON file is only IaC if it says so. Without this gate the diagnostics
 * fire on docker-compose, GitHub workflows, tsconfig — anything with a matching
 * word — which would make them unusable.
 */
const CFN_MARKER_RE = /(AWSTemplateFormatVersion|Type:\s*['"]?AWS::|"Type"\s*:\s*"AWS::|Resources:\s*$|"Resources"\s*:)/m;

/** Does this file actually describe infrastructure? */
export const isIacFile = (normalizedFilePath: string, content: string): boolean => {
  if (HCL_EXT_RE.test(normalizedFilePath)) return true;
  return CFN_MARKER_RE.test(content);
};

/** Strip an HCL/YAML line comment so a commented-out example never fires. */
export const stripComment = (line: string): string => {
  // Only strip when the marker is not inside quotes (cheap, adequate for IaC).
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (c === "#") return line.slice(0, i);
      if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
    }
  }
  return line;
};

/**
 * The innermost named block a line sits in, for HCL (`ingress { … }`) and for
 * YAML list/section headers (`SecurityGroupIngress:`). Returns the lower-cased
 * block names from outermost to innermost.
 *
 * HCL uses brace depth; YAML uses indentation. Both are handled because a
 * CloudFormation template and a Terraform file express the same rule.
 */
export const blockStackAt = (lines: string[], index: number): string[] => {
  const hcl: Array<{ name: string; depth: number }> = [];
  let depth = 0;
  // YAML: remember the most recent section header at each indent level.
  const yaml: Array<{ name: string; indent: number }> = [];

  for (let i = 0; i <= index; i++) {
    const raw = lines[i] ?? "";
    const line = stripComment(raw);
    if (line.trim().length === 0) continue;

    // --- HCL braces ---
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (opens > 0) {
      // `ingress {`, `resource "aws_s3_bucket" "b" {`, `statement {`
      const m = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\b/.exec(line);
      if (m) hcl.push({ name: m[1]!.toLowerCase(), depth });
      depth += opens;
    }
    if (closes > 0) {
      depth -= closes;
      while (hcl.length > 0 && hcl[hcl.length - 1]!.depth >= depth) hcl.pop();
    }

    // --- YAML sections ---
    const ym = /^(\s*)-?\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*$/.exec(line);
    if (ym) {
      const indent = ym[1]!.length;
      while (yaml.length > 0 && yaml[yaml.length - 1]!.indent >= indent) yaml.pop();
      yaml.push({ name: ym[2]!.toLowerCase(), indent });
    } else {
      const contentIndent = line.length - line.trimStart().length;
      while (yaml.length > 0 && yaml[yaml.length - 1]!.indent >= contentIndent) {
        // A non-section line at or left of the header closes it.
        if (yaml[yaml.length - 1]!.indent >= contentIndent) yaml.pop();
        else break;
      }
    }
  }

  return [...hcl.map((b) => b.name), ...yaml.map((b) => b.name)];
};

/** Is the line at `index` inside a block whose name matches `re`? */
export const insideBlock = (lines: string[], index: number, re: RegExp): boolean =>
  blockStackAt(lines, index).some((name) => re.test(name));
