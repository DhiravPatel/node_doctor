import { describe, test } from "node:test";
import { expectFires, expectSilent } from "../helpers.ts";

const ID = "no-cross-request-state-mutation";

describe(ID, () => {
  // --- fires -------------------------------------------------------------

  test("fires: canonical `currentUser = req.user` in an Express handler", () => {
    expectFires(
      ID,
      `let currentUser;
       app.get("/me", (req, res) => {
         currentUser = req.user;
         res.json(buildProfile());
       });`,
    );
  });

  test("fires: caller data laundered through a local first", () => {
    expectFires(
      ID,
      `let lastOrder;
       app.post("/orders", (req, res) => {
         const { orderId } = req.body;
         lastOrder = orderId;
         res.end();
       });`,
    );
  });

  test("fires: `var` module state is just as shared as `let`", () => {
    expectFires(
      ID,
      `var activeTenant;
       app.get("/t", (req, res) => {
         activeTenant = req.headers["x-tenant"];
         res.end();
       });`,
    );
  });

  test("fires: `??=` lazy store of caller data is still a bleed", () => {
    expectFires(
      ID,
      `let tenant;
       app.get("/t", (req, res) => {
         tenant ??= req.headers["x-tenant"];
         res.end();
       });`,
    );
  });

  test("fires: `||=` store of caller data", () => {
    expectFires(
      ID,
      `let locale;
       app.use((req, res, next) => {
         locale = locale || req.query.lang;
         next();
       });`,
    );
  });

  test("fires: inside a nested callback within the handler", () => {
    expectFires(
      ID,
      `let cachedUser;
       app.get("/row", (req, res) => {
         db.find(req.params.id, (err, row) => {
           cachedUser = req.user;
           res.json(row);
         });
       });`,
    );
  });

  test("fires: split-file controller detected by its (req, res) signature", () => {
    expectFires(
      ID,
      `let requestedId;
       export async function getUser(req, res) {
         requestedId = req.params.id;
         res.json(await load(requestedId));
       }`,
    );
  });

  test("fires: fastify object-route handler", () => {
    expectFires(
      ID,
      `let lastBody;
       fastify.route({
         method: "POST",
         url: "/x",
         handler: async (request, reply) => {
           lastBody = request.body;
           reply.send("ok");
         },
       });`,
    );
  });

  test("fires: module-scope `let` reused as a per-tenant singleton", () => {
    expectFires(
      ID,
      `let db;
       app.get("/rows", async (req, res) => {
         db = db || createClient(req.tenantId);
         res.json(await db.rows());
       });`,
    );
  });

  // --- silent: the correct patterns --------------------------------------

  test("silent: assignment to a handler-local variable", () => {
    expectSilent(
      ID,
      `app.get("/me", (req, res) => {
         let currentUser;
         currentUser = req.user;
         res.json(currentUser);
       });`,
    );
  });

  test("silent: a handler-local shadows the module binding", () => {
    expectSilent(
      ID,
      `let currentUser = null;
       app.get("/me", (req, res) => {
         let currentUser;
         currentUser = req.user;
         res.json(currentUser);
       });`,
    );
  });

  test("silent: module-scope bootstrap assignment", () => {
    expectSilent(
      ID,
      `let config;
       config = loadConfig(process.env.CONFIG_PATH);
       app.get("/health", (req, res) => { res.json(config); });`,
    );
  });

  test("silent: module-scope `const` Map cache (no-unbounded-module-cache owns this)", () => {
    expectSilent(
      ID,
      `const sessionCache = new Map();
       app.post("/login", (req, res) => {
         sessionCache.set(req.body.token, req.body.user);
         res.end();
       });`,
    );
  });

  test("silent: property writes on req/res are request-scoped", () => {
    expectSilent(
      ID,
      `app.use((req, res, next) => {
         req.user = req.headers["x-user"];
         res.locals.requestId = req.id;
         next();
       });`,
    );
  });

  test("silent: property write on `this` is instance-scoped", () => {
    expectSilent(
      ID,
      `export class UserController {
         handle(req, res) {
           this.current = req.user;
           res.end();
         }
       }`,
    );
  });

  test("silent: a plain counter increment", () => {
    expectSilent(
      ID,
      `let requestCount = 0;
       app.get("/x", (req, res) => {
         requestCount++;
         requestCount = requestCount + 1;
         res.json({ requestCount });
       });`,
    );
  });

  test("silent: timestamp / clock write carries no caller data", () => {
    expectSilent(
      ID,
      `let lastSeenAt;
       app.get("/x", (req, res) => {
         lastSeenAt = Date.now();
         res.end();
       });`,
    );
  });

  test("silent: a literal flag flip is not a data bleed", () => {
    expectSilent(
      ID,
      `let warmed = false;
       app.get("/x", (req, res) => {
         warmed = true;
         res.end();
       });`,
    );
  });

  test("silent: lazy singleton built from config, not from the caller", () => {
    expectSilent(
      ID,
      `let client;
       app.get("/x", async (req, res) => {
         if (!client) client = await connect(process.env.DB_URL);
         res.json(await client.ping());
       });`,
    );
  });

  test("silent: `+=` accumulator is a memory shape, not a bleed", () => {
    expectSilent(
      ID,
      `let total = 0;
       app.post("/pay", (req, res) => {
         total += req.body.amount;
         res.json({ total });
       });`,
    );
  });

  test("silent: caller data stored outside any request handler", () => {
    expectSilent(
      ID,
      `let seed;
       export function configure(req) {
         seed = req.seed;
       }`,
    );
  });

  test("silent: background timer writing module state", () => {
    expectSilent(
      ID,
      `let lastTick;
       setInterval(() => { lastTick = Date.now(); }, 1000);`,
    );
  });

  test("silent: closure state inside a handler factory is function-scoped", () => {
    expectSilent(
      ID,
      `export function makeHandler() {
         let state;
         return (req, res) => {
           state = req.user;
           res.json(state);
         };
       }`,
    );
  });

  test("silent: module state copied from other module state", () => {
    expectSilent(
      ID,
      `let active;
       const defaults = { mode: "fast" };
       app.get("/x", (req, res) => {
         active = defaults.mode;
         res.end();
       });`,
    );
  });

  test("silent: a fixed member key must not be read as a tainted binding", () => {
    expectSilent(
      ID,
      `let selected;
       const defaults = { id: 1 };
       app.get("/a", (req, res) => {
         const id = req.params.id;
         res.json({ id });
       });
       app.get("/b", (req, res) => {
         selected = defaults.id;
         res.end();
       });`,
    );
  });

  test("silent: a callback result that never touches the caller", () => {
    expectSilent(
      ID,
      `let lastRow;
       app.get("/row", (req, res) => {
         db.find("fixed-key", (err, row) => {
           lastRow = row;
           res.json(row);
         });
       });`,
    );
  });

  test("silent: same-named local in another handler must not inherit taint", () => {
    expectSilent(
      ID,
      `let selectedId;
       const DEFAULTS = { id: 1 };
       app.get("/a", (req, res) => {
         const id = req.params.id;
         res.json({ id });
       });
       app.get("/b", (req, res) => {
         const id = DEFAULTS.id;
         selectedId = id;
         res.end();
       });`,
    );
  });

  test("silent: a module-level `const context` is not the request context", () => {
    expectSilent(
      ID,
      `let banner;
       const context = { name: "app" };
       app.get("/x", (req, res) => {
         banner = context.name;
         res.end();
       });`,
    );
  });

  test("silent: destructuring assignment is not claimed", () => {
    expectSilent(
      ID,
      `let a, b;
       app.get("/x", (req, res) => {
         ({ a, b } = { a: 1, b: 2 });
         res.end();
       });`,
    );
  });

  test("silent: undeclared target — no binding, no guess", () => {
    expectSilent(
      ID,
      `app.get("/x", (req, res) => {
         globalThis.current = req.user;
         res.end();
       });`,
    );
  });

  // --- silent: a binding we cannot confirm never inherits a same *name*'s taint.
  // The taint set is file-wide and keyed by name; each of these is a different
  // binding that merely shares a name with a caller-derived one elsewhere.

  test("silent: a `catch` parameter is not caller data", () => {
    expectSilent(
      ID,
      `let lastError;
       app.get("/a", (req, res) => { const err = req.query.err; res.json(err); });
       app.get("/b", (req, res) => {
         try { doThing(); } catch (err) { lastError = err; }
         res.end();
       });`,
    );
  });

  test("silent: a for-of loop variable over a module constant", () => {
    expectSilent(
      ID,
      `let selected;
       const CATALOG = ["a", "b"];
       app.get("/a", (req, res) => { const item = req.body.item; res.json(item); });
       app.get("/b", (req, res) => {
         for (const item of CATALOG) { selected = item; }
         res.end();
       });`,
    );
  });

  test("silent: an ordinary callback parameter is not the request", () => {
    expectSilent(
      ID,
      `let last;
       const items = [1, 2, 3];
       app.post("/a", (req, res) => { const value = req.body.value; save(value); res.end(); });
       app.get("/b", (req, res) => {
         items.forEach((value) => { last = value; });
         res.end();
       });`,
    );
  });

  test("silent: a declared-but-unassigned local filled from a constant", () => {
    expectSilent(
      ID,
      `let mode;
       app.get("/a", (req, res) => { const flag = req.query.flag; res.json(flag); });
       app.get("/b", (req, res) => {
         let flag;
         flag = "off";
         mode = flag;
         res.end();
       });`,
    );
  });

  test("silent: a default parameter value is not caller data", () => {
    expectSilent(
      ID,
      `let cur;
       app.get("/a", (req, res) => { const limit = req.query.limit; res.json(limit); });
       app.get("/b", (req, res) => {
         function paginate(limit = 10) { cur = limit; }
         paginate();
         res.end();
       });`,
    );
  });

  test("silent: an emitter callback named `event` inside a handler is not the request", () => {
    expectSilent(
      ID,
      `let lastEvent;
       app.get("/x", (req, res) => {
         emitter.on("tick", (event) => { lastEvent = event; });
         res.end();
       });`,
    );
  });

  test("silent: a `context` callback parameter that is not a handler parameter", () => {
    expectSilent(
      ID,
      `let current;
       app.get("/x", (req, res) => {
         withContext((context) => { current = context.tenant; });
         res.end();
       });`,
    );
  });

  test("silent: an import whose local name collides with a tainted name", () => {
    expectSilent(
      ID,
      `import { request } from "node:http";
       let cur;
       app.get("/x", (req, res) => { cur = request; res.end(); });`,
    );
  });

  test("silent: value is a closure over the request, not the request data", () => {
    expectSilent(
      ID,
      `let cur;
       app.get("/x", (req, res) => { cur = () => req.user; res.end(); });`,
    );
  });

  test("silent: a fixed object key named `req` is not a request read", () => {
    expectSilent(
      ID,
      `let cur;
       const shape = { req: 1 };
       app.get("/x", (req, res) => { cur = shape.req; res.end(); });`,
    );
  });

  test("silent: non-storing compound operators (`|=`, `**=`)", () => {
    expectSilent(
      ID,
      `let flags = 0;
       let scale = 1;
       app.post("/x", (req, res) => {
         flags |= req.body.flags;
         scale **= req.body.n;
         res.end();
       });`,
    );
  });

  test("silent: a mutual-initializer cycle must terminate, not fire", () => {
    expectSilent(
      ID,
      `let cur;
       app.get("/x", (req, res) => {
         let a = b, b = a;
         cur = a;
         res.end();
       });`,
    );
  });

  // --- fires: laundering must still be followed --------------------------

  test("fires: caller data laundered through four hops", () => {
    expectFires(
      ID,
      `let cur;
       app.get("/x", (req, res) => {
         const a = req.body;
         const b = a;
         const c = b;
         cur = c;
         res.end();
       });`,
    );
  });

  test("fires: template literal interpolating caller data", () => {
    expectFires(
      ID,
      `let cacheKey;
       app.get("/x", (req, res) => {
         cacheKey = \`u:\${req.user.id}\`;
         res.end();
       });`,
    );
  });

  test("fires: awaited value derived from the request body", () => {
    expectFires(
      ID,
      `let cur;
       app.post("/x", async (req, res) => {
         cur = await parse(req.body);
         res.end();
       });`,
    );
  });

  test("fires: a nested named function declaration inside the handler", () => {
    expectFires(
      ID,
      `var cur;
       app.get("/x", (req, res) => {
         function inner() { cur = req.user; }
         inner();
         res.end();
       });`,
    );
  });

  // The value walker is seeded with the assigned expression itself, unlike
  // `findDescendant`, which never tests its root. These two are exactly the
  // shapes that a root-skipping walker would silently miss.
  test("fires: the whole request object stored directly (value IS the root)", () => {
    expectFires(
      ID,
      `let cur;
       app.get("/x", (req, res) => { cur = req; res.end(); });`,
    );
  });

  test("fires: a bare tainted local stored directly (value IS the root)", () => {
    expectFires(
      ID,
      `let cur;
       app.get("/x", (req, res) => { const u = req.user; cur = u; res.end(); });`,
    );
  });

  test("fires: Nest decorator handler", () => {
    expectFires(
      ID,
      `let cur;
       class UserController {
         @Get()
         find(req) { cur = req.user; }
       }`,
    );
  });
});
