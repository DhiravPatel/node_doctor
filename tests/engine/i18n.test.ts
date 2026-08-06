/**
 * §181 — i18n & User-String Integrity.
 *
 * The claim "this key has no translation" is user-visible and absolute, so the
 * ways it could be WRONG are the specification: a namespaced key, a plural
 * suffix, a `defaultValue`, a `t` that is not a translate function at all, and
 * a JSON file that merely happens to live near the locales.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildI18nReport } from "../../src/core/i18n.ts";

const makeProject = async (files: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-i18n-"));
  await writeFile(join(dir, "package.json"), `{ "name": "app", "version": "1.0.0", "type": "module" }`);
  for (const [rel, src] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, src);
  }
  return dir;
};

const withProject = async <T>(
  files: Record<string, string>,
  fn: (report: Awaited<ReturnType<typeof buildI18nReport>>) => T | Promise<T>,
): Promise<T> => {
  const dir = await makeProject(files);
  try {
    return await fn(await buildI18nReport(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const EN = (keys: Record<string, unknown>) => JSON.stringify(keys, null, 2);
const IMPORT = `import i18next from "i18next";\nconst { t } = i18next;\n`;

describe("i18n — locale discovery must not swallow ordinary JSON", () => {
  test("a project with no locale files reports so, and claims nothing", async () => {
    await withProject({ "src/a.ts": `${IMPORT}t("hello");` }, (r) => {
      assert.equal(r.localesPresent, false);
      assert.deepEqual(r.missingKeys, []);
      assert.deepEqual(r.unusedKeys, []);
    });
  });

  test("tsconfig.json, package.json and fixtures are never catalogues", async () => {
    await withProject(
      {
        "tsconfig.json": `{ "compilerOptions": { "strict": true } }`,
        "src/fixtures/users.json": `{ "a": "b" }`,
        "src/a.ts": `${IMPORT}t("hello");`,
      },
      (r) => assert.equal(r.localesPresent, false),
    );
  });

  test("a JSON file inside `locales/` that is not language-named is not a catalogue", async () => {
    await withProject(
      { "locales/config.json": `{ "fallback": "en" }`, "src/a.ts": `${IMPORT}t("hello");` },
      (r) => assert.equal(r.localesPresent, false),
    );
  });

  test("a catalogue with a NUMBER leaf is not a catalogue", async () => {
    await withProject(
      { "locales/en.json": `{ "retries": 3, "hello": "Hello" }`, "src/a.ts": `${IMPORT}t("hello");` },
      (r) => assert.equal(r.localesPresent, false),
    );
  });

  test("an array of strings and an empty nested object do NOT disqualify a catalogue", async () => {
    // One array value used to throw the whole file away, turning every key it
    // defined into a hard "no translation" claim.
    await withProject(
      {
        "locales/en.json": `{ "tips": ["a", "b"], "empty": {}, "hello": "Hello" }`,
        "src/a.ts": `${IMPORT}t("hello");\nt("tips");`,
      },
      (r) => {
        assert.equal(r.localesPresent, true);
        assert.deepEqual(r.missingKeys, []);
      },
    );
  });

  test("`locales/en.json` and `locales/en/common.json` are both recognized", async () => {
    await withProject({ "locales/en.json": EN({ hello: "Hello" }), "src/a.ts": `${IMPORT}t("hello");` }, (r) => {
      assert.equal(r.localesPresent, true);
      assert.equal(r.defaultLocale, "en");
      assert.deepEqual(r.missingKeys, []);
    });
    await withProject(
      { "locales/en/common.json": EN({ hello: "Hello" }), "src/a.ts": `${IMPORT}t("common.hello");` },
      (r) => {
        assert.equal(r.localesPresent, true);
        assert.deepEqual(r.missingKeys, []);
      },
    );
  });
});

describe("i18n — a `t` that is not a translate function", () => {
  test("no i18n import means no claim, however much the code looks like i18n", async () => {
    await withProject(
      {
        "locales/en.json": EN({ hello: "Hello" }),
        "src/a.ts": `import test from "tape";\nconst t = test;\nt("some description");`,
      },
      (r) => assert.deepEqual(r.missingKeys, [], "`t` here is a test runner"),
    );
  });

  test("a file that does import i18n IS judged", async () => {
    await withProject(
      { "locales/en.json": EN({ hello: "Hello" }), "src/a.ts": `${IMPORT}t("goodbye");` },
      (r) => {
        assert.equal(r.missingKeys.length, 1);
        assert.equal(r.missingKeys[0]!.key, "goodbye");
      },
    );
  });
});

describe("i18n — missing keys", () => {
  test("a key with no entry is reported, with a suggestion when one is close", async () => {
    await withProject(
      { "locales/en.json": EN({ greeting: "Hi" }), "src/a.ts": `${IMPORT}t("greetng");` },
      (r) => {
        assert.equal(r.missingKeys.length, 1);
        assert.equal(r.missingKeys[0]!.suggestion, "greeting");
      },
    );
  });

  test("a namespaced key resolves against the bare key", async () => {
    await withProject(
      { "locales/en.json": EN({ hello: "Hello" }), "src/a.ts": `${IMPORT}t("common:hello");` },
      (r) => assert.deepEqual(r.missingKeys, []),
    );
  });

  test("plural and context suffixes resolve against the base key", async () => {
    await withProject(
      {
        "locales/en.json": EN({ item: "an item" }),
        "src/a.ts": `${IMPORT}t("item_one");\nt("item_other");\nt("item_male");`,
      },
      (r) => assert.deepEqual(r.missingKeys, []),
    );
  });

  test("a `defaultValue` renders even with no entry", async () => {
    await withProject(
      {
        "locales/en.json": EN({ hello: "Hello" }),
        "src/a.ts": `${IMPORT}t("brand.new", { defaultValue: "Brand new" });`,
      },
      (r) => assert.deepEqual(r.missingKeys, []),
    );
  });

  test("a computed key is skipped, never guessed at", async () => {
    await withProject(
      { "locales/en.json": EN({ hello: "Hello" }), "src/a.ts": `${IMPORT}const c = "x";\nt(\`errors.\${c}\`);` },
      (r) => assert.deepEqual(r.missingKeys, []),
    );
  });

  test("a namespaced file catalogue resolves under both `ns.key` and `ns:key`", async () => {
    await withProject(
      {
        "locales/en/common.json": EN({ save: "Save" }),
        "src/a.ts": `${IMPORT}t("common.save");\nt("common:save");\nt("save");`,
      },
      (r) => assert.deepEqual(r.missingKeys, []),
    );
  });

  test("nested catalogue keys are flattened to dotted paths", async () => {
    await withProject(
      {
        "locales/en.json": EN({ errors: { notFound: "Not found" } }),
        "src/a.ts": `${IMPORT}t("errors.notFound");\nt("errors.notFund");`,
      },
      (r) => {
        assert.equal(r.missingKeys.length, 1);
        assert.equal(r.missingKeys[0]!.key, "errors.notFund");
      },
    );
  });
});

describe("i18n — placeholder mismatches", () => {
  test("a renamed placeholder is reported", async () => {
    await withProject(
      {
        "locales/en.json": EN({ welcome: "Hello {{userName}}" }),
        "src/a.ts": `${IMPORT}t("welcome", { name: "Ada" });`,
      },
      (r) => {
        assert.equal(r.placeholderMismatches.length, 1);
        assert.deepEqual(r.placeholderMismatches[0]!.missing, ["userName"]);
      },
    );
  });

  test("a supplied placeholder is silent, in either syntax", async () => {
    await withProject(
      {
        "locales/en.json": EN({ a: "Hello {{name}}", b: "Bye {name}" }),
        "src/a.ts": `${IMPORT}t("a", { name: "Ada" });\nt("b", { name: "Ada" });`,
      },
      (r) => assert.deepEqual(r.placeholderMismatches, []),
    );
  });

  test("reserved i18next options are never treated as placeholders", async () => {
    // The inverse direction is deliberately NOT reported: `count`, `ns`, `lng`
    // and friends are options, and flagging them would be an instant false claim.
    await withProject(
      {
        "locales/en.json": EN({ item_other: "{{count}} items" }),
        "src/a.ts": `${IMPORT}t("item", { count: 3, ns: "common" });`,
      },
      (r) => assert.deepEqual(r.placeholderMismatches, []),
    );
  });

  test("an ICU plural carries inner tokens that are not placeholders", async () => {
    await withProject(
      {
        "locales/en.json": EN({ items: "{count, plural, one {# item} other {# items}}" }),
        "src/a.ts": `${IMPORT}t("items", { count: 3 });`,
      },
      (r) => assert.deepEqual(r.placeholderMismatches, [], "an ICU string is not compared"),
    );
  });

  test("an opaque options object is not compared", async () => {
    await withProject(
      {
        "locales/en.json": EN({ welcome: "Hello {{userName}}" }),
        "src/a.ts": `${IMPORT}const opts = { userName: "Ada" };\nt("welcome", opts);\nt("welcome", { ...opts });`,
      },
      (r) => assert.deepEqual(r.placeholderMismatches, []),
    );
  });

  test("a translation with no placeholders is never a mismatch", async () => {
    await withProject(
      { "locales/en.json": EN({ hello: "Hello" }), "src/a.ts": `${IMPORT}t("hello", { name: "Ada" });` },
      (r) => assert.deepEqual(r.placeholderMismatches, []),
    );
  });
});

describe("i18n — dead translations are never claimed", () => {
  test("a key nothing references is still not reported as unused", async () => {
    // A key is reachable from `<Trans i18nKey>`, a .vue template, a prop-drilled
    // `t`, and `$t()` nesting — none of which this can see. The action a reader
    // takes on a wrong "dead translation" is to delete copy a user sees.
    await withProject(
      { "locales/en.json": EN({ used: "u", never: "n" }), "src/a.ts": `${IMPORT}t("used");` },
      (r) => {
        assert.deepEqual(r.unusedKeys, []);
        assert.equal(r.unusedKeyDetection, "not-attempted-unreachable-by-static-analysis");
      },
    );
  });
});

describe("i18n — hardened against the adversarial hunt", () => {
  test("i18next v4 plural catalogues resolve from the bare key", async () => {
    // `item_one`/`item_other` in the JSON, `t("item")` at the call site — the
    // default layout since i18next v21. Every one of these reported missing.
    await withProject(
      {
        "locales/en.json": EN({ item_one: "{{count}} item", item_other: "{{count}} items" }),
        "src/a.ts": `${IMPORT}t("item", { count: 3 });`,
      },
      (r) => {
        assert.deepEqual(r.missingKeys, []);
        assert.deepEqual(r.placeholderMismatches, [], "`count` is i18next's own option, not an interpolation");
      },
    );
  });

  test("a STRING second argument is a default value, not an options object", async () => {
    await withProject(
      { "locales/en.json": EN({ hello: "Hello" }), "src/a.ts": `${IMPORT}t("brand.new", "Fallback text");` },
      (r) => assert.deepEqual(r.missingKeys, []),
    );
  });

  test("an explicit `ns` names a bundle this cannot resolve — abstain", async () => {
    await withProject(
      { "locales/en.json": EN({ hello: "Hello" }), "src/a.ts": `${IMPORT}t("save", { ns: "buttons" });` },
      (r) => assert.deepEqual(r.missingKeys, []),
    );
  });

  test("a `keyPrefix` file writes scoped keys, so the whole file abstains", async () => {
    await withProject(
      {
        "locales/en.json": EN({ "form.save": "Save" }),
        "src/a.ts": `import { useTranslation } from "react-i18next";\nconst { t } = useTranslation("app", { keyPrefix: "form" });\nexport const x = t("save");`,
      },
      (r) => assert.deepEqual(r.missingKeys, []),
    );
  });

  test("ordinary prose containing braces is not a placeholder", async () => {
    await withProject(
      {
        "locales/en.json": EN({ plans: "Choose a plan { basic, pro }" }),
        "src/a.ts": `${IMPORT}t("plans", {});`,
      },
      (r) => assert.deepEqual(r.placeholderMismatches, []),
    );
  });

  test("an unrelated `x.t(...)` is not a translate call", async () => {
    await withProject(
      {
        "locales/en.json": EN({ hello: "Hello" }),
        "src/a.ts": `${IMPORT}\nimport { db } from "./db.ts";\nexport const q = db.t("users");`,
      },
      (r) => assert.deepEqual(r.missingKeys, [], "`db.t` is not a translation"),
    );
  });

  test("a translation nesting `$t()` or a vue-i18n `@:link` is not compared", async () => {
    await withProject(
      {
        "locales/en.json": EN({ a: "$t(b) {{name}}", c: "@:a and {{name}}" }),
        "src/a.ts": `${IMPORT}t("a", {});\nt("c", {});`,
      },
      (r) => assert.deepEqual(r.placeholderMismatches, []),
    );
  });

  test("the most complete catalogue is the source of truth, not `en` by fiat", async () => {
    await withProject(
      {
        "locales/de.json": EN({ a: "A", b: "B", c: "C" }),
        "locales/en.json": EN({ a: "A" }),
        "src/a.ts": `${IMPORT}t("b");`,
      },
      (r) => {
        assert.equal(r.defaultLocale, "de");
        assert.deepEqual(r.missingKeys, [], "a partial English translation is not the reference");
      },
    );
  });
});

describe("i18n — determinism", () => {
  test("identical input yields identical output", async () => {
    const dir = await makeProject({
      "locales/en.json": EN({ a: "A {{x}}", b: "B" }),
      "locales/fr.json": EN({ a: "A {{x}}", b: "B" }),
      "src/one.ts": `${IMPORT}t("a", { y: 1 });`,
      "src/two.ts": `${IMPORT}t("missing");`,
    });
    try {
      const a = await buildI18nReport(dir);
      const b = await buildI18nReport(dir);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
      assert.equal(a.defaultLocale, "en", "`en` is preferred as the source of truth");
      assert.equal(a.summary.missing, 1);
      assert.equal(a.summary.mismatched, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
