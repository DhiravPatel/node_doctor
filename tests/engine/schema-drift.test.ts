/**
 * §142 — Dead Schema & Schema Drift.
 *
 * Covers the Prisma schema parser (models, @@map/@map, relations, compound
 * aliases, enums), unknown-field drift across every argument section (with
 * operators, relation traversal, and compound keys understood), the opaqueness
 * bail-outs (spread/computed keys), dead-model detection and its two proof
 * gates (dynamic access, unresolved raw SQL), raw-SQL usage crediting, and the
 * determinism invariant.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePrismaSchema } from "../../src/core/prisma-schema.ts";
import { buildSchemaDriftReport, type SchemaDriftReport } from "../../src/core/schema-drift.ts";

const makeProject = async (files: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-schema-"));
  for (const [rel, src] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, src);
  }
  return dir;
};

const SCHEMA = `
generator client { provider = "prisma-client-js" }

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?  // display name
  createdAt DateTime @default(now()) @map("created_at")
  posts     Post[]
  @@map("users")
}

model Post {
  id       Int    @id
  title    String
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
  @@unique([authorId, title])
}

model AuditLog {
  id      Int    @id
  message String
}

enum Role {
  ADMIN
  MEMBER
}
`;

describe("parsePrismaSchema", () => {
  const schema = parsePrismaSchema([SCHEMA]);

  test("models, client properties, and table names", () => {
    assert.deepEqual(
      schema.models.map((m) => m.name),
      ["User", "Post", "AuditLog"],
    );
    const user = schema.models[0]!;
    assert.equal(user.clientProperty, "user");
    assert.equal(user.tableName, "users"); // @@map
    assert.equal(schema.models[1]!.tableName, "Post"); // no @@map
  });

  test("fields with @map, optionality, lists, and relations", () => {
    const user = schema.models[0]!;
    const byName = Object.fromEntries(user.fields.map((f) => [f.name, f]));
    assert.equal(byName["createdAt"]!.columnName, "created_at");
    assert.equal(byName["name"]!.isOptional, true);
    assert.equal(byName["posts"]!.isList, true);
    assert.equal(byName["posts"]!.isRelation, true, "type Post[] is a relation");
    assert.equal(byName["email"]!.isRelation, false);
    const post = schema.models[1]!;
    const author = post.fields.find((f) => f.name === "author")!;
    assert.equal(author.isRelation, true, "@relation side");
  });

  test("compound where-unique aliases from @@unique", () => {
    assert.deepEqual(schema.models[1]!.compoundAliases, ["authorId_title"]);
  });

  test("enums", () => {
    assert.deepEqual(schema.enums, [{ name: "Role", values: ["ADMIN", "MEMBER"] }]);
  });

  test("a // comment never hides or invents a field", () => {
    const s = parsePrismaSchema([`model X { id Int @id\n// ghost String\nreal String }`]);
    assert.deepEqual(
      s.models[0]!.fields.map((f) => f.name),
      ["id", "real"],
    );
  });
});

describe("buildSchemaDriftReport — drift", () => {
  test("an unknown where-key is drift, with a did-you-mean suggestion", async () => {
    const dir = await makeProject({
      "prisma/schema.prisma": SCHEMA,
      "src/app.ts": `await prisma.user.findMany({ where: { emial: x } });`,
    });
    try {
      const r = await buildSchemaDriftReport(dir);
      assert.equal(r.drift.length, 1);
      assert.equal(r.drift[0]!.model, "User");
      assert.equal(r.drift[0]!.key, "emial");
      assert.equal(r.drift[0]!.section, "where");
      assert.equal(r.drift[0]!.suggestion, "email");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("operators, relation traversal, compound aliases, and nested writes are understood", async () => {
    const dir = await makeProject({
      "prisma/schema.prisma": SCHEMA,
      "src/app.ts": `
        await prisma.user.findFirst({ where: { AND: [{ email: e }, { posts: { some: { title: "x" } } }] } });
        await prisma.post.findUnique({ where: { authorId_title: { authorId: 1, title: "t" } } });
        await prisma.user.update({ where: { email: e }, data: { name: "n", posts: { create: { id: 1, title: "t", authorId: 2 } } } });
        await prisma.user.findMany({ select: { email: true, posts: { select: { title: true } } }, orderBy: { createdAt: "desc" } });
        await prisma.post.groupBy({ by: ["authorId"], _count: { title: true } });
        await prisma.user.aggregate({ _max: { createdAt: true } });
      `,
    });
    try {
      const r = await buildSchemaDriftReport(dir);
      assert.deepEqual(r.drift, [], JSON.stringify(r.drift));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("drift inside a relation traversal is attributed to the RELATED model", async () => {
    const dir = await makeProject({
      "prisma/schema.prisma": SCHEMA,
      "src/app.ts": `await prisma.user.findFirst({ where: { posts: { some: { titel: "x" } } } });`,
    });
    try {
      const r = await buildSchemaDriftReport(dir);
      assert.equal(r.drift.length, 1);
      assert.equal(r.drift[0]!.model, "Post");
      assert.equal(r.drift[0]!.key, "titel");
      assert.equal(r.drift[0]!.suggestion, "title");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a spread or computed key silences the whole object (no guessing)", async () => {
    const dir = await makeProject({
      "prisma/schema.prisma": SCHEMA,
      "src/app.ts": `
        await prisma.user.findMany({ where: { ...extra, emial: 1 } });
        await prisma.user.findMany({ where: { [key]: 1, emialx: 2 } });
      `,
    });
    try {
      const r = await buildSchemaDriftReport(dir);
      assert.deepEqual(r.drift, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a non-db receiver with a model-shaped property is not a Prisma call", async () => {
    const dir = await makeProject({
      "prisma/schema.prisma": SCHEMA,
      "src/app.ts": `await cache.user.findMany({ where: { emial: x } });`,
    });
    try {
      const r = await buildSchemaDriftReport(dir);
      assert.deepEqual(r.drift, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("select/orderBy drift in one call reports each unknown key once", async () => {
    const dir = await makeProject({
      "prisma/schema.prisma": SCHEMA,
      "src/app.ts": `await prisma.post.findMany({ select: { titel: true }, orderBy: { createdAtx: "desc" } });`,
    });
    try {
      const r = await buildSchemaDriftReport(dir);
      assert.deepEqual(
        r.drift.map((d) => `${d.model}.${d.key}:${d.section}`).sort(),
        ["Post.createdAtx:orderBy", "Post.titel:select"],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildSchemaDriftReport — dead models", () => {
  test("an untouched model is dead when detection is provable", async () => {
    const dir = await makeProject({
      "prisma/schema.prisma": SCHEMA,
      "src/app.ts": `
        await prisma.user.findMany();
        await prisma.post.create({ data: { id: 1, title: "t", authorId: 1 } });
      `,
    });
    try {
      const r = await buildSchemaDriftReport(dir);
      assert.equal(r.deadModelDetection, "full");
      assert.deepEqual(
        r.deadModels.map((d) => d.model),
        ["AuditLog"],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("dynamic model access (client[expr]) suppresses dead-model claims", async () => {
    const dir = await makeProject({
      "prisma/schema.prisma": SCHEMA,
      "src/app.ts": `
        await prisma.user.findMany();
        const model = pick();
        await prisma[model].deleteMany();
      `,
    });
    try {
      const r = await buildSchemaDriftReport(dir);
      assert.equal(r.deadModelDetection, "skipped-dynamic-access");
      assert.deepEqual(r.deadModels, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unresolved raw SQL suppresses dead-model claims", async () => {
    const dir = await makeProject({
      "prisma/schema.prisma": SCHEMA,
      "src/app.ts": `
        await prisma.user.findMany();
        await db.query("SELECT * FROM " + tableName);
      `,
    });
    try {
      const r = await buildSchemaDriftReport(dir);
      assert.equal(r.deadModelDetection, "skipped-unresolved-raw-sql");
      assert.deepEqual(r.deadModels, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a resolved raw-SQL table (via @@map) credits the model as used", async () => {
    const dir = await makeProject({
      "prisma/schema.prisma": SCHEMA,
      "src/app.ts": `
        await prisma.post.findMany();
        await prisma.auditLog.create({ data: { id: 1, message: "m" } });
        await db.query("SELECT * FROM users WHERE id = $1");
      `,
    });
    try {
      const r = await buildSchemaDriftReport(dir);
      assert.equal(r.deadModelDetection, "full");
      // users (@@map of User) is credited via raw SQL — no dead models at all.
      assert.deepEqual(r.deadModels, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an aliased or destructured model handle credits the model as used", async () => {
    const dir = await makeProject({
      "prisma/schema.prisma": SCHEMA,
      "src/app.ts": `
        const audit = prisma.auditLog;
        export const log = (m) => audit.create({ data: { id: 1, message: m } });
        const { post } = prisma;
        export const posts = () => post.findMany();
        export const users = () => prisma.user.findMany();
      `,
    });
    try {
      const r = await buildSchemaDriftReport(dir);
      assert.equal(r.deadModelDetection, "full");
      assert.deepEqual(r.deadModels, [], "aliased models are used, never dead");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an ASSIGNMENT alias (u = prisma.auditLog) credits the model", async () => {
    const dir = await makeProject({
      "prisma/schema.prisma": SCHEMA,
      "src/app.ts": `
        let u;
        u = prisma.auditLog;
        export const logs = () => u.findMany();
        export const users = () => prisma.user.findMany();
        export const posts = () => prisma.post.findMany();
      `,
    });
    try {
      const r = await buildSchemaDriftReport(dir);
      assert.equal(r.deadModelDetection, "full");
      assert.deepEqual(r.deadModels, [], "an assigned handle reaches the table at runtime");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a $extends client under a hint-free name still counts as Prisma", async () => {
    const dir = await makeProject({
      "prisma/schema.prisma": SCHEMA,
      "src/app.ts": `
        const enhanced = prisma.$extends({ name: "soft-delete" });
        export const logs = () => enhanced.auditLog.findMany();
        export const users = () => prisma.user.findMany();
        export const posts = () => prisma.post.findMany();
      `,
    });
    try {
      const r = await buildSchemaDriftReport(dir);
      assert.equal(r.deadModelDetection, "full");
      assert.deepEqual(r.deadModels, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a relation traversal credits the RELATED model (include reads it; nested create writes it)", async () => {
    const dir = await makeProject({
      "prisma/schema.prisma": SCHEMA,
      "src/app.ts": `
        export const users = () => prisma.user.findMany({ include: { posts: true } });
        export const audit = () => prisma.auditLog.findMany();
      `,
    });
    try {
      const r = await buildSchemaDriftReport(dir);
      assert.equal(r.deadModelDetection, "full");
      assert.deepEqual(r.deadModels, [], "Post is read by the include — dropping it would break the code");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no schema → an explicitly empty report", async () => {
    const dir = await makeProject({ "src/app.ts": `await prisma.user.findMany();` });
    try {
      const r = await buildSchemaDriftReport(dir);
      assert.equal(r.schemaPresent, false);
      assert.deepEqual(r.drift, []);
      assert.deepEqual(r.deadModels, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildSchemaDriftReport — determinism", () => {
  test("identical input yields byte-identical JSON across runs", async () => {
    const dir = await makeProject({
      "prisma/schema.prisma": SCHEMA,
      "src/app.ts": `await prisma.user.findMany({ where: { emial: x } });`,
    });
    try {
      const a: SchemaDriftReport = await buildSchemaDriftReport(dir);
      const b: SchemaDriftReport = await buildSchemaDriftReport(dir);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
