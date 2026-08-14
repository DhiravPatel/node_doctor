/**
 * §14 — filters on columns the schema declares no index for.
 *
 * A fact about two files in the repository: the schema says what is indexed,
 * the query says what it filters on. Deliberately NOT a defect claim — on a
 * small table a sequential scan is correct and cheaper than an index, and
 * nothing in either file says how many rows there are. Reported so somebody who
 * knows the table size can decide, like the licence section of `supply-chain`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePrismaSchema } from "../../src/core/prisma-schema.ts";
import { buildSchemaDriftReport } from "../../src/core/schema-drift.ts";

const SCHEMA = `
model User {
  id        String   @id
  email     String   @unique
  tenantId  String
  status    String
  createdAt DateTime
  name      String
  posts     Post[]
  @@index([tenantId, status])
}
model Post {
  id       String @id
  slug     String
  authorId String
  @@unique([authorId, slug])
}
`;

const run = async (source: string) => {
  const dir = await mkdtemp(join(tmpdir(), "nd-idx-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.0.0" }));
    await mkdir(join(dir, "prisma"), { recursive: true });
    await writeFile(join(dir, "prisma", "schema.prisma"), SCHEMA);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "q.ts"), source);
    const report = await buildSchemaDriftReport(dir);
    return report.unindexedFilters.map((f) => `${f.model}.${f.field}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("the parser retains what is actually indexed", () => {
  test("field-level `@id`/`@unique`, plus the LEADING field of each block attribute", () => {
    const { models } = parsePrismaSchema([SCHEMA]);
    const user = models.find((m) => m.name === "User")!;
    assert.deepEqual(user.indexedFields, ["email", "id", "tenantId"]);
  });

  test("the leftmost-prefix rule: a composite covers its FIRST column only", () => {
    // `@@unique([authorId, slug])` serves a filter on `authorId` and does not
    // serve one on `slug` alone. Listing `slug` would license the scan this
    // exists to find.
    const { models } = parsePrismaSchema([SCHEMA]);
    const post = models.find((m) => m.name === "Post")!;
    assert.deepEqual(post.indexedFields, ["authorId", "id"]);
    assert.ok(!post.indexedFields.includes("slug"));
  });
});

describe("unindexed filters — reported", () => {
  test("a column with no index at all", async () => {
    assert.deepEqual(await run(`export const a = () => prisma.user.findMany({ where: { createdAt: { gt: since } } });`), [
      "User.createdAt",
    ]);
  });

  test("a column that is in a composite but not its leading field", async () => {
    // `status` is the second field of `@@index([tenantId, status])`.
    assert.deepEqual(await run(`export const a = () => prisma.user.findMany({ where: { status: "active" } });`), [
      "User.status",
    ]);
    assert.deepEqual(await run(`export const a = () => prisma.post.findMany({ where: { slug: "x" } });`), ["Post.slug"]);
  });

  test("each distinct site is one decision", async () => {
    const found = await run(
      `export const a = () => prisma.user.findMany({ where: { status: "a" } });\nexport const b = () => prisma.user.findMany({ where: { name: "n" } });`,
    );
    assert.deepEqual(found, ["User.status", "User.name"]);
  });
});

describe("unindexed filters — silent", () => {
  test("an indexed column, however it is declared", async () => {
    assert.deepEqual(await run(`export const a = () => prisma.user.findUnique({ where: { id: "1" } });`), []);
    assert.deepEqual(await run(`export const a = () => prisma.user.findUnique({ where: { email: "e" } });`), []);
    // The LEADING field of the composite really is covered.
    assert.deepEqual(await run(`export const a = () => prisma.user.findMany({ where: { tenantId: "t" } });`), []);
    assert.deepEqual(await run(`export const a = () => prisma.post.findMany({ where: { authorId: "u" } });`), []);
  });

  test("a RELATION key is a join, which is a different question", async () => {
    assert.deepEqual(await run(`export const a = () => prisma.user.findMany({ where: { posts: { some: { slug: "x" } } } });`), [
      // The nested `slug` is still a filter on Post and is reported; the
      // relation key `posts` itself is not.
      "Post.slug",
    ]);
  });

  test("a section that is not `where`", async () => {
    assert.deepEqual(await run(`export const a = () => prisma.user.findMany({ select: { status: true }, orderBy: { name: "asc" } });`), []);
  });
});

describe("unindexed filters — determinism", () => {
  test("identical input yields identical output", async () => {
    const src = `export const a = () => prisma.user.findMany({ where: { status: "a" } });`;
    assert.deepEqual(await run(src), await run(src));
  });
});
