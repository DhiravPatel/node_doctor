/**
 * §6 — `no-mass-assignment`.
 *
 * The whole request body written into a record, so the caller sets every column
 * the model has. The precision line is one distinction, and getting it wrong
 * cost 743 findings across 106,000 files on the first attempt: a value DERIVED
 * from the request is not the request body. An object assembled field by field
 * is the fix this rule recommends, and reporting it would punish the fix.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../../src/core/scan.ts";
import { noMassAssignment } from "../../src/diagnostics/security/no-mass-assignment.ts";

const CAPS = new Set(["node", "esm", "typescript", "express", "prisma"]);
const findings = (source: string) =>
  lintSource({ filePath: "/repo/src/routes.ts", sourceText: source, diagnostics: [noMassAssignment], capabilities: CAPS })
    .findings.filter((f) => f.diagnostic === "no-mass-assignment");

const handler = (body: string) => `app.post("/u", async (req, res) => {\n  ${body}\n});`;
const fires = (body: string) => {
  const found = findings(handler(body));
  assert.ok(found.length > 0, `expected a FIRE on:\n${body}`);
  return found;
};
const silent = (body: string): void => {
  const found = findings(handler(body));
  assert.equal(found.length, 0, `expected SILENCE, got ${found.length}:\n${body}`);
};

describe("no-mass-assignment — fires", () => {
  test("the whole body as an ORM `data` argument", () => {
    const [f] = fires(`await prisma.user.create({ data: req.body });`);
    assert.match(f!.message, /every column the model has/);
    assert.match(f!.message, /role.*ADMIN/);
    assert.match(f!.message, /Destructure/);
  });

  test("a spread is the same value by another spelling", () => {
    fires(`await prisma.user.create({ data: { ...req.body } });`);
    // `{ ...req.body, id }` still carries every attacker-settable key.
    fires(`await prisma.user.update({ data: { ...req.body, id }, where: { id } });`);
  });

  test("a DIRECT alias of the body is the body", () => {
    fires(`const body = req.body;\nawait prisma.user.create({ data: body });`);
  });

  test("every ORM's spelling of the record", () => {
    fires(`await User.create({ values: req.body });`);
    fires(`await coll.updateOne({ _id }, { $set: req.body });`);
    fires(`await repo.save(req.body);`);
  });

  test("`Object.assign` onto an existing record", () => {
    fires(`Object.assign(user, req.body);\nawait user.save();`);
  });

  test("`req.query` and `req.params` are the caller's objects too", () => {
    fires(`await prisma.user.create({ data: req.query });`);
    fires(`await prisma.user.create({ data: req.params });`);
  });
});

describe("no-mass-assignment — silent", () => {
  test("an object ASSEMBLED field by field is the fix, not the bug", () => {
    // Every one of these is real code the first version reported. The binding is
    // request-DERIVED, but it holds exactly the keys the author chose.
    silent(`const session = { id: req.body.id, is_ready: false, created_at: new Date() };\nawait mongoHelper.create(session);`);
    silent(`const updateFields = { name: req.body.name };\nawait helper.insertOne({ ...updateFields, created_at: now });`);
    silent(`const cat = { title: req.body.title };\nif (x) cat.expiry = d;\nawait categoriesHelper.create(cat);`);
  });

  test("narrowing of any kind", () => {
    silent(`const { email, name } = req.body;\nawait prisma.user.create({ data: { email, name } });`);
    silent(`await prisma.user.create({ data: schema.parse(req.body) });`);
    silent(`await prisma.user.create({ data: pick(req.body, ["email"]) });`);
    silent(`await prisma.user.create({ data: { email: req.body.email } });`);
  });

  test("a READ taking the body is a different rule's business", () => {
    // `no-nosql-object-injection` owns the query direction.
    silent(`await prisma.user.findMany({ where: req.body });`);
    silent(`await User.find(req.body);`);
  });

  test("`Object.assign` onto a fresh literal builds a value, it writes nothing", () => {
    silent(`const dto = Object.assign({}, req.body);`);
  });

  test("a value that is not the request body at all", () => {
    silent(`await prisma.user.create({ data: defaults });`);
    silent(`await prisma.user.create({ data: { role: "USER" } });`);
  });
});

describe("no-mass-assignment — TypeScript assertions are erased", () => {
  test("every assertion spelling still reaches the write", () => {
    // `req.body as UserDto` compiles to `req.body`: the assertion performs no
    // runtime check and produces the identical value. In a TypeScript codebase
    // this is the IDIOMATIC form, so missing it left the rule close to blind
    // exactly where the assertion makes the author most confident it was
    // validated. All seven spellings bypassed the first version.
    fires(`await prisma.user.create({ data: req.body as UserDto });`);
    fires(`await prisma.user.create({ data: req.body as any });`);
    fires(`await prisma.user.create({ data: req.body satisfies UserDto });`);
    fires(`await prisma.user.create({ data: req.body! });`);
    fires(`await prisma.user.create({ data: <UserDto>req.body });`);
    fires(`const b = req.body as UserDto;\nawait prisma.user.create({ data: b });`);
    fires(`await prisma.user.create({ data: { ...(req.body as UserDto) } });`);
  });

  test("an assertion is not a narrowing, but assembling still is", () => {
    // Stripping the wrapper must not undo the fix that removed 743 findings.
    silent(`const session = { id: req.body.id } as SessionDto;\nawait mongoHelper.create(session);`);
    silent(`await prisma.user.create({ data: { email: req.body.email as string } });`);
  });
});

/**
 * AdonisJS spells the body as a CALL, not a member, so `isBodyMember` never
 * matched it and the whole framework was invisible to this rule. Verified before
 * the fix: a textbook Adonis controller doing `User.create(request.all())` and
 * `user.merge(request.body())` produced ZERO findings from all 177 diagnostics.
 *
 * The accessor spellings and Lucid's `merge`/`fill` sinks are gated on the
 * `adonis` capability — `merge` and `fill` are ordinary words elsewhere, and the
 * gate is what keeps this framework's coverage from becoming another's noise.
 */
describe("no-mass-assignment — AdonisJS", () => {
  const ADONIS = new Set(["node", "esm", "typescript", "adonis"]);
  const adonisFindings = (source: string, caps: Set<string> = ADONIS) =>
    lintSource({
      filePath: "/repo/app/controllers/users_controller.ts",
      sourceText: source,
      diagnostics: [noMassAssignment],
      capabilities: caps,
    }).findings.filter((f) => f.diagnostic === "no-mass-assignment");

  const controller = (body: string) => `
    export default class UsersController {
      async store({ request, response, params }: HttpContext) {
        ${body}
      }
    }
  `;
  const adonisFires = (body: string) => {
    const found = adonisFindings(controller(body));
    assert.ok(found.length > 0, `expected a FIRE on:\n${body}`);
    return found;
  };
  const adonisSilent = (body: string): void => {
    const found = adonisFindings(controller(body));
    assert.equal(found.length, 0, `expected SILENCE, got ${found.length}:\n${body}`);
  };

  test("`request.all()` into a Lucid create", () => {
    adonisFires(`await User.create(request.all())`);
  });

  test("`request.body()` into a Lucid create", () => {
    adonisFires(`await User.create(request.body())`);
  });

  test("`request.qs()` and `request.params()` are whole objects too", () => {
    adonisFires(`await Audit.create(request.qs())`);
    adonisFires(`await Audit.create(request.params())`);
  });

  test("Lucid's `merge` and `fill` are assignment sinks", () => {
    adonisFires(`const user = await User.findOrFail(params.id)\n  user.merge(request.all())\n  await user.save()`);
    adonisFires(`const user = await User.findOrFail(params.id)\n  user.fill(request.body())\n  await user.save()`);
  });

  test("a spread of the Adonis body carries every key", () => {
    adonisFires(`await User.create({ ...request.all(), tenantId })`);
  });

  test("an alias binding is followed", () => {
    adonisFires(`const data = request.all()\n  await User.create(data)`);
  });

  test("`request.only([...])` is the fix, not the bug", () => {
    adonisSilent(`await User.create(request.only(['email', 'fullName']))`);
  });

  test("`request.except([...])` and `validateUsing` narrow too", () => {
    adonisSilent(`await User.create(request.except(['role']))`);
    adonisSilent(`const payload = await request.validateUsing(createUserValidator)\n  await User.create(payload)`);
  });

  test("`request.input(...)` is a single field, assembled by hand", () => {
    adonisSilent(`await User.create({ email: request.input('email'), fullName: request.input('fullName') })`);
  });

  test("an argument means it is not the whole-object form", () => {
    // `request.body(x)` is not Adonis's zero-argument accessor.
    adonisSilent(`await User.create(request.body(schema))`);
  });

  test("silent on a project that does not depend on Adonis", () => {
    // The gate is the point: `merge` and `fill` are ordinary words elsewhere.
    const noAdonis = new Set(["node", "esm", "typescript", "express"]);
    assert.equal(adonisFindings(controller(`await User.create(request.all())`), noAdonis).length, 0);
    assert.equal(
      adonisFindings(controller(`user.merge(request.all())`), noAdonis).length,
      0,
    );
  });

  test("`merge`/`fill` stay off the global write list", () => {
    // On an Express+Prisma project a `_.merge(cfg, req.body)` must not become a
    // mass-assignment finding just because Adonis uses the same verb.
    assert.equal(findings(handler(`_.merge(config, req.body);`)).length, 0);
  });
});

describe("no-mass-assignment — determinism", () => {
  test("identical source yields identical findings", () => {
    const source = handler(`await prisma.user.create({ data: req.body });\nawait prisma.post.create({ data: req.body });`);
    assert.equal(JSON.stringify(findings(source)), JSON.stringify(findings(source)));
    assert.equal(findings(source).length, 2);
  });
});
