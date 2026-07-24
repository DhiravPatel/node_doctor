import { lintSource } from "../src/core/scan.ts";
import { noWildcardBodyParser as D } from "../src/diagnostics/http/no-wildcard-body-parser.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (s: string) =>
  lintSource({ filePath: "a.ts", sourceText: s, diagnostics: [D], capabilities: caps }).findings.length;

const probes: [string, string][] = [
  // The stated-silent response serializer, reached via the express prototype root.
  ["express.response.json (response serializer, spec says silent)", `import express from "express";\nexpress.response.json({ type: "*/*" });`],
  ["express.request.json rooted at express", `import express from "express";\nexpress.request.json({ type: "*/*" });`],
  ["express.Router().json (no such method, root=express)", `import express from "express";\nexpress.Router().json({ type: "*/*" });`],
  ["deep chain express.a.b.c.json */*", `import express from "express";\nexpress.a.b.c.json({ type: "*/*" });`],
  ["bodyParser.response.json rooted at bodyParser", `import bodyParser from "body-parser";\nbodyParser.response.json({ type: "*/*" });`],
  // A genuinely unrelated root must stay silent (control).
  ["app.response.json (root not express)", `app.response.json({ type: "*/*" });`],
  ["foo.express.json (express is not root)", `foo.express.json({ type: "*/*" });`],
  // Correct immediate-receiver forms (should fire, control TPs).
  ["direct express.json", `import express from "express";\nexpress.json({ type: "*/*" });`],
  ["direct bodyParser.urlencoded", `import bodyParser from "body-parser";\nbodyParser.urlencoded({ type: "*/*" });`],
];

for (const [label, src] of probes) {
  const c = n(src);
  console.log(`${c > 0 ? "FIRE " : "silent"} (${c}) | ${label}`);
}
