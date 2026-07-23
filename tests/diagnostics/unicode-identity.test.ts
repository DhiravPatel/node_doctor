/**
 * §148 Unicode Normalization & Homoglyph Safety:
 *   - no-unnormalized-identity-comparison (Security, OPT-IN)
 *
 * This test imports the diagnostic directly and lints with an explicit
 * diagnostic list, so it does not depend on the generated registry. The rule is
 * deliberately narrow — its whole value is silence — so the MUST-be-silent side
 * is heavier than the fires side: each silent case is a precision guard against
 * the toLowerCase/=== false-positive machine this class is prone to.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnnormalizedIdentityComparison } from "../../src/diagnostics/security/no-unnormalized-identity-comparison.ts";
import type { Diagnostic } from "../../src/core/types.ts";

const CAPS = new Set(["node", "esm", "typescript"]);

const findingsFor = (diagnostic: Diagnostic, source: string): number => {
  const { findings, parseFailed } = lintSource({
    filePath: "test.ts",
    sourceText: source,
    diagnostics: [diagnostic],
    capabilities: CAPS,
  });
  assert.ok(!parseFailed, `source failed to parse:\n${source}`);
  return findings.filter((f) => f.diagnostic === diagnostic.id).length;
};

const fires = (diagnostic: Diagnostic, source: string): void =>
  assert.ok(findingsFor(diagnostic, source) > 0, `expected ${diagnostic.id} to FIRE on:\n${source}`);

const silent = (diagnostic: Diagnostic, source: string): void =>
  assert.equal(findingsFor(diagnostic, source), 0, `expected ${diagnostic.id} to STAY SILENT on:\n${source}`);

describe("no-unnormalized-identity-comparison", () => {
  const U = noUnnormalizedIdentityComparison;

  // FIRES ------------------------------------------------------------------
  test("fires: username lowercased on both sides in an auth gate", () => {
    fires(U, `if (username.toLowerCase() === input.toLowerCase()) grant();`);
  });
  test("fires: email trimmed on one side, compared to a stored value", () => {
    fires(U, `const email = req.body.email; if (email.trim() === stored) merge();`);
  });
  test("fires: member-tail username lowercased with !==", () => {
    fires(U, `if (user.username.toLowerCase() !== other) reject();`);
  });
  test("fires: snake_case user_name lowercased", () => {
    fires(U, `if (user_name.toLowerCase() === candidate) ok();`);
  });
  test("fires: tenant slug trimmed and lowercased (chained canonicalization)", () => {
    fires(U, `if (slug.trim().toLowerCase() === stored) route();`);
  });
  test("fires: loose equality on a lowercased handle", () => {
    fires(U, `if (handle.toLowerCase() == existing) collide();`);
  });
  test("fires: identity name on one side, canonicalization on the other", () => {
    fires(U, `if (username === input.toLowerCase()) grant();`);
  });

  // MUST BE SILENT ---------------------------------------------------------
  test("silent: plain compare with no identity name and no canonicalization", () => {
    silent(U, `if (a === b) go();`);
  });
  test("silent: role literal compare — no canonicalization intent", () => {
    silent(U, `if (role === "admin") elevate();`);
  });
  test("silent: identity vs a LITERAL constant — reserved-name/allowlist check, not an identity match", () => {
    // A homoglyph twin can never equal a fixed literal, so normalization is beside
    // the point. Requires two dynamic operands.
    silent(U, `if (slug.toLowerCase() === "admin") reject();`);
    silent(U, `if (username.trim() === "root") deny();`);
  });
  test("silent: identity emptiness check against the empty-string literal", () => {
    silent(U, `if (email.trim() === "") reject();`);
  });
  test("silent: identity vs a no-substitution template literal", () => {
    silent(U, "if (slug.toLowerCase() === `admin`) reject();");
    silent(U, "if (email.trim() === ``) reject();");
  });
  test("silent: identity vs a CONSTANT_CASE enum/reserved constant", () => {
    silent(U, `if (username.toLowerCase() === Roles.ADMIN) deny();`);
    silent(U, `if (slug.trim() === RESERVED) reject();`);
  });
  test("silent: already normalized on both sides (author handled Unicode)", () => {
    silent(
      U,
      `if (username.normalize("NFKC").toLowerCase() === x.normalize("NFKC").toLowerCase()) grant();`,
    );
  });
  test("silent: numeric compare", () => {
    silent(U, `if (count === 0) reset();`);
  });
  test("silent: length compare (code-unit length is out of scope)", () => {
    silent(U, `if (name.length === 3) ok();`);
  });
  test("silent: identity name but no canonicalization (bare identity compare)", () => {
    silent(U, `if (username === input) grant();`);
  });
  test("silent: canonicalization but no identity name (generic string)", () => {
    silent(U, `if (title.toLowerCase() === query.toLowerCase()) match();`);
  });
  test("silent: non-identity member-tail lowercased (name, not identity)", () => {
    silent(U, `if (user.name.toLowerCase() === other) ok();`);
  });
  test("silent: normalized on one side only still counts as handled", () => {
    silent(U, `if (email.normalize("NFKC").trim() === stored) merge();`);
  });
  test("silent: boolean equality on a flag", () => {
    silent(U, `if (isActive === true) run();`);
  });
  test("silent: username passed as an argument, not the compared value", () => {
    silent(U, `if (lookup(username.toLowerCase()) === row) hit();`);
  });
  test("silent: relational operator, not equality", () => {
    silent(U, `if (username.toLowerCase() < other) sort();`);
  });
});
