/**
 * `no-substring-host-check`.
 *
 * MEASURED with Node's own `URL` parser — the same one `fetch` and every redirect
 * follow — against `ALLOW = "https://trusted.com"`:
 *
 *   url                                        startsWith includes endsWith  real hostname
 *   https://trusted.com/ok                     true       true     false     trusted.com
 *   https://trusted.com.evil.com/steal         TRUE       TRUE     false     trusted.com.evil.com
 *   https://trusted.com@evil.com/steal         TRUE       TRUE     false     evil.com
 *   https://evil.com/?next=https://trusted.com false      TRUE     TRUE      evil.com
 *
 * Every attack passes at least one. `startsWith` falls to the subdomain suffix
 * and, worse, to `trusted.com@evil.com`, where everything before the `@` is
 * USERINFO and the real host is `evil.com`.
 *
 * On a PARSED hostname, measured against `"trusted.com"`:
 *
 *   hostname               ===    endsWith("trusted.com")  endsWith(".trusted.com")  startsWith
 *   trusted.com            true   true                     false                     true
 *   trusted.com.evil.com   false  false                    false                     TRUE
 *   nottrusted.com         false  TRUE                     false                     false
 *   api.trusted.com        false  true                     true                      false
 *
 * So only `===` and a DOT-PREFIXED suffix hold. That is the whole two-tier model.
 *
 * The rule exists because `no-ssrf-unvalidated-url` and `no-open-redirect` both
 * count `startsWith` as evidence that validation exists and go quiet — so the
 * bypassable check currently reads as approval.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noSubstringHostCheck } from "../../src/diagnostics/security/no-substring-host-check.ts";

const CAPS = new Set(["node", "esm", "typescript", "express"]);

const findings = (body: string) =>
  lintSource({
    filePath: "/repo/src/redirect.ts",
    sourceText: `export function guard(url, redirectUrl, origin) {\n${body}\n}\n`,
    diagnostics: [noSubstringHostCheck],
    capabilities: CAPS,
  }).findings.filter((f) => f.diagnostic === "no-substring-host-check");

const fires = (body: string) => {
  const found = findings(body);
  assert.ok(found.length > 0, `expected a FIRE on:\n${body}`);
  return found;
};
const silent = (body: string): void => {
  const found = findings(body);
  assert.equal(found.length, 0, `expected SILENCE on:\n${body}\ngot: ${found.map((f) => f.message).join("\n")}`);
};

describe("no-substring-host-check", () => {
  describe("a raw URL string — every spelling is bypassable", () => {
    test("startsWith, which the userinfo trick defeats", () => {
      fires(`if (!url.startsWith("https://trusted.com")) throw new Error("bad host");`);
    });

    test("includes, which a query parameter defeats", () => {
      fires(`if (url.includes("trusted.com")) return redirect(url);`);
    });

    test("endsWith on a full URL, answered by the query string", () => {
      fires(`if (redirectUrl.endsWith("trusted.com")) return redirect(redirectUrl);`);
    });

    test("indexOf compared with 0 or -1 is the hand-written spelling", () => {
      fires(`if (url.indexOf("https://trusted.com") === 0) return fetch(url);`);
      fires(`if (url.indexOf("trusted.com") !== -1) return fetch(url);`);
    });

    test("every gate position", () => {
      fires(`if (url.startsWith("https://trusted.com")) return 1; return 2;`);
      fires(`return url.startsWith("https://trusted.com") && fetch(url);`);
      fires(`return !url.startsWith("https://trusted.com");`);
      fires(`return url.startsWith("https://trusted.com") ? fetch(url) : null;`);
      fires(`while (url.includes("trusted.com")) { break; }`);
    });

    test("a dotted IPv4 and localhost are concrete hosts too", () => {
      fires(`if (url.startsWith("http://127.0.0.1")) return fetch(url);`);
      fires(`if (url.startsWith("http://localhost")) return fetch(url);`);
    });

    test("the message names the userinfo bypass and the honest-silence point", () => {
      const [found] = fires(`if (!url.startsWith("https://trusted.com")) throw new Error("bad");`);
      assert.match(found!.message, /USERINFO/);
      assert.match(found!.message, /trusted\.com@evil\.com/);
      assert.match(found!.message, /no-ssrf-unvalidated-url/);
      assert.match(found!.recommendation ?? "", /new URL\(url\)\.hostname/);
    });
  });

  describe("a parsed hostname — only the dot-prefixed suffix holds", () => {
    test("a dotless endsWith still accepts nottrusted.com", () => {
      fires(`const h = new URL(url).hostname;\nif (h.endsWith("trusted.com")) return fetch(url);`);
      fires(`if (new URL(url).hostname.endsWith("trusted.com")) return fetch(url);`);
    });

    test("the dot-prefixed suffix is the documented correct check", () => {
      silent(`const h = new URL(url).hostname;\nif (h.endsWith(".trusted.com")) return fetch(url);`);
      silent(`if (new URL(url).hostname.endsWith(".trusted.com")) return fetch(url);`);
    });

    test("startsWith on a hostname accepts the subdomain suffix", () => {
      fires(`const h = new URL(url).hostname;\nif (h.startsWith("trusted.com")) return fetch(url);`);
    });

    test("includes on a hostname is still a substring test", () => {
      fires(`const h = new URL(url).hostname;\nif (h.includes("trusted.com")) return fetch(url);`);
    });

    test("the message is the hostname one, not the URL one", () => {
      const [found] = fires(`const h = new URL(url).hostname;\nif (h.endsWith("trusted.com")) return 1; return 2;`);
      assert.match(found!.message, /substring of a hostname/);
      assert.match(found!.message, /nottrusted\.com/);
      assert.doesNotMatch(found!.message, /USERINFO/);
    });
  });

  describe("silence — an exact comparison is the fix", () => {
    test("=== on a hostname or an origin", () => {
      silent(`if (new URL(url).hostname !== "trusted.com") throw new Error("bad");`);
      silent(`if (origin !== "https://trusted.com") throw new Error("bad");`);
    });
  });

  describe("precision guards", () => {
    test("a bare scheme has no trusted host to smuggle past", () => {
      silent(`if (!url.startsWith("https://")) throw new Error("relative");`);
      silent(`if (url.startsWith("/")) return url;`);
    });

    test("a non-literal argument cannot be read", () => {
      silent(`if (url.startsWith(ALLOWED_ORIGIN)) return fetch(url);`);
      silent(`if (url.startsWith(process.env.BASE_URL)) return fetch(url);`);
    });

    test("a receiver that is not a URL or a host", () => {
      silent(`if (message.includes("trusted.com")) return log(message);`);
      silent(`if (config.includes("trusted.com")) return 1; return 2;`);
    });

    test("a branch that REWRITES the tested value is normalization", () => {
      // node.doctor's own self-scan reported this shape in `normalizeRepoUrl`,
      // which rewrites an SSH remote read out of the project's package.json.
      // There is no allowlist and no attacker — the branch dispatches on which
      // spelling arrived.
      silent(`if (url.startsWith("git@github.com:")) url = "https://github.com/" + url.slice(15);\nreturn url;`);
      silent(`let u = url;\nif (u.includes("github.com")) { u = u.replace("github.com", "gh.io"); }\nreturn u;`);
      // Still fires when the branch refuses rather than rewrites.
      fires(`if (url.startsWith("https://trusted.com")) return url;\nthrow new Error("bad");`);
    });

    test("a computed value rather than a gate", () => {
      silent(`const isTrusted = url.startsWith("https://trusted.com");\nreturn isTrusted;`);
      silent(`log(url.includes("trusted.com"));`);
    });

    test("search and match belong to the regex rule", () => {
      silent(`if (url.search(/trusted\\.com/) === 0) return fetch(url);`);
      silent(`if (url.match(/trusted\\.com/)) return fetch(url);`);
    });

    test("indexOf compared with something else is not this gate", () => {
      silent(`const at = url.indexOf("trusted.com");\nif (at === 8) return fetch(url);`);
    });
  });

  test("determinism — identical source yields identical findings", () => {
    const body = `if (url.startsWith("https://trusted.com")) return 1;\nif (redirectUrl.includes("trusted.com")) return 2;\nreturn 3;`;
    assert.equal(JSON.stringify(findings(body)), JSON.stringify(findings(body)));
    assert.equal(findings(body).length, 2);
  });
});
