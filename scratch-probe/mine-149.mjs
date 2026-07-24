import { lintSource } from "../src/core/scan.ts";
import { noWildcardBodyParser as D } from "../src/diagnostics/http/no-wildcard-body-parser.ts";
const caps=new Set(["node","esm","typescript","express"]);
const n=(s)=>lintSource({filePath:"a.ts",sourceText:s,diagnostics:[D],capabilities:caps}).findings.length;
for (const [l,s,e] of [
 ["TP json type */*", `app.use(express.json({ type: "*/*" }));`,1],
 ["TP urlencoded () => true", `app.use(bodyParser.urlencoded({ type: () => true }));`,1],
 ["TP raw */*", `express.raw({ type: "*/*" });`,1],
 ["SILENT default json()", `app.use(express.json());`,0],
 ["SILENT specific type", `express.json({ type: "application/json" });`,0],
 ["SILENT type array", `express.json({ type: ["application/json","application/*+json"] });`,0],
 ["SILENT dynamic type", `express.json({ type: userType });`,0],
 ["SILENT express.static", `app.use(express.static(dir));`,0],
 ["SILENT cors", `app.use(cors());`,0],
]) {const g=n(s);console.log(`${g===e?"✓":"✗"} [${g}/${e}] ${l}`);}
