import { readFileSync } from "node:fs"; import { execSync } from "node:child_process";
import { lintSource } from "../src/core/scan.ts";
import { noWildcardBodyParser as W } from "../src/diagnostics/http/no-wildcard-body-parser.ts";
const caps=new Set(["node","esm","typescript","commonjs","express"]);
const files=execSync("find src -name '*.ts'",{encoding:"utf8"}).split("\n").filter(Boolean);
let c=0;for(const f of files){const r=lintSource({filePath:f,sourceText:readFileSync(f,"utf8"),diagnostics:[W],capabilities:caps});c+=r.findings.length;}
console.log("§149 findings on our src:",c);
