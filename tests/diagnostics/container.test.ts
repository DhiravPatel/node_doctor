import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TextDiagnostic } from "../../src/core/text-scan.ts";
import { dockerfileRunsAsRoot } from "../../src/diagnostics/container/dockerfile-runs-as-root.ts";
import { dockerfileMutableBaseTag } from "../../src/diagnostics/container/dockerfile-mutable-base-tag.ts";
import { dockerfileSecretInBuildStage } from "../../src/diagnostics/container/dockerfile-secret-in-build-stage.ts";
import { dockerfileCopiesDotenvIntoImage } from "../../src/diagnostics/container/dockerfile-copies-dotenv-into-image.ts";

interface Report {
  line: number;
  column: number;
  message: string;
}

/** Drive a text diagnostic's `scan` directly with a hand-built context. */
const run = (diagnostic: TextDiagnostic, content: string, path = "Dockerfile"): Report[] => {
  const reports: Report[] = [];
  diagnostic.scan({
    filePath: `/repo/${path}`,
    normalizedFilePath: path,
    content,
    committed: true,
    report: ({ line, column = 1, message }) => reports.push({ line, column, message }),
  });
  return reports;
};

const root = (content: string, path?: string): Report[] => run(dockerfileRunsAsRoot, content, path);
const tag = (content: string, path?: string): Report[] => run(dockerfileMutableBaseTag, content, path);
const secret = (content: string, path?: string): Report[] => run(dockerfileSecretInBuildStage, content, path);
const dotenv = (content: string, path?: string): Report[] => run(dockerfileCopiesDotenvIntoImage, content, path);

describe("dockerfile-runs-as-root", () => {
  test("fires when the final stage has no USER and the base runs as root", () => {
    const found = root(`FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "server.js"]\n`);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.line, 1);
    assert.match(found[0]!.message, /no USER directive/);
  });

  test("SILENT when a builder stage runs as root but the final stage does not", () => {
    const df = [
      "FROM node:20 AS builder",
      "WORKDIR /app",
      "RUN npm ci && npm run build",
      "",
      "FROM node:20-alpine",
      "COPY --from=builder /app/dist /app",
      "USER node",
      'CMD ["node", "/app/main.js"]',
    ].join("\n");
    assert.deepEqual(tag(df).length, 0);
    assert.deepEqual(root(df), []);
  });

  test("SILENT on USER appuser", () => {
    assert.deepEqual(
      root(`FROM node:20-alpine\nRUN adduser -D appuser\nUSER appuser\nCMD ["node", "s.js"]\n`),
      [],
    );
  });

  test("fires when the last USER in the final stage is root", () => {
    const df = `FROM node:20-alpine\nUSER node\nRUN npm ci\nUSER root\nCMD ["node", "s.js"]\n`;
    const found = root(df);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.line, 4);
    assert.match(found[0]!.message, /explicitly runs as root/);
  });

  test("fires on USER 0 and on user:group form", () => {
    assert.equal(root(`FROM node:20\nUSER 0\nCMD ["node"]\n`).length, 1);
    assert.equal(root(`FROM node:20\nUSER root:root\nCMD ["node"]\n`).length, 1);
    assert.equal(root(`FROM node:20\nUSER 1000:1000\nCMD ["node"]\n`).length, 0);
  });

  test("SILENT when a root builder is followed by a root-dropping final stage", () => {
    const df = [
      "FROM node:20 AS build",
      "USER root",
      "RUN npm ci",
      "FROM gcr.io/distroless/nodejs20-debian12",
      "COPY --from=build /app /app",
      'CMD ["/app/main.js"]',
    ].join("\n");
    assert.deepEqual(root(df), []);
  });

  test("SILENT on FROM scratch and on unrecognized bases — not assessable", () => {
    assert.deepEqual(root(`FROM scratch\nCOPY server /server\nENTRYPOINT ["/server"]\n`), []);
    assert.deepEqual(root(`FROM mycorp.jfrog.io/base/node-runtime:4\nCMD ["node", "s.js"]\n`), []);
    assert.deepEqual(root(`FROM cgr.dev/chainguard/node:latest\nCMD ["s.js"]\n`), []);
  });

  test("SILENT on a nonroot-tagged image", () => {
    assert.deepEqual(root(`FROM node:20-nonroot\nCMD ["node", "s.js"]\n`), []);
  });

  test("SILENT when USER is a build-time variable", () => {
    assert.deepEqual(root(`FROM node:20\nARG APP_USER\nUSER $APP_USER\nCMD ["node"]\n`), []);
  });

  test("SILENT when the entrypoint drops privileges with gosu", () => {
    const df = `FROM debian:12\nCOPY entrypoint.sh /\nENTRYPOINT ["/entrypoint.sh"]\nCMD ["gosu", "app", "node", "s.js"]\n`;
    assert.deepEqual(root(df), []);
  });

  test("SILENT for a base image with no CMD or ENTRYPOINT", () => {
    assert.deepEqual(root(`FROM node:20\nRUN apt-get update && apt-get install -y curl\n`), []);
  });

  test("SILENT for development and devcontainer images", () => {
    const df = `FROM node:20\nCMD ["npm", "run", "dev"]\n`;
    assert.deepEqual(root(df, "Dockerfile.dev"), []);
    assert.deepEqual(root(df, ".devcontainer/Dockerfile"), []);
    assert.equal(root(df, "services/api/Dockerfile").length, 1);
  });

  test("inherits the USER of a referenced earlier stage", () => {
    const inherited = [
      "FROM node:20-alpine AS base",
      "USER node",
      "FROM base",
      "COPY . .",
      'CMD ["node", "s.js"]',
    ].join("\n");
    assert.deepEqual(root(inherited), []);

    const rooted = [
      "FROM node:20-alpine AS base",
      "RUN npm i -g pnpm",
      "FROM base",
      "COPY . .",
      'CMD ["node", "s.js"]',
    ].join("\n");
    assert.equal(root(rooted).length, 1);
  });

  test("handles line continuations and comments", () => {
    const df = [
      "# syntax=docker/dockerfile:1",
      "FROM node:20-alpine",
      "RUN npm ci \\",
      "    # install only what ships",
      "    --omit=dev",
      "USER node",
      'CMD ["node", "s.js"]',
    ].join("\n");
    assert.deepEqual(root(df), []);
  });

  test("SILENT when a non-default escape directive makes continuations unreadable", () => {
    const df = "# escape=`\nFROM node:20\nCMD [\"node\"]\n";
    assert.deepEqual(root(df), []);
  });
});

describe("dockerfile-mutable-base-tag", () => {
  test("fires on an untagged image", () => {
    const found = tag(`FROM node\nCMD ["node", "s.js"]\n`);
    assert.equal(found.length, 1);
    assert.match(found[0]!.message, /has no tag/);
  });

  test("fires on :latest", () => {
    const found = tag(`FROM node:latest\nCMD ["node", "s.js"]\n`);
    assert.equal(found.length, 1);
    assert.match(found[0]!.message, /moving tag/);
  });

  test("SILENT on a pinned tag, a digest, and scratch", () => {
    assert.deepEqual(tag(`FROM node:20-alpine\n`), []);
    assert.deepEqual(tag(`FROM node:20.11.0\n`), []);
    assert.deepEqual(tag(`FROM node:latest@sha256:0123456789abcdef\n`), []);
    assert.deepEqual(tag(`FROM scratch\n`), []);
  });

  test("SILENT on a stage reference", () => {
    const df = ["FROM node:20-alpine AS builder", "RUN npm ci", "FROM builder", 'CMD ["node"]'].join("\n");
    assert.deepEqual(tag(df), []);
  });

  test("SILENT on an ARG-templated image", () => {
    assert.deepEqual(tag("ARG BASE=node:20-alpine\nFROM ${BASE}\n"), []);
    assert.deepEqual(tag("ARG NODE_VERSION=20\nFROM node:$NODE_VERSION\n"), []);
  });

  test("a registry port is not a tag", () => {
    assert.equal(tag(`FROM registry.internal:5000/team/api\n`).length, 1);
    assert.deepEqual(tag(`FROM registry.internal:5000/team/api:1.4.2\n`), []);
  });

  test("--platform flags do not confuse the image reference", () => {
    assert.deepEqual(tag(`FROM --platform=$BUILDPLATFORM node:20-alpine AS build\n`), []);
    assert.equal(tag(`FROM --platform=linux/amd64 node AS build\n`).length, 1);
  });

  test("reports every unpinned stage", () => {
    const df = ["FROM golang AS build", "RUN go build", "FROM alpine:latest", "COPY --from=build /a /a"].join("\n");
    const found = tag(df);
    assert.equal(found.length, 2);
    assert.deepEqual(
      found.map((f) => f.line),
      [1, 3],
    );
  });
});

describe("dockerfile-secret-in-build-stage", () => {
  test("fires on a baked AWS key and never echoes the value", () => {
    const value = `AKIA${"IOSFODNN7QWERTY"}Z`;
    const found = secret(`FROM node:20\nENV AWS_SECRET_ACCESS_KEY=${value}\n`);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.line, 2);
    assert.match(found[0]!.message, /AWS_SECRET_ACCESS_KEY/);
    assert.ok(!found[0]!.message.includes(value), "the message must not contain the secret value");
  });

  test("fires on a baked npm token in an ARG default", () => {
    const value = `npm_${"a1b2c3d4e5f6g7h8i9j0"}k1l2`;
    const found = secret(`FROM node:20\nARG NPM_TOKEN=${value}\nRUN npm ci\n`);
    assert.equal(found.length, 1);
    assert.ok(!found[0]!.message.includes(value));
    assert.match(found[0]!.message, /docker history/);
  });

  test("SILENT on an ARG declared without a value — the correct pattern", () => {
    assert.deepEqual(secret(`FROM node:20\nARG NPM_TOKEN\nRUN npm ci\n`), []);
    assert.deepEqual(secret(`FROM node:20\nARG NPM_TOKEN=\n`), []);
    assert.deepEqual(secret(`FROM node:20\nARG NPM_TOKEN=""\n`), []);
  });

  test("SILENT on ordinary configuration", () => {
    const df = [
      "FROM node:20-alpine",
      "ENV NODE_ENV=production",
      "ENV PORT=3000",
      "ENV NODE_VERSION 20.11.0",
      "ENV GPG_KEY=B26995E310250568",
      "ENV NPM_CONFIG_CACHE=/root/.npm",
      "ENV AUTH_TOKEN_HEADER=x-auth-token",
      "ENV TOKEN_EXPIRY=3600",
      "ENV CREDENTIALS_FILE=/run/secrets/gcp.json",
      "ENV API_KEY_HEADER_NAME=x-api-key",
    ].join("\n");
    assert.deepEqual(secret(df), []);
  });

  test("SILENT on placeholders, references, and weak dev defaults", () => {
    const df = [
      "FROM node:20",
      "ENV API_KEY=changeme",
      "ENV JWT_SECRET=${JWT_SECRET}",
      "ENV DB_PASSWORD=$DB_PASSWORD",
      "ENV POSTGRES_PASSWORD=postgres",
      "ENV SESSION_SECRET=your-secret-here",
      "ENV STRIPE_SECRET_KEY=sk_test_placeholder",
      "ENV SECRET_KEY=django-insecure-9f2h4kd8sk2h4kd8sk2h4kd8sk2h4kd8",
      "ENV TOKEN_URL=https://auth.example.com/oauth/token",
    ].join("\n");
    assert.deepEqual(secret(df), []);
  });

  test("SILENT when a secret-shaped value has a non-secret name", () => {
    assert.deepEqual(secret(`FROM node:20\nENV BUILD_SHA=9f2h4kd8sk2h4kd8sk2h4kd8sk2h4kd8\n`), []);
  });

  test("handles multiple assignments and quoting in one ENV", () => {
    const value = `ghp_${"a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8"}`;
    const found = secret(`FROM node:20\nENV NODE_ENV=production GITHUB_TOKEN="${value}"\n`);
    assert.equal(found.length, 1);
    assert.match(found[0]!.message, /GITHUB_TOKEN/);
    assert.ok(!found[0]!.message.includes(value));
  });

  test("sees through a line continuation", () => {
    const value = `AKIA${"IOSFODNN7QWERTY"}Z`;
    const df = ["FROM node:20", "ENV \\", `    AWS_ACCESS_KEY_ID=${value}`].join("\n");
    const found = secret(df);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.line, 2);
  });

  test("SILENT on a commented-out secret", () => {
    const value = `AKIA${"IOSFODNN7QWERTY"}Z`;
    assert.deepEqual(secret(`FROM node:20\n# ENV AWS_SECRET_ACCESS_KEY=${value}\n`), []);
  });
});

describe("container diagnostics: shape and determinism", () => {
  const all = [dockerfileRunsAsRoot, dockerfileMutableBaseTag, dockerfileSecretInBuildStage];

  test("every diagnostic matches the four container file names", () => {
    for (const d of all) {
      assert.deepEqual(d.files, ["**/Dockerfile", "**/Dockerfile.*", "**/*.Dockerfile", "**/Containerfile"]);
      assert.ok(d.recommendation.length > 40, `${d.id} needs a real recommendation`);
      assert.match(d.id, /^dockerfile-[a-z0-9-]+$/);
    }
  });

  test("repeated scans of the same input produce identical reports", () => {
    const df = [
      "FROM node AS build",
      "ARG NPM_TOKEN=npm_a1b2c3d4e5f6g7h8i9j0k1l2",
      "FROM node:latest",
      'CMD ["node", "s.js"]',
    ].join("\n");
    for (const d of all) {
      assert.deepEqual(run(d, df), run(d, df));
    }
  });

  test("an empty or malformed file produces nothing", () => {
    for (const d of all) {
      assert.deepEqual(run(d, ""), []);
      assert.deepEqual(run(d, "# just a comment\n\n"), []);
      assert.deepEqual(run(d, "FROM\n"), []);
    }
  });
});

/**
 * `dockerfile-copies-dotenv-into-image`.
 *
 * A `.env` is gitignored by design, so every check that reasons about committed
 * content — including this project's own `no-committed-env-secret`, which is
 * `committedFilesOnly` — passes cleanly while the credentials ship inside an
 * image layer. The Dockerfile is the only artifact where the leak is visible,
 * and it is visible as a filename. Found at 17 of 224 COPY/ADD instructions
 * across 35 corpus Dockerfiles.
 */
describe("dockerfile-copies-dotenv-into-image", () => {
  test("fires on a plain `COPY .env`", () => {
    const found = dotenv("FROM node:20\nCOPY .env ./\n");
    assert.equal(found.length, 1);
    assert.equal(found[0]!.line, 2);
    assert.match(found[0]!.message, /docker history/);
  });

  test("fires on a dotenv carried out of a builder stage", () => {
    const found = dotenv(
      "FROM node:20 AS builder\nRUN npm ci\nFROM node:20\nCOPY --chown=node:node --from=builder /app/.env.production ./build/.env\n",
    );
    assert.equal(found.length, 1);
  });

  test("fires in a BUILDER stage too — the leak can launder through a shell cp", () => {
    // Real corpus shape: the builder copies the dotenv, `RUN cp` moves it into a
    // directory, and the runner copies that directory. No final-stage COPY ever
    // names a dotenv, so a final-stage-only rule would miss it entirely.
    const found = dotenv(
      "FROM node:20 AS builder\nCOPY apps/api/.env apps/api/.env\nRUN cp apps/api/.env /deploy/.env\nFROM node:20\nCOPY --from=builder /deploy ./\n",
    );
    assert.equal(found.length, 1);
    assert.equal(found[0]!.line, 2);
  });

  test("fires on ADD and on the JSON operand form", () => {
    assert.equal(dotenv("FROM node:20\nADD .env /app/.env\n").length, 1);
    assert.equal(dotenv('FROM node:20\nCOPY [".env", "./"]\n').length, 1);
  });

  test("every production-ish dotenv name is covered", () => {
    for (const name of [".env", ".env.production", ".env.prod", ".env.staging", ".env.live", ".env.release"]) {
      assert.equal(dotenv(`FROM node:20\nCOPY ${name} ./\n`).length, 1, name);
    }
  });

  describe("silence", () => {
    test("template and fixture names — six of the 35 corpus Dockerfiles ship one", () => {
      for (const name of [".env.example", ".env.sample", ".env.template", ".env.dist", ".env.test", ".env.local", ".env.development"]) {
        assert.equal(dotenv(`FROM node:20\nCOPY ${name} ./\n`).length, 0, name);
      }
    });

    test("an unseen `.env.whatever` stays quiet — the allowlist is positive", () => {
      assert.equal(dotenv("FROM node:20\nCOPY .env.tomorrow ./\n").length, 0);
    });

    test("a templated source is resolved at build time", () => {
      assert.equal(dotenv("FROM node:20\nCOPY ${ENV_FILE} .env\n").length, 0);
    });

    test("globs depend on the build context and .dockerignore", () => {
      assert.equal(dotenv("FROM node:20\nCOPY .env* ./\n").length, 0);
      assert.equal(dotenv("FROM node:20\nCOPY . .\n").length, 0);
    });

    test("seeding a placeholder is not shipping values", () => {
      assert.equal(dotenv("FROM node:20\nCOPY .env .env.example\n").length, 0);
    });

    test("a BuildKit secret mount is the correct pattern", () => {
      assert.equal(dotenv("FROM node:20\nRUN --mount=type=secret,id=env cat /run/secrets/env\n").length, 0);
    });
  });
});
