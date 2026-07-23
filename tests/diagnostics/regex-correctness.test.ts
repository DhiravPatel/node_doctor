/**
 * §146 validation-regex correctness:
 *   - no-unanchored-security-regex (Security)
 *   - no-stateful-global-regex-test (Bugs)
 *
 * These tests import the diagnostic modules directly and lint with an explicit
 * diagnostic list, so they do not depend on the generated registry. The
 * MUST-be-silent cases below include real-world false positives found by sweeping
 * a ~5000-file corpus (react-doctor + node_modules) — each one is a precision
 * regression guard, not a hypothetical.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noUnanchoredSecurityRegex } from "../../src/diagnostics/security/no-unanchored-security-regex.ts";
import { noStatefulGlobalRegexTest } from "../../src/diagnostics/security/no-stateful-global-regex-test.ts";
import type { Diagnostic } from "../../src/core/types.ts";

const CAPS = new Set(["node", "esm", "typescript", "express"]);

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

// ---------------------------------------------------------------------------
// no-unanchored-security-regex
// ---------------------------------------------------------------------------

describe("no-unanchored-security-regex", () => {
  const U = noUnanchoredSecurityRegex;

  test("fires: inline unanchored domain allowlist tested against a URL", () => {
    fires(U, `if (/https:\\/\\/trusted\\.com/.test(url)) redirect(url);`);
  });
  test("fires: stored const regex (binding-resolved) tested against host", () => {
    fires(U, `const OK = /internal\\.corp/; if (OK.test(host)) grant();`);
  });
  test("fires: localhost gate against a host operand", () => {
    fires(U, `if (/localhost/.test(host)) allowLocal();`);
  });
  test("fires: dotted IPv4 gate against a host operand", () => {
    fires(U, `if (/127\\.0\\.0\\.1/.test(host)) skip();`);
  });
  test("fires: suffix-only ($) domain gate against origin", () => {
    fires(U, `if (/trusted\\.com$/.test(origin)) accept();`);
  });
  test("fires: .exec used as a boolean gate against origin", () => {
    fires(U, `if (/trusted\\.com/.exec(origin)) ok();`);
  });
  test("fires: non-global .match as a boolean gate against host", () => {
    fires(U, `if (host.match(/trusted\\.com/)) ok();`);
  });
  test("fires: member operand whose last segment is a URL name", () => {
    fires(U, `if (/trusted\\.com/.test(req.redirectUrl)) go();`);
  });

  // MUST BE SILENT ---------------------------------------------------------
  test("silent: fully anchored allowlist", () => {
    silent(U, `if (/^https:\\/\\/trusted\\.com$/.test(url)) go();`);
  });
  test("silent: start-anchored with a word-boundary end", () => {
    silent(U, `if (/^https:\\/\\/trusted\\.com\\b/.test(url)) go();`);
  });
  test("silent: start-anchored is-absolute-URL prefix check (missing end anchor)", () => {
    silent(U, `function f(){ if (/^https?:\\/\\//.test(hrefCandidate)) return; }`);
  });
  test("silent: start-anchored via a wrapping group", () => {
    silent(U, `if (/(?:^|\\s)https:\\/\\/trusted\\.com/.test(url)) go();`);
  });
  test("silent: .replace whitespace normalization (not a boolean gate)", () => {
    silent(U, `const y = str.replace(/\\s+/g, " ");`);
  });
  test("silent: global .match collecting occurrences (extraction, not a gate)", () => {
    silent(U, `const nums = text.match(/\\d+/g);`);
  });
  test("silent: regex with no URL/host content (zip)", () => {
    silent(U, `if (/^\\d{4}$/.test(zip)) ok();`);
  });
  test("silent: regex with no URL/host content (alpha)", () => {
    silent(U, `if (/[a-z]+/.test(name)) ok();`);
  });
  test("silent: generic URL detector against a non-URL operand (linkifier)", () => {
    silent(U, `if (/https?:\\/\\//.test(token)) renderLink();`);
  });
  test("silent: scheme-only regex is absolute-URL detection, not a host allowlist", () => {
    // `/https?:\/\//` names no concrete host — there is no trusted host to smuggle
    // past, so this is "is this absolute?" detection (open-redirect at worst, a
    // different bug class), not the unanchored-allowlist bypass this rule targets.
    silent(U, `if (/https?:\\/\\//.test(redirectUrl)) go(redirectUrl);`);
    silent(U, `const isAbsolute = !!baseUrl.match(/https?:\\/\\//);`);
  });
  test("silent: window.location self-detection is not untrusted-input validation", () => {
    silent(U, `if (/internal\\.corp\\.google\\.com/.test(location.hostname)) enableDebug();`);
    silent(U, `if (window.location.href.match(/staging\\.example\\.com/)) showBanner();`);
  });
  test("silent: domain content but operand is not URL/host named", () => {
    silent(U, `function detect(){ if (/github\\.com[:/]/i.test(remoteStdout)) return "gh"; }`);
  });
  test("silent: role token against a non-URL operand", () => {
    silent(U, `if (/admin/.test(role)) elevate();`);
  });
  test("silent: file-extension regex, not a host (txt is not a TLD)", () => {
    silent(U, `if (/file\\.txt/.test(name)) ok();`);
  });
  test("silent: digit.digit is not a domain", () => {
    silent(U, `if (/\\d\\.\\d/.test(version)) ok();`);
  });
  test("silent: new RegExp(dynamic) — not a literal", () => {
    silent(U, `const re = new RegExp(input, "i"); if (re.test(url)) go();`);
  });
  test("silent: extraction via .match with a capture group against a non-URL operand", () => {
    silent(U, `const m = dockerfile.match(/git clone https:\\/\\/github\\.com\\/([\\w.-]+)/);`);
  });
  test("silent: secret-file path detector (end-anchored, path operand, admin token)", () => {
    silent(
      U,
      `const RE = /(?:^|\\/)[^/]*firebase-admin[^/]*\\.(?:json|pem)$/i; if (RE.test(relativePath)) flag();`,
    );
  });
});

// ---------------------------------------------------------------------------
// no-stateful-global-regex-test
// ---------------------------------------------------------------------------

describe("no-stateful-global-regex-test", () => {
  const S = noStatefulGlobalRegexTest;

  test("fires: const global regex reused with .test()", () => {
    fires(S, `const RE = /^[a-z]+$/g; export const valid = (s) => RE.test(s);`);
  });
  test("fires: sticky (y) regex with .test()", () => {
    fires(S, `const RE = /foo/y; if (RE.test(x)) go();`);
  });
  test("fires: var global regex with .test()", () => {
    fires(S, `var RE = /id/g; RE.test("id");`);
  });
  test("fires: let global regex with .test() inside a function", () => {
    fires(S, `let RE = /id/g; function f(x){ return RE.test(x); }`);
  });
  test("fires: global .exec used as a one-shot boolean (not in a loop)", () => {
    fires(S, `const RE = /id/g; if (RE.exec(x)) go();`);
  });

  // MUST BE SILENT ---------------------------------------------------------
  test("silent: stored regex without g/y (stateless)", () => {
    silent(S, `const RE = /^[a-z]+$/; RE.test(s);`);
  });
  test("silent: inline global literal used once (fresh, no persisted state)", () => {
    silent(S, `if (/foo/g.test(x)) go();`);
  });
  test("silent: .match() (does not consult lastIndex like a boolean gate)", () => {
    silent(S, `const RE = /\\d+/g; const m = s.match(RE);`);
  });
  test("silent: .matchAll()", () => {
    silent(S, `const RE = /\\d+/g; const m = [...s.matchAll(RE)];`);
  });
  test("silent: .replace()", () => {
    silent(S, `const RE = /\\s+/g; const y = s.replace(RE, " ");`);
  });
  test("silent: .exec() in a while-loop iteration idiom", () => {
    silent(S, `const RE = /\\w+/g; let m; while ((m = RE.exec(text))) collect(m);`);
  });
  test("silent: .exec() in a for-loop", () => {
    silent(S, `const RE = /\\w+/g; for (let m; (m = RE.exec(tx)); ) use(m);`);
  });
  test("silent: name is reassigned (initializer may not reflect the value)", () => {
    silent(S, `let RE = /a/g; RE = /b/; RE.test(x);`);
  });
  test("silent: author manages lastIndex explicitly", () => {
    silent(S, `const RE = /a/g; RE.lastIndex = 0; RE.test(x);`);
  });
  test("silent: new RegExp(..., 'g') — not a regex literal", () => {
    silent(S, `const RE = new RegExp("a", "g"); RE.test(x);`);
  });
  test("silent: member/property receiver (this.re) — not an identifier binding", () => {
    silent(S, `class C { re = /a/g; f(x){ return this.re.test(x); } }`);
  });
});
