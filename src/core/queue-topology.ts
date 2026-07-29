/**
 * §157 — Queue & Topic Topology Mapping (`node-doctor queues`).
 *
 * §29 checks a consumer in isolation; this maps the GRAPH: who publishes to each
 * topic/queue, who consumes it, and what falls out of that — orphan topics with a
 * publisher and no consumer (messages into the void), consumers subscribed to
 * topics nothing publishes (dead code that looks alive), and same-topic
 * publish+consume loops (rendered, never judged — a worker re-enqueueing retries
 * is legitimate). The event-driven equivalent of the import graph.
 *
 * PRECISION MODEL (every lesson from the adversarial hunts applied up front):
 *  - Every system is IMPORT-GATED per file. `publish`/`subscribe`/`send` are
 *    generic method names; a file yields Kafka facts only if it imports
 *    `kafkajs`, Rabbit facts only under `amqplib`, and so on. A receiver merely
 *    named like a client never counts.
 *  - A topic is recorded only when it is a STATIC string. A dynamic topic is
 *    counted (`unresolvedPublishes`/`unresolvedSubscribes`) and DEGRADES the
 *    claims it could hide: any unresolved publish suppresses dead-consumer
 *    claims, any unresolved subscribe suppresses orphan-topic claims. The map
 *    itself always renders.
 *  - Bull's single `Queue` is both producer and consumer, so a bare
 *    `new Queue("x")` from `bull` claims nothing — only a same-file `.add(…)` /
 *    `.process(…)` on that binding classifies it. BullMQ's split classes are
 *    unambiguous (`Queue` enqueues, `Worker` consumes) and classify on
 *    construction.
 *
 * Recognized systems (all offline, static-string topics only):
 *   kafkajs   producer.send({ topic }) / sendBatch({ topicMessages }) /
 *             consumer.subscribe({ topic | topics: [...] })
 *   amqplib   channel.sendToQueue("q") / channel.publish("exchange", …) /
 *             channel.consume("q", cb)
 *   bullmq    new Queue("x") [publish] / new Worker("x", fn) [consume]
 *   bull      new Queue("x") + same-file .add → publish / .process → consume
 *   nats      nc.publish("subj") / nc.subscribe("subj")
 *   mqtt      client.publish("t") / client.subscribe("t")
 *   redis     <pub/sub-ish receiver>.publish("ch") / .subscribe("ch")
 *             (ioredis/redis import + a pub/sub-suggestive receiver name)
 *
 * Deterministic: files sorted, topics sorted, sites ordered (file, line).
 */

import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";

import type { AstNode } from "./types.ts";
import type { NodeDoctorConfig } from "./config.ts";
import { getMethodName, getStaticStringValue, getObjectProperty, getCalleeName } from "./ast.ts";
import { collectDescendants, attachParents } from "./walk.ts";
import { parseSource } from "./parse.ts";
import { createLocator } from "./location.ts";
import { BUILTIN_IGNORES } from "./config.ts";
import { mapPool } from "./pool.ts";

// ---------------------------------------------------------------------------
// Public shape.
// ---------------------------------------------------------------------------

export type QueueSystem = "kafka" | "rabbitmq" | "bullmq" | "bull" | "nats" | "mqtt" | "redis";

export interface TopologySite {
  normalizedFilePath: string;
  line: number;
}

export interface TopicEntry {
  name: string;
  system: QueueSystem;
  publishers: TopologySite[];
  consumers: TopologySite[];
}

export interface QueueTopologyReport {
  topics: TopicEntry[];
  /** Published, never consumed — messages into the void. Empty when unprovable. */
  orphanTopics: string[];
  /** Consumed, never published — dead code that looks alive. Empty when unprovable. */
  deadConsumers: string[];
  /** A single FILE both consumes and publishes the same topic — the re-enqueue /
   *  feedback shape. Rendered as info, never judged (retry re-enqueues are legit). */
  loops: string[];
  unresolvedPublishes: number;
  unresolvedSubscribes: number;
  /** Why orphan/dead claims were suppressed, when they were. */
  claimQuality: {
    orphanTopics: "full" | "suppressed-unresolved-subscribe";
    deadConsumers: "full" | "suppressed-unresolved-publish";
  };
  summary: {
    filesScanned: number;
    topics: number;
    publishers: number;
    consumers: number;
  };
}

// ---------------------------------------------------------------------------
// Import gating.
// ---------------------------------------------------------------------------

interface FileImports {
  kafka: boolean;
  amqp: boolean;
  bullmq: boolean;
  bull: boolean;
  nats: boolean;
  mqtt: boolean;
  redis: boolean;
  /** Local names bound to bullmq's Queue / Worker / bull's default Queue. */
  bullmqQueueNames: Set<string>;
  bullmqWorkerNames: Set<string>;
  bullQueueNames: Set<string>;
  /** Local names of each library's ROOT import (`mqtt` in `import mqtt from "mqtt"`,
   *  `Kafka`/`connect`/`Redis`/`createClient`/`amqp` — whatever the entry point is). */
  kafkaCtorNames: Set<string>;
  amqpRootNames: Set<string>;
  natsConnectNames: Set<string>;
  mqttRootNames: Set<string>;
  redisCtorNames: Set<string>;
}

const collectImports = (program: AstNode): FileImports => {
  const imports: FileImports = {
    kafka: false,
    amqp: false,
    bullmq: false,
    bull: false,
    nats: false,
    mqtt: false,
    redis: false,
    bullmqQueueNames: new Set(),
    bullmqWorkerNames: new Set(),
    bullQueueNames: new Set(),
    kafkaCtorNames: new Set(),
    amqpRootNames: new Set(),
    natsConnectNames: new Set(),
    mqttRootNames: new Set(),
    redisCtorNames: new Set(),
  };
  const named = (specifiers: AstNode[] | null, want: string): string | null => {
    for (const s of specifiers ?? []) {
      if (s.type !== "ImportSpecifier") continue;
      if (((s.imported as AstNode | undefined)?.name as string | undefined) === want) {
        return ((s.local as AstNode | undefined)?.name as string | undefined) ?? null;
      }
    }
    return null;
  };
  const mark = (source: string, specifiers: AstNode[] | null, defaultLocal: string | null): void => {
    if (source === "kafkajs") {
      imports.kafka = true;
      const k = named(specifiers, "Kafka");
      if (k) imports.kafkaCtorNames.add(k);
    } else if (source === "amqplib" || source === "amqplib/callback_api") {
      imports.amqp = true;
      if (defaultLocal) imports.amqpRootNames.add(defaultLocal);
      const c = named(specifiers, "connect");
      if (c) imports.amqpRootNames.add(c);
    } else if (source === "nats") {
      imports.nats = true;
      const c = named(specifiers, "connect");
      if (c) imports.natsConnectNames.add(c);
      if (defaultLocal) imports.natsConnectNames.add(defaultLocal);
    } else if (source === "mqtt" || source === "async-mqtt") {
      imports.mqtt = true;
      if (defaultLocal) imports.mqttRootNames.add(defaultLocal);
      const c = named(specifiers, "connect");
      if (c) imports.mqttRootNames.add(c);
    } else if (source === "redis" || source === "ioredis") {
      imports.redis = true;
      if (defaultLocal) imports.redisCtorNames.add(defaultLocal);
      const c = named(specifiers, "createClient");
      if (c) imports.redisCtorNames.add(c);
    } else if (source === "bullmq") {
      imports.bullmq = true;
      for (const s of specifiers ?? []) {
        if (s.type !== "ImportSpecifier") continue;
        const imported = (s.imported as AstNode | undefined)?.name as string | undefined;
        const local = (s.local as AstNode | undefined)?.name as string | undefined;
        if (imported === "Queue" && local) imports.bullmqQueueNames.add(local);
        if (imported === "Worker" && local) imports.bullmqWorkerNames.add(local);
      }
    } else if (source === "bull") {
      imports.bull = true;
      if (defaultLocal) imports.bullQueueNames.add(defaultLocal);
    }
  };

  for (const stmt of (program.body as AstNode[] | undefined) ?? []) {
    if (stmt.type === "ImportDeclaration" && typeof stmt.source?.value === "string") {
      const specifiers = (stmt.specifiers as AstNode[] | undefined) ?? [];
      const def = specifiers.find((s) => s.type === "ImportDefaultSpecifier");
      mark(
        stmt.source.value,
        specifiers,
        def ? (((def as AstNode).local as AstNode | undefined)?.name as string | undefined) ?? null : null,
      );
    }
  }
  // const Queue = require("bull") / const { Queue, Worker } = require("bullmq")
  for (const decl of collectDescendants(program, (n) => n.type === "VariableDeclarator", undefined, true)) {
    const init = decl.init as AstNode | undefined;
    if (
      init?.type !== "CallExpression" ||
      (init.callee as AstNode)?.type !== "Identifier" ||
      (init.callee as AstNode).name !== "require"
    ) {
      continue;
    }
    const arg = ((init.arguments as AstNode[] | undefined) ?? [])[0];
    if (arg?.type !== "Literal" || typeof arg.value !== "string") continue;
    const source = arg.value;
    const id = decl.id as AstNode | undefined;
    if (source === "bullmq" && id?.type === "ObjectPattern") {
      imports.bullmq = true;
      for (const p of (id.properties as AstNode[] | undefined) ?? []) {
        if (p.type !== "Property" || p.computed) continue;
        const key = (p.key as AstNode | undefined)?.name as string | undefined;
        const local = (p.value as AstNode | undefined)?.type === "Identifier"
          ? ((p.value as AstNode).name as string)
          : null;
        if (key === "Queue" && local) imports.bullmqQueueNames.add(local);
        if (key === "Worker" && local) imports.bullmqWorkerNames.add(local);
      }
    } else if (source === "bull" && id?.type === "Identifier") {
      imports.bull = true;
      imports.bullQueueNames.add(id.name as string);
    } else if (id?.type === "ObjectPattern") {
      // const { Kafka } = require("kafkajs") / { connect } = require("nats") / …
      mark(source, null, null);
      for (const p of (id.properties as AstNode[] | undefined) ?? []) {
        if (p.type !== "Property" || p.computed) continue;
        const key = (p.key as AstNode | undefined)?.name as string | undefined;
        const local =
          (p.value as AstNode | undefined)?.type === "Identifier" ? ((p.value as AstNode).name as string) : null;
        if (!key || !local) continue;
        if (source === "kafkajs" && key === "Kafka") imports.kafkaCtorNames.add(local);
        if (source === "nats" && key === "connect") imports.natsConnectNames.add(local);
        if ((source === "redis" || source === "ioredis") && key === "createClient") imports.redisCtorNames.add(local);
        if ((source === "amqplib" || source === "amqplib/callback_api") && key === "connect") imports.amqpRootNames.add(local);
        if ((source === "mqtt" || source === "async-mqtt") && key === "connect") imports.mqttRootNames.add(local);
      }
    } else {
      mark(source, null, id?.type === "Identifier" ? (id.name as string) : null);
    }
  }
  return imports;
};

/**
 * Names of local bindings that provably hold a CLIENT of each system — traced
 * from the import's entry point through the library's construction idiom, in
 * source order so a chain (`kafka` → `producer`, `conn` → `channel`,
 * `client` → `client.duplicate()`) resolves:
 *   kafka  `new Kafka(…)` → `.producer()` / `.consumer(…)` / `.admin()`
 *   amqp   `amqp.connect(…)` → `.createChannel()` / `.createConfirmChannel()`
 *   nats   `connect(…)` (the nats import)
 *   mqtt   `mqtt.connect(…)`
 *   redis  `new Redis(…)` / `createClient(…)` → `.duplicate()`
 * A receiver that is not one of these names never yields a fact — an
 * EventEmitter's `.publish` or an RxJS `.subscribe` in the same file stays
 * invisible no matter what the file imports.
 */
interface ClientNames {
  kafka: Set<string>;
  amqp: Set<string>;
  nats: Set<string>;
  mqtt: Set<string>;
  redis: Set<string>;
}

const collectClientNames = (program: AstNode, imports: FileImports): ClientNames => {
  const names: ClientNames = { kafka: new Set(), amqp: new Set(), nats: new Set(), mqtt: new Set(), redis: new Set() };
  // Intermediate roots: Kafka INSTANCES and amqp CONNECTIONS (not fact receivers).
  const kafkaInstances = new Set<string>();
  const amqpConnections = new Set<string>();

  const declarators = collectDescendants(program, (n) => n.type === "VariableDeclarator", undefined, true);
  for (const decl of declarators) {
    const id = decl.id as AstNode | undefined;
    if (id?.type !== "Identifier") continue;
    const name = id.name as string;
    let init = decl.init as AstNode | undefined;
    if (init?.type === "AwaitExpression") init = init.argument as AstNode | undefined;
    if (!init) continue;

    if (init.type === "NewExpression") {
      const ctor = getCalleeName(init.callee as AstNode);
      if (ctor && imports.kafkaCtorNames.has(ctor)) kafkaInstances.add(name);
      if (ctor && imports.redisCtorNames.has(ctor)) names.redis.add(name);
      continue;
    }
    if (init.type !== "CallExpression") continue;
    const callee = init.callee as AstNode | undefined;

    if (callee?.type === "Identifier") {
      const fn = callee.name as string;
      if (imports.natsConnectNames.has(fn)) names.nats.add(name);
      if (imports.redisCtorNames.has(fn)) names.redis.add(name);
      if (imports.amqpRootNames.has(fn)) amqpConnections.add(name);
      if (imports.mqttRootNames.has(fn)) names.mqtt.add(name);
      continue;
    }
    if (callee?.type !== "MemberExpression") continue;
    const obj = callee.object as AstNode | undefined;
    const objName = obj?.type === "Identifier" ? (obj.name as string) : null;
    const prop = (callee.property as AstNode | undefined)?.type === "Identifier"
      ? ((callee.property as AstNode).name as string)
      : null;
    if (!objName || !prop) continue;

    if (imports.mqttRootNames.has(objName) && prop === "connect") names.mqtt.add(name);
    else if (imports.amqpRootNames.has(objName) && prop === "connect") amqpConnections.add(name);
    else if (amqpConnections.has(objName) && (prop === "createChannel" || prop === "createConfirmChannel")) {
      names.amqp.add(name);
    } else if (kafkaInstances.has(objName) && (prop === "producer" || prop === "consumer" || prop === "admin")) {
      names.kafka.add(name);
    } else if (names.redis.has(objName) && prop === "duplicate") {
      names.redis.add(name);
    }
  }
  return names;
};

// ---------------------------------------------------------------------------
// Per-file extraction.
// ---------------------------------------------------------------------------

interface RawFact {
  kind: "publish" | "consume";
  topic: string | null; // null = recognized endpoint with a dynamic topic
  system: QueueSystem;
  node: AstNode;
}

const receiverLastName = (call: AstNode): string | null => {
  const callee = call.callee as AstNode | undefined;
  if (callee?.type !== "MemberExpression") return null;
  const obj = callee.object as AstNode | undefined;
  if (obj?.type === "Identifier") return obj.name as string;
  if (obj?.type === "MemberExpression" && (obj.property as AstNode | undefined)?.type === "Identifier") {
    return (obj.property as AstNode).name as string;
  }
  return null;
};

const collectFileFacts = (program: AstNode, imports: FileImports): RawFact[] => {
  const facts: RawFact[] = [];
  const clients = collectClientNames(program, imports);
  const push = (kind: RawFact["kind"], topic: string | null, system: QueueSystem, node: AstNode): void => {
    facts.push({ kind, topic, system, node });
  };

  // bull: `const q = new Queue("x")` bindings, classified by same-file .add/.process.
  const bullBindings = new Map<string, { topic: string | null; node: AstNode }>();

  const news = collectDescendants(program, (n) => n.type === "NewExpression", undefined, true);
  for (const n of news) {
    const ctor = getCalleeName(n.callee as AstNode);
    if (!ctor) continue;
    const arg0 = ((n.arguments as AstNode[] | undefined) ?? [])[0];
    const topic = getStaticStringValue(arg0);
    if (imports.bullmqQueueNames.has(ctor)) {
      push("publish", topic, "bullmq", n);
    } else if (imports.bullmqWorkerNames.has(ctor)) {
      push("consume", topic, "bullmq", n);
    } else if (imports.bullQueueNames.has(ctor)) {
      const parent = (n as { parent?: AstNode }).parent;
      if (parent?.type === "VariableDeclarator" && (parent.id as AstNode)?.type === "Identifier") {
        bullBindings.set((parent.id as AstNode).name as string, { topic, node: n });
      }
      // A bare `new Bull("x")` with no tracked binding claims nothing (ambiguous).
    }
  }

  const calls = collectDescendants(program, (n) => n.type === "CallExpression", undefined, true);
  for (const call of calls) {
    const method = getMethodName(call);
    if (!method) continue;
    const args = (call.arguments as AstNode[] | undefined) ?? [];
    const receiver = receiverLastName(call);

    // bull bindings: q.add(...) publishes, q.process(...) consumes.
    if (receiver && bullBindings.has(receiver)) {
      const q = bullBindings.get(receiver)!;
      if (method === "add") push("publish", q.topic, "bull", call);
      else if (method === "process") push("consume", q.topic, "bull", call);
      continue;
    }

    // kafkajs — the receiver must be a traced producer/consumer binding.
    if (imports.kafka && receiver && clients.kafka.has(receiver)) {
      if (method === "send" && args[0]?.type === "ObjectExpression") {
        const topicProp = getObjectProperty(args[0], "topic");
        if (topicProp) push("publish", getStaticStringValue(topicProp.value as AstNode), "kafka", call);
      } else if (method === "sendBatch" && args[0]?.type === "ObjectExpression") {
        const tm = getObjectProperty(args[0], "topicMessages");
        const arr = tm?.value as AstNode | undefined;
        if (arr?.type === "ArrayExpression") {
          for (const el of (arr.elements as AstNode[] | undefined) ?? []) {
            if (el?.type !== "ObjectExpression") continue;
            const tp = getObjectProperty(el, "topic");
            if (tp) push("publish", getStaticStringValue(tp.value as AstNode), "kafka", el);
          }
        }
      } else if (method === "subscribe" && args[0]?.type === "ObjectExpression") {
        const single = getObjectProperty(args[0], "topic");
        const multi = getObjectProperty(args[0], "topics");
        if (single) push("consume", getStaticStringValue(single.value as AstNode), "kafka", call);
        const arr = multi?.value as AstNode | undefined;
        if (arr?.type === "ArrayExpression") {
          for (const el of (arr.elements as AstNode[] | undefined) ?? []) {
            if (el) push("consume", getStaticStringValue(el), "kafka", el);
          }
        }
      }
    }

    // amqplib — the receiver must be a traced channel binding.
    if (imports.amqp && receiver && clients.amqp.has(receiver)) {
      if (method === "sendToQueue" && args.length >= 2) {
        push("publish", getStaticStringValue(args[0]), "rabbitmq", call);
      } else if (method === "publish" && args.length >= 3) {
        // channel.publish(exchange, routingKey, content) — the exchange is the entity.
        push("publish", getStaticStringValue(args[0]), "rabbitmq", call);
      } else if (method === "consume" && args.length >= 2) {
        push("consume", getStaticStringValue(args[0]), "rabbitmq", call);
      }
    }

    // nats — the receiver must be a traced connection binding.
    if (imports.nats && receiver && clients.nats.has(receiver)) {
      if (method === "publish" && args.length >= 1) {
        push("publish", getStaticStringValue(args[0]), "nats", call);
      } else if (method === "subscribe" && args.length >= 1) {
        push("consume", getStaticStringValue(args[0]), "nats", call);
      }
    }

    // mqtt — the receiver must be a traced connect() binding.
    if (imports.mqtt && receiver && clients.mqtt.has(receiver)) {
      if (method === "publish" && args.length >= 2) {
        push("publish", getStaticStringValue(args[0]), "mqtt", call);
      } else if (method === "subscribe" && args.length >= 1) {
        push("consume", getStaticStringValue(args[0]), "mqtt", call);
      }
    }

    // redis pub/sub — the receiver must be a traced client/duplicate binding.
    if (imports.redis && receiver && clients.redis.has(receiver)) {
      if (method === "publish" && args.length >= 2) {
        push("publish", getStaticStringValue(args[0]), "redis", call);
      } else if (method === "subscribe" && args.length >= 1) {
        push("consume", getStaticStringValue(args[0]), "redis", call);
      }
    }
  }

  return facts;
};

// ---------------------------------------------------------------------------
// Assembly.
// ---------------------------------------------------------------------------

const SOURCE_GLOB = "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}";
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const buildQueueTopology = async (
  rootDirectory: string,
  options?: { config?: NodeDoctorConfig },
): Promise<QueueTopologyReport> => {
  const config = options?.config ?? {};
  const fg = (await import("fast-glob")).default;
  const files = (
    await fg([SOURCE_GLOB], {
      cwd: rootDirectory,
      ignore: [...BUILTIN_IGNORES, ...(config.ignore ?? [])],
      absolute: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    })
  ).sort();

  interface SitedFact {
    kind: "publish" | "consume";
    topic: string | null;
    system: QueueSystem;
    site: TopologySite;
  }

  const perFile = (
    await mapPool(files, 8, async (filePath) => {
      let sourceText: string;
      try {
        sourceText = await readFile(filePath, "utf8");
      } catch {
        return null;
      }
      const parsed = parseSource(filePath, sourceText);
      if (parsed.parseFailed) return null;
      attachParents(parsed.program);
      const imports = collectImports(parsed.program);
      const facts = collectFileFacts(parsed.program, imports);
      if (facts.length === 0) return { facts: [] as SitedFact[] };
      const locate = createLocator(sourceText);
      const normalizedFilePath = relative(rootDirectory, filePath).split(sep).join("/");
      return {
        facts: facts.map((f) => ({
          kind: f.kind,
          topic: f.topic,
          system: f.system,
          site: { normalizedFilePath, line: locate(f.node.start as number).line },
        })),
      };
    })
  ).filter((x): x is { facts: SitedFact[] } => x !== null);

  const byTopic = new Map<string, TopicEntry>();
  let unresolvedPublishes = 0;
  let unresolvedSubscribes = 0;
  let publishers = 0;
  let consumers = 0;

  for (const { facts } of perFile) {
    for (const f of facts) {
      if (f.topic === null) {
        if (f.kind === "publish") unresolvedPublishes++;
        else unresolvedSubscribes++;
        continue;
      }
      const key = `${f.system} ${f.topic}`;
      let entry = byTopic.get(key);
      if (!entry) {
        entry = { name: f.topic, system: f.system, publishers: [], consumers: [] };
        byTopic.set(key, entry);
      }
      if (f.kind === "publish") {
        entry.publishers.push(f.site);
        publishers++;
      } else {
        entry.consumers.push(f.site);
        consumers++;
      }
    }
  }

  const topics = [...byTopic.values()].sort((a, b) => cmp(a.name, b.name) || cmp(a.system, b.system));
  for (const t of topics) {
    t.publishers.sort((a, b) => cmp(a.normalizedFilePath, b.normalizedFilePath) || a.line - b.line);
    t.consumers.sort((a, b) => cmp(a.normalizedFilePath, b.normalizedFilePath) || a.line - b.line);
  }

  const orphanQuality = unresolvedSubscribes > 0 ? "suppressed-unresolved-subscribe" : "full";
  const deadQuality = unresolvedPublishes > 0 ? "suppressed-unresolved-publish" : "full";

  return {
    topics,
    orphanTopics:
      orphanQuality === "full"
        ? topics.filter((t) => t.publishers.length > 0 && t.consumers.length === 0).map((t) => t.name)
        : [],
    deadConsumers:
      deadQuality === "full"
        ? topics.filter((t) => t.consumers.length > 0 && t.publishers.length === 0).map((t) => t.name)
        : [],
    loops: topics
      .filter((t) => {
        const pubFiles = new Set(t.publishers.map((s) => s.normalizedFilePath));
        return t.consumers.some((s) => pubFiles.has(s.normalizedFilePath));
      })
      .map((t) => t.name),
    unresolvedPublishes,
    unresolvedSubscribes,
    claimQuality: { orphanTopics: orphanQuality, deadConsumers: deadQuality },
    summary: {
      filesScanned: perFile.length,
      topics: topics.length,
      publishers,
      consumers,
    },
  };
};
