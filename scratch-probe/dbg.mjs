import { lintSource } from "../src/core/scan.ts";
import { noUnanchoredSecurityRegex as d } from "../src/diagnostics/security/no-unanchored-security-regex.ts";
const caps = new Set(["node","esm","typescript"]);
const T = (label, src) => {
  const f = lintSource({ filePath:"a.ts", sourceText:src, diagnostics:[d], capabilities:caps }).findings;
  console.log(`  ${f.length? "FIRE":"silent"}  ${label}`);
};
// exact FP shapes from our own src / corpus
T("issue-url: anchored ^https?", `function f(url){ if (!/^https?:\\/\\//.test(url)) return undefined; }`);
T("detect-ci: github.com on .stdout", `function f(remote){ if (/github\\.com[:/]/i.test(remote.stdout)) return "gha"; }`);
T("npmrc anchored (?:^|/)", `function f(relativePath){ return /(?:^|\\/)\\.npmrc$/.test(relativePath); }`);
T("open-cidr on line", `const OPEN_CIDR_RE=/0\\.0\\.0\\.0/; function f(line){ if(!OPEN_CIDR_RE.test(line)) return; }`);
