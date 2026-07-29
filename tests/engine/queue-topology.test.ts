/**
 * §157 — Queue & Topic Topology Mapping.
 *
 * Covers the per-system extraction (kafkajs, amqplib, bullmq split classes,
 * bull's ambiguous single Queue, nats/mqtt/redis), import gating (a receiver
 * merely NAMED like a client yields nothing), orphan/dead-consumer claims and
 * their degrade gates (dynamic topics suppress the claims they could hide),
 * same-file loops, and determinism.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildQueueTopology, type QueueTopologyReport } from "../../src/core/queue-topology.ts";

const makeProject = async (files: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-queues-"));
  for (const [rel, src] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, src);
  }
  return dir;
};

const topic = (r: QueueTopologyReport, name: string) => {
  const t = r.topics.find((x) => x.name === name);
  assert.ok(t, `expected topic ${name}; got ${r.topics.map((x) => x.name).join(", ")}`);
  return t!;
};

describe("buildQueueTopology — extraction", () => {
  test("kafkajs: send/sendBatch publish, subscribe (single + topics array) consumes", async () => {
    const dir = await makeProject({
      "src/a.ts": `
        import { Kafka } from "kafkajs";
        const kafka = new Kafka({ brokers: ["b:9092"] });
        const producer = kafka.producer();
        const consumer = kafka.consumer({ groupId: "g" });
        await producer.send({ topic: "orders", messages: [] });
        await producer.sendBatch({ topicMessages: [{ topic: "audit" }, { topic: "metrics" }] });
        await consumer.subscribe({ topic: "orders" });
        await consumer.subscribe({ topics: ["audit", "metrics"] });
      `,
    });
    try {
      const r = await buildQueueTopology(dir);
      assert.equal(topic(r, "orders").publishers.length, 1);
      assert.equal(topic(r, "orders").consumers.length, 1);
      assert.equal(topic(r, "audit").publishers.length, 1);
      assert.equal(topic(r, "metrics").consumers.length, 1);
      assert.deepEqual(r.orphanTopics, []);
      assert.deepEqual(r.deadConsumers, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("amqplib: sendToQueue/publish(exchange) publish, consume consumes", async () => {
    const dir = await makeProject({
      "src/a.ts": `
        import amqp from "amqplib";
        const conn = await amqp.connect(process.env.URL);
        const ch = await conn.createChannel();
        ch.sendToQueue("jobs", Buffer.from("x"));
        ch.publish("events.exchange", "key", Buffer.from("y"));
        ch.consume("jobs", () => {});
      `,
    });
    try {
      const r = await buildQueueTopology(dir);
      assert.equal(topic(r, "jobs").publishers.length, 1);
      assert.equal(topic(r, "jobs").consumers.length, 1);
      assert.deepEqual(r.orphanTopics, ["events.exchange"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("bullmq: Queue construction publishes, Worker construction consumes", async () => {
    const dir = await makeProject({
      "src/q.ts": `import { Queue } from "bullmq"; export const q = new Queue("emails");`,
      "src/w.ts": `import { Worker } from "bullmq"; const w = new Worker("emails", async () => {});`,
    });
    try {
      const r = await buildQueueTopology(dir);
      assert.equal(topic(r, "emails").publishers.length, 1);
      assert.equal(topic(r, "emails").consumers.length, 1);
      assert.deepEqual(r.loops, [], "different files — not a same-file loop");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("bull: a bare new Queue claims nothing; .add publishes and .process consumes", async () => {
    const dir = await makeProject({
      "src/bare.ts": `import Queue from "bull"; export const q = new Queue("ambiguous");`,
      "src/used.ts": `
        import Queue from "bull";
        const jobs = new Queue("payments");
        jobs.process(async (job) => {});
        const out = new Queue("emails-out");
        out.add({ to: "x" });
      `,
    });
    try {
      const r = await buildQueueTopology(dir);
      assert.equal(r.topics.some((t) => t.name === "ambiguous"), false, "unclassified bull queue is silent");
      assert.equal(topic(r, "payments").consumers.length, 1);
      assert.equal(topic(r, "payments").publishers.length, 0);
      assert.equal(topic(r, "emails-out").publishers.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("nats and mqtt publish/subscribe", async () => {
    const dir = await makeProject({
      "src/n.ts": `import { connect } from "nats"; const nc = await connect({}); nc.publish("evt.user", data); nc.subscribe("evt.user");`,
      "src/m.ts": `import mqtt from "mqtt"; const client = mqtt.connect("mqtt://h"); client.publish("sensors/temp", "21"); client.subscribe("sensors/temp");`,
    });
    try {
      const r = await buildQueueTopology(dir);
      assert.equal(topic(r, "evt.user").system, "nats");
      assert.equal(topic(r, "sensors/temp").system, "mqtt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("redis pub/sub needs the import AND a client traced from it", async () => {
    const dir = await makeProject({
      "src/ok.ts": `
        import Redis from "ioredis";
        const pubClient = new Redis();
        const subClient = pubClient.duplicate();
        pubClient.publish("ch.notify", "x");
        subClient.subscribe("ch.notify");
      `,
      "src/no.ts": `import Redis from "ioredis"; cache.publish("not.a.channel", "x"); broker.publish("also.not", "y");`,
    });
    try {
      const r = await buildQueueTopology(dir);
      assert.equal(topic(r, "ch.notify").publishers.length, 1);
      assert.equal(r.topics.some((t) => t.name === "not.a.channel"), false, "an untraced receiver is not pub/sub");
      assert.equal(r.topics.some((t) => t.name === "also.not"), false, "even a broker-ish NAME is not proof");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildQueueTopology — import gating", () => {
  test("an EventEmitter/RxJS lookalike in a file that DOES import a queue lib yields nothing", async () => {
    const dir = await makeProject({
      "src/m.ts": `
        import mqtt from "mqtt";
        const client = mqtt.connect("mqtt://host");
        client.publish("sensors/temp", "21");
        eventBus.publish("user.created", { id: 1 });
        observable.subscribe("next");
      `,
      "src/n.ts": `
        import { connect } from "nats";
        const nc = await connect({});
        nc.publish("evt.real", data);
        store.subscribe("listener-token");
      `,
    });
    try {
      const r = await buildQueueTopology(dir);
      const names = r.topics.map((t) => t.name).sort();
      assert.deepEqual(names, ["evt.real", "sensors/temp"], "only binding-traced clients yield facts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("publish/subscribe with NO queue import yields nothing", async () => {
    const dir = await makeProject({
      "src/a.ts": `
        export function wire(emitter, socket) {
          emitter.publish("fake.topic", {});
          socket.subscribe("fake.channel");
          emitter.send({ topic: "also.fake" });
          new Queue("phantom");
          new Worker("phantom", () => {});
        }
      `,
    });
    try {
      const r = await buildQueueTopology(dir);
      assert.deepEqual(r.topics, []);
      assert.equal(r.unresolvedPublishes + r.unresolvedSubscribes, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildQueueTopology — claims + degrade gates", () => {
  test("orphans and dead consumers under full proof", async () => {
    const dir = await makeProject({
      "src/a.ts": `
        import { Kafka } from "kafkajs";
        const kafka = new Kafka({ brokers: [] });
        const producer = kafka.producer();
        const consumer = kafka.consumer({ groupId: "g" });
        await producer.send({ topic: "into.void", messages: [] });
        await consumer.subscribe({ topic: "never.fed" });
      `,
    });
    try {
      const r = await buildQueueTopology(dir);
      assert.deepEqual(r.orphanTopics, ["into.void"]);
      assert.deepEqual(r.deadConsumers, ["never.fed"]);
      assert.equal(r.claimQuality.orphanTopics, "full");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a dynamic subscribe suppresses orphan claims; a dynamic publish suppresses dead-consumer claims", async () => {
    const dir = await makeProject({
      "src/a.ts": `
        import { Kafka } from "kafkajs";
        const kafka = new Kafka({ brokers: [] });
        const producer = kafka.producer();
        const consumer = kafka.consumer({ groupId: "g" });
        await producer.send({ topic: "into.void", messages: [] });
        await consumer.subscribe({ topic: someVar });
      `,
      "src/b.ts": `
        import { Kafka } from "kafkajs";
        const kafka = new Kafka({ brokers: [] });
        const producer = kafka.producer();
        const consumer = kafka.consumer({ groupId: "g" });
        await consumer.subscribe({ topic: "never.fed" });
        await producer.send({ topic: dynamicTopic, messages: [] });
      `,
    });
    try {
      const r = await buildQueueTopology(dir);
      assert.deepEqual(r.orphanTopics, [], "the dynamic subscribe could be consuming into.void");
      assert.deepEqual(r.deadConsumers, [], "the dynamic publish could be feeding never.fed");
      assert.equal(r.claimQuality.orphanTopics, "suppressed-unresolved-subscribe");
      assert.equal(r.claimQuality.deadConsumers, "suppressed-unresolved-publish");
      assert.equal(r.unresolvedPublishes, 1);
      assert.equal(r.unresolvedSubscribes, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a same-file consume+publish of one topic is a loop (info, not a claim)", async () => {
    const dir = await makeProject({
      "src/w.ts": `
        import { Queue, Worker } from "bullmq";
        const q = new Queue("jobs");
        const w = new Worker("jobs", async (job) => { await q.add("retry", job.data); });
      `,
    });
    try {
      const r = await buildQueueTopology(dir);
      assert.deepEqual(r.loops, ["jobs"]);
      assert.deepEqual(r.orphanTopics, []);
      assert.deepEqual(r.deadConsumers, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildQueueTopology — determinism", () => {
  test("identical input yields byte-identical JSON across runs", async () => {
    const dir = await makeProject({
      "src/a.ts": `
        import { Kafka } from "kafkajs";
        const kafka = new Kafka({ brokers: [] });
        const producer = kafka.producer();
        const consumer = kafka.consumer({ groupId: "g" });
        await producer.send({ topic: "orders", messages: [] });
        await consumer.subscribe({ topic: "orders" });
      `,
    });
    try {
      const a = await buildQueueTopology(dir);
      const b = await buildQueueTopology(dir);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
