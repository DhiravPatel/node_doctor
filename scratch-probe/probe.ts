import { lintSource } from "../src/core/scan.ts";
import { noWildcardBodyParser as D } from "../src/diagnostics/http/no-wildcard-body-parser.ts";

const caps = new Set(["node", "esm", "typescript", "express"]);
const n = (s: string) =>
  lintSource({ filePath: "a.ts", sourceText: s, diagnostics: [D], capabilities: caps }).findings.length;

interface Case {
  label: string;
  src: string;
  expect: "silent" | "fire";
}

const cases: Case[] = [
  // ---- Scoped wildcard subtypes that are NOT universal → must be SILENT ----
  { label: "express.json application/*", src: `import express from "express";\napp.use(express.json({ type: "application/*" }));`, expect: "silent" },
  { label: "express.json */json", src: `import express from "express";\napp.use(express.json({ type: "*/json" }));`, expect: "silent" },
  { label: "express.text text/*", src: `import express from "express";\napp.use(express.text({ type: "text/*" }));`, expect: "silent" },
  { label: "express.json application/*+json", src: `import express from "express";\napp.use(express.json({ type: "application/*+json" }));`, expect: "silent" },
  { label: "express.raw application/octet-stream", src: `import express from "express";\napp.use(express.raw({ type: "application/octet-stream" }));`, expect: "silent" },

  // ---- */* still fires even with a verify option → TP ----
  { label: "express.json */* + verify", src: `import express from "express";\napp.use(express.json({ type: "*/*", verify: fn }));`, expect: "fire" },

  // ---- Real content-type predicate functions → must be SILENT ----
  { label: "predicate includes('json')", src: `import express from "express";\napp.use(express.json({ type: (req) => req.headers['content-type']?.includes('json') }));`, expect: "silent" },
  { label: "predicate req.is('json')", src: `import express from "express";\napp.use(express.json({ type: (req) => req.is('json') }));`, expect: "silent" },
  { label: "predicate returns false", src: `import express from "express";\napp.use(express.json({ type: () => false }));`, expect: "silent" },
  { label: "predicate block real logic", src: `import express from "express";\napp.use(express.json({ type: (req) => { return req.is('json') !== false; } }));`, expect: "silent" },
  { label: "predicate conditional", src: `import express from "express";\napp.use(express.json({ type: (req) => req.method === 'POST' ? true : false }));`, expect: "silent" },

  // ---- Non-body-parser .json() → must be SILENT ----
  { label: "res.json response", src: `res.json({ type: "*/*" });`, expect: "silent" },
  { label: "response.json()", src: `response.json();`, expect: "silent" },
  { label: "bare json no import", src: `json({ type: "*/*" });`, expect: "silent" },
  { label: "myParser.json not express", src: `myParser.json({ type: "*/*" });`, expect: "silent" },

  // ---- Dynamic identifier → SILENT (unprovable, acceptable) ----
  { label: "express.json SOME_CONST", src: `import express from "express";\nconst SOME_CONST = "*/*";\napp.use(express.json({ type: SOME_CONST }));`, expect: "silent" },

  // ---- Confirmed true positives ----
  { label: "app.use(express.json */*)", src: `import express from "express";\napp.use(express.json({ type: "*/*" }));`, expect: "fire" },
  { label: "bodyParser.raw () => true", src: `import bodyParser from "body-parser";\napp.use(bodyParser.raw({ type: () => true }));`, expect: "fire" },
  { label: "bare json body-parser import */*", src: `import { json } from "body-parser";\napp.use(json({ type: "*/*" }));`, expect: "fire" },

  // ---- Extra adversarial probes ----
  { label: "list containing */*", src: `import express from "express";\napp.use(express.json({ type: ["application/json", "*/*"] }));`, expect: "silent" },
  { label: "template literal */*", src: `import express from "express";\napp.use(express.json({ type: \`*/*\` }));`, expect: "fire" },
  { label: "predicate arrow body true", src: `import express from "express";\napp.use(express.json({ type: (req) => true }));`, expect: "fire" },
  { label: "express.Router().json */*", src: `import express from "express";\nexpress.Router().json({ type: "*/*" });`, expect: "silent" },
  { label: "express.response.json */*", src: `import express from "express";\nexpress.response.json({ type: "*/*" });`, expect: "silent" },
  { label: "no type option", src: `import express from "express";\napp.use(express.json());`, expect: "silent" },
  { label: "type application/json", src: `import express from "express";\napp.use(express.json({ type: "application/json" }));`, expect: "silent" },
  { label: "spread options", src: `import express from "express";\napp.use(express.json({ ...opts }));`, expect: "silent" },
  { label: "block return true single", src: `import express from "express";\napp.use(express.json({ type: function(){ return true; } }));`, expect: "fire" },
  { label: "empty arrow */* string via concat", src: `import express from "express";\napp.use(express.json({ type: "*" + "/*" }));`, expect: "silent" },
];

let fps = 0;
let fns = 0;
for (const c of cases) {
  let count: number;
  try {
    count = n(c.src);
  } catch (e) {
    console.log(`CRASH   | ${c.label} | ${(e as Error).message}`);
    continue;
  }
  const fired = count > 0;
  const want = c.expect === "fire";
  let tag = "OK   ";
  if (fired && !want) {
    tag = "FP!!!";
    fps++;
  } else if (!fired && want) {
    tag = "FN!!!";
    fns++;
  }
  console.log(`${tag} | expect=${c.expect} fired=${fired}(${count}) | ${c.label}`);
}
console.log(`\nTOTAL cases=${cases.length} FPs=${fps} FNs=${fns}`);
