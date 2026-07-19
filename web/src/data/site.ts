export const CATEGORY_COLORS: Record<string, string> = {
  Security: "var(--cat-security)",
  Reliability: "var(--cat-reliability)",
  Bugs: "var(--cat-bugs)",
  Performance: "var(--cat-performance)",
  Maintainability: "var(--cat-maintainability)",
};

export const PROBLEMS = [
  {
    kicker: "① Broken asynchrony",
    title: "The shape that reads best drops the work",
    body: "forEach does not await. Every iteration becomes an unhandled promise: ordering is lost, rejections vanish, and the function resolves before anything finished.",
    code: [
      { t: "users.forEach(", c: "" },
      { t: "async", c: "kw" },
      { t: " (user) => {", c: "" },
      { t: "\n  await sendEmail(user);", c: "" },
      { t: "\n});", c: "" },
      { t: "\nreturn ", c: "" },
      { t: '"all sent"', c: "str" },
      { t: "; ", c: "" },
      { t: "// returns before any email is sent", c: "cm" },
    ],
  },
  {
    kicker: "② Blocking the event loop",
    title: "One sync call freezes every request",
    body: "Node runs your JavaScript on one thread. A synchronous read inside a handler stalls the whole process — every concurrent request, the timers, the liveness probe. The same call at module scope is correct.",
    code: [
      { t: "app.get(", c: "" },
      { t: '"/report"', c: "str" },
      { t: ", (req, res) => {\n  ", c: "" },
      { t: "const t = fs.readFileSync(path); ", c: "cm" },
      { t: "// stalls everything", c: "cm" },
      { t: "\n  res.send(render(t));\n});", c: "" },
    ],
  },
  {
    kicker: "③ Unbounded resource use",
    title: "Fan-out proportional to caller input",
    body: "Code that scales with caller-supplied input is a denial of service waiting for the right request. One socket per row is fine on ten rows and catastrophic on ten thousand.",
    code: [
      { t: "await Promise.all(\n  rows.map((r) => fetch(", c: "" },
      { t: "`/api/${r.id}`", c: "str" },
      { t: "))\n); ", c: "" },
      { t: "// one socket per row", c: "cm" },
    ],
  },
  {
    kicker: "④ Injection & secret sinks",
    title: "The unsafe form is shorter",
    body: "The classics, still written constantly because the unsafe form takes fewer keystrokes than the safe one. Each compiles. Each is a production incident.",
    code: [
      { t: "exec(", c: "" },
      { t: "`tar -czf b.tgz ${req.body.dir}`", c: "str" },
      { t: "); ", c: "" },
      { t: "// command injection", c: "cm" },
      { t: "\nconst s = process.env.JWT_SECRET || ", c: "" },
      { t: '"dev-secret"', c: "str" },
      { t: "; ", c: "" },
      { t: "// committed key", c: "cm" },
    ],
  },
];

export const PILLARS = [
  {
    title: "Context-aware",
    body: "readFileSync at module scope is a config load and correct. The identical call inside a route handler stalls every concurrent request. node.doctor tells them apart — most linters flag both (and get disabled) or neither (and miss the bug).",
  },
  {
    title: "Version-aware",
    body: "The Express-4 async-handler bug is a client-hanging footgun and a complete non-issue on Express 5, which awaits handler returns. node.doctor reads your manifest and retires the diagnostic automatically when it no longer applies.",
  },
  {
    title: "Transparent local score",
    body: "Every scan produces a 0–100 number computed entirely on your machine from a published formula. No network call, no closed model, reproducible on a plane. The number that gates your CI is one you can audit by hand.",
  },
];

export const COMPARISON = {
  cols: ["", "ESLint + plugins", "node.doctor"],
  rows: [
    ["Context gating (module vs request path)", false, true],
    ["Version gating (Express 4 vs 5)", false, true],
    ["Curated, opinionated diagnostics", false, true],
    ["Health score", false, true],
    ["CI baseline delta (legacy-friendly)", false, true],
    ["Agent skill (upstream prevention)", false, true],
    ["Zero-config first run", "partial", true],
  ] as [string, boolean | "partial", boolean][],
};

// Two real fixture outcomes, shown in the interactive demo.
export const DEMOS = {
  bad: {
    name: "agent-app",
    score: 0,
    label: "critical",
    errors: 15,
    warnings: 5,
    perKloc: 572.4,
    byCategory: { Security: 8, Reliability: 8, Bugs: 2, Performance: 2, Maintainability: 0 },
  },
  good: {
    name: "good-app",
    score: 100,
    label: "healthy",
    errors: 0,
    warnings: 0,
    perKloc: 0,
    byCategory: { Security: 0, Reliability: 0, Bugs: 0, Performance: 0, Maintainability: 0 },
  },
};

export const TERMINAL_LINES: { t: string; c?: string }[] = [
  { t: "  node.doctor v0.1.0  checkout-service\n" },
  { t: "  148 files · 21,904 lines · 50/61 diagnostics active\n", c: "dim" },
  { t: "  detected: typescript esm express prisma jsonwebtoken\n\n", c: "dim" },
  { t: "  ██████░░░░░░░░░░░░░░░░░░░░░░░░  ", c: "err" },
  { t: "21/100  critical\n\n", c: "b" },
  { t: "  38 errors  ·  17 warnings  ·  71.4 weighted/kLOC\n\n", c: "dim" },
  { t: "  Security (19)\n\n", c: "b" },
  { t: "  ✖ SQL built by string interpolation", c: "err" },
  { t: " · 6 sites\n", c: "dim" },
  { t: "     SQL is built from caller-controlled input — this is SQL injection.\n" },
  { t: "     src/orders/repository.ts:88:24\n", c: "cyan" },
  { t: "     src/users/search.ts:52:31\n", c: "cyan" },
  { t: "     … 4 more\n", c: "dim" },
  { t: "     → Use parameter binding: db.query(sql, [id]) or a tagged template.\n", c: "dim" },
  { t: "     node-doctor/no-sql-template-interpolation\n\n", c: "dim" },
  { t: "  ✖ Async route handler with no error path", c: "err" },
  { t: " · 4 sites\n", c: "dim" },
  { t: "     A rejection after the first await escapes Express 4 and hangs.\n" },
  { t: "     src/invoices/routes.ts:94:26\n", c: "cyan" },
  { t: "     → Wrap the handler or add try/catch that calls next(error).\n", c: "dim" },
];
