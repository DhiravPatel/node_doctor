import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  scanAgentContext,
  applyContextHygiene,
  buildIgnoreEntries,
  AIIGNORE_START,
  claudeDenyRules,
  type ContextHygieneReport,
  type SensitiveFile,
} from "../../src/core/agent-context.ts";

// A GCP service-account key: JSON carrying the account marker + an embedded key.
const SERVICE_ACCOUNT = JSON.stringify(
  {
    type: "service_account",
    project_id: "demo",
    private_key: "-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBgkq\n-----END PRIVATE KEY-----\n",
    client_email: "demo@demo.iam.gserviceaccount.com",
  },
  null,
  2,
);

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAabc123\n-----END RSA PRIVATE KEY-----\n";

/** Lay down the fixture tree; a pre-existing .aiignore already covers server.pem. */
const makeFixture = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-context-"));
  // A `.env` is classified by NAME (holds secrets by convention), so the value is
  // irrelevant to the test — a placeholder keeps a real key shape out of the repo.
  await writeFile(join(dir, ".env"), "API_KEY=local-dev-placeholder\n");
  await writeFile(join(dir, ".env.example"), "API_KEY=\n");
  await writeFile(join(dir, "server.pem"), PEM);
  await mkdir(join(dir, "config"), { recursive: true });
  await writeFile(join(dir, "config", "service-account.json"), SERVICE_ACCOUNT + "\n");
  await mkdir(join(dir, "fixtures"), { recursive: true });
  await writeFile(
    join(dir, "fixtures", "users.json"),
    JSON.stringify([{ id: 1, name: "Ada" }, { id: 2, name: "Alan" }], null, 2) + "\n",
  );
  await writeFile(join(dir, "dump.sql"), "INSERT INTO users (id, name) VALUES (1, 'Ada');\n");
  // A user already ignores dist/ and server.pem — this must survive a --write.
  await writeFile(join(dir, ".aiignore"), "dist/\nserver.pem\n");
  return dir;
};

const byPath = (report: ContextHygieneReport, path: string): SensitiveFile | undefined =>
  report.files.find((f) => f.normalizedPath === path);

describe("§158 scanAgentContext — classification", () => {
  test("classifies env / key-material / credentials / data-dump, and stays silent on templates + benign fixtures", async () => {
    const dir = await makeFixture();
    try {
      const report = await scanAgentContext(dir);

      // (a) correct categories
      assert.equal(byPath(report, ".env")?.category, "env");
      assert.equal(byPath(report, "server.pem")?.category, "key-material");
      assert.equal(byPath(report, "config/service-account.json")?.category, "credentials");
      assert.equal(byPath(report, "dump.sql")?.category, "data-dump");

      // (b) shareable template + benign test data are NOT flagged
      assert.equal(byPath(report, ".env.example"), undefined);
      assert.equal(byPath(report, "fixtures/users.json"), undefined);

      // (c) exposed excludes anything already covered by an ignore rule
      assert.deepEqual(byPath(report, "server.pem")?.coveredBy, ["aiignore"]);
      assert.ok(!report.exposed.some((f) => f.normalizedPath === "server.pem"), "covered file is not exposed");
      assert.ok(report.exposed.some((f) => f.normalizedPath === ".env"), "uncovered .env is exposed");
      assert.ok(report.exposed.some((f) => f.normalizedPath === "config/service-account.json"));
      assert.ok(report.exposed.some((f) => f.normalizedPath === "dump.sql"));

      // summary is consistent and category-keyed
      assert.equal(report.summary.total, report.files.length);
      assert.equal(report.summary.exposed, report.exposed.length);
      assert.equal(report.summary.byCategory.env, 1);
      assert.equal(report.summary.byCategory["key-material"], 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("output is deterministic across two runs", async () => {
    const dir = await makeFixture();
    try {
      const a = await scanAgentContext(dir);
      const b = await scanAgentContext(dir);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
      // files are sorted by path
      const paths = a.files.map((f) => f.normalizedPath);
      assert.deepEqual(paths, [...paths].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("§158 artifact generation", () => {
  test("entries prefer class globs, emit exact paths for one-offs, and keep placeholders re-included", async () => {
    const dir = await makeFixture();
    try {
      const report = await scanAgentContext(dir);
      const entries = buildIgnoreEntries(report);
      assert.ok(entries.includes(".env"), "env class glob");
      assert.ok(entries.includes(".env.*"), "env family glob");
      assert.ok(entries.includes("*.pem"), "key-material class glob");
      assert.ok(entries.includes("config/service-account.json"), "credential exact path");
      assert.ok(entries.includes("dump.sql"), "data-dump exact path");
      assert.ok(entries.includes("!.env.example"), "template re-include");

      // Positives precede negations so the gitignore re-includes actually take effect.
      const firstNeg = entries.findIndex((e) => e.startsWith("!"));
      const lastPos = entries.map((e) => e.startsWith("!")).lastIndexOf(false);
      assert.ok(firstNeg === -1 || firstNeg > lastPos, "negations come after positives");

      const rules = claudeDenyRules(report);
      assert.ok(rules.includes("Read(./.env)"));
      assert.ok(rules.includes("Read(./*.pem)"));
      assert.deepEqual(rules, [...rules].sort(), "deny rules are sorted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("§158 applyContextHygiene — idempotent write", () => {
  test("writes the three artifacts, preserves user lines, and a second run is byte-identical", async () => {
    const dir = await makeFixture();
    try {
      const report = await scanAgentContext(dir);
      const first = await applyContextHygiene(dir, report);

      const aiignorePath = join(dir, ".aiignore");
      const cursorPath = join(dir, ".cursorignore");
      const claudePath = join(dir, ".claude", "settings.json");

      // (d) all three artifacts written
      assert.ok(first.written.includes(aiignorePath));
      assert.ok(first.written.includes(cursorPath));
      assert.ok(first.written.includes(claudePath));

      // user lines preserved + managed block present
      const aiignore = await readFile(aiignorePath, "utf8");
      assert.match(aiignore, /^dist\/$/m, "user's dist/ line preserved");
      assert.match(aiignore, /^server\.pem$/m, "user's server.pem line preserved");
      assert.ok(aiignore.includes(AIIGNORE_START), "managed block present");
      assert.ok(aiignore.endsWith("\n") && !aiignore.endsWith("\n\n"), "single trailing newline");

      // Claude deny merged as a sorted string array under permissions.deny
      const claude = JSON.parse(await readFile(claudePath, "utf8")) as {
        permissions: { deny: string[] };
      };
      assert.ok(Array.isArray(claude.permissions.deny));
      assert.ok(claude.permissions.deny.includes("Read(./.env)"));
      assert.deepEqual(claude.permissions.deny, [...claude.permissions.deny].sort());

      // Capture bytes, then re-scan (coverage now satisfied) and re-apply.
      const before = {
        ai: await readFile(aiignorePath, "utf8"),
        cursor: await readFile(cursorPath, "utf8"),
        claude: await readFile(claudePath, "utf8"),
      };
      const rescan = await scanAgentContext(dir);
      // Everything is now covered by the artifacts we just wrote.
      assert.equal(rescan.exposed.length, 0);
      const second = await applyContextHygiene(dir, rescan);

      assert.deepEqual(second.written, [], "nothing rewritten on the second run");
      assert.deepEqual(second.unchanged.sort(), [aiignorePath, claudePath, cursorPath].sort());

      assert.equal(await readFile(aiignorePath, "utf8"), before.ai, "aiignore byte-identical");
      assert.equal(await readFile(cursorPath, "utf8"), before.cursor, "cursorignore byte-identical");
      assert.equal(await readFile(claudePath, "utf8"), before.claude, "claude settings byte-identical");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves an unrelated Claude settings key and permissions.allow", async () => {
    const dir = await makeFixture();
    try {
      await mkdir(join(dir, ".claude"), { recursive: true });
      await writeFile(
        join(dir, ".claude", "settings.json"),
        JSON.stringify({ model: "claude", permissions: { allow: ["Read(./src/**)"] } }, null, 2) + "\n",
      );
      const report = await scanAgentContext(dir);
      await applyContextHygiene(dir, report);
      const claude = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8")) as {
        model: string;
        permissions: { allow: string[]; deny: string[] };
      };
      assert.equal(claude.model, "claude");
      assert.deepEqual(claude.permissions.allow, ["Read(./src/**)"]);
      assert.ok(claude.permissions.deny.includes("Read(./.env)"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a clean tree writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-context-clean-"));
    try {
      await writeFile(join(dir, "index.js"), "export const x = 1;\n");
      const report = await scanAgentContext(dir);
      assert.equal(report.files.length, 0);
      const result = await applyContextHygiene(dir, report);
      assert.deepEqual(result, { written: [], unchanged: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("§158 classification precision (FP-hunt regressions)", () => {
  const cat = async (dir: string, path: string): Promise<string | undefined> =>
    (await scanAgentContext(dir)).files.find((f) => f.normalizedPath === path)?.category;

  test("`.key` is content-gated: a Keynote/CSS/i18n `.key` is silent; a PEM `.key` is flagged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-context-key-"));
    try {
      await writeFile(join(dir, "styles.key"), "@keyframes fade { from { opacity: 0 } }\n");
      await writeFile(join(dir, "server.key"), "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n");
      assert.equal(await cat(dir, "styles.key"), undefined, "benign .key must not classify");
      assert.equal(await cat(dir, "server.key"), "secret-content", "a PEM .key is a real key");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("`.npmrc` flagged only with an auth token (`:_authToken=`), not bare registry config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-context-npmrc-"));
    try {
      await writeFile(join(dir, ".npmrc"), "registry=https://registry.npmjs.org/\nsave-exact=true\n");
      assert.equal(await cat(dir, ".npmrc"), undefined, "benign registry config must not classify");
      await writeFile(join(dir, ".npmrc"), "//registry.npmjs.org/:_authToken=abc123def456ghi\n");
      assert.equal(await cat(dir, ".npmrc"), "credentials", "an npmrc auth token is a credential");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("`dump`/`backup` code files are not data-dumps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-context-dump-"));
    try {
      await writeFile(join(dir, "dump.js"), "export function dump(x) { return x; }\n");
      await writeFile(join(dir, "backup.ts"), "export const backup = () => {};\n");
      const report = await scanAgentContext(dir);
      assert.equal(report.files.length, 0, "code named dump/backup must not classify");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an UPPER-case key extension gets an ignore entry that actually matches it (round-trip)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nd-context-upper-"));
    try {
      await writeFile(join(dir, "SERVER.PEM"), "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n");
      const report = await scanAgentContext(dir);
      // The generated entry must be the exact path (a lowercase `*.pem` glob would
      // never match `SERVER.PEM` on a case-sensitive filesystem).
      assert.ok(buildIgnoreEntries(report).includes("SERVER.PEM"), "exact path, not *.pem");
      await applyContextHygiene(dir, report);
      const rescan = await scanAgentContext(dir);
      assert.equal(rescan.exposed.length, 0, "written fence must actually cover SERVER.PEM");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
