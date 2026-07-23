import { defineTextDiagnostic } from "../../core/text-scan.ts";
import {
  DOCKERFILE_GLOBS,
  canonicalRepository,
  columnOf,
  isTemplated,
  parseDockerfile,
  parseImageRef,
  parseStages,
  stageIndexByName,
  type DockerStage,
} from "./dockerfile.ts";

/**
 * The image that actually ships runs its process as uid 0.
 *
 * Root in a container is not a sandbox: any RCE in the app is immediately root
 * inside the namespace, one kernel or misconfigured-mount step away from the
 * host, and free to write every file the image and its volumes contain. It is
 * the most common finding in real container audits precisely because nothing
 * ever fails without it.
 *
 * Only the FINAL stage is assessed — a builder stage running as root is normal
 * and must stay silent — and only when the base is a well-known root-by-default
 * image or the stage explicitly sets `USER root`. An unrecognized base may well
 * ship its own non-root `USER`, and guessing there would be worse than quiet.
 *
 * ❌ FROM node:20-alpine
 *    CMD ["node", "server.js"]              // uid 0
 * ✅ FROM node:20-alpine
 *    USER node
 *    CMD ["node", "server.js"]
 * ✅ FROM node:20 AS build                   // builder as root: fine
 *    FROM gcr.io/distroless/nodejs20:nonroot
 */

/**
 * Official images that leave the process as uid 0 unless the Dockerfile says
 * otherwise. Deliberately narrow: language runtimes and OS bases, where a
 * non-root user is always achievable. Servers that need a privileged port to
 * start (nginx, httpd) are left out — flagging them would be arguing with the
 * image's design rather than reporting a defect.
 */
const ROOT_BY_DEFAULT = new Set([
  "almalinux",
  "alpine",
  "amazoncorretto",
  "amazonlinux",
  "busybox",
  "centos",
  "debian",
  "eclipse-temurin",
  "fedora",
  "golang",
  "node",
  "openjdk",
  "oraclelinux",
  "perl",
  "php",
  "python",
  "rockylinux",
  "ruby",
  "rust",
  "ubuntu",
]);

const ROOT_USER_RE = /^(root|0)$/i;

/** Tags that advertise a non-root default, whatever the repository. */
const NONROOT_TAG_RE = /nonroot|rootless|unprivileged/i;

/**
 * The image drops privileges at start-up instead of via `USER`. This is the
 * standard pattern for anything that must bind a low port or fix volume
 * ownership first, and it is not a defect.
 */
const PRIVILEGE_DROP_RE = /\b(gosu|su-exec|setpriv|runuser|chpst|s6-setuidgid|start-stop-daemon)\b/;

/**
 * Local-development and devcontainer images are not deployed, so their uid is
 * not a security property. Their file names are the only signal we have.
 */
const NON_RUNTIME_FILE_RE =
  /(^|\/)\.devcontainer\/|(^|\/)(dev|develop|development|devcontainer|local|test|ci)\/|(^|\/|\.)(dev|develop|development|devcontainer|local|test|ci|build|builder)(\.dockerfile)?$/i;

interface UserSetting {
  user: string;
  line: number;
  column: number;
}

/** The last `USER` that applies to a stage, following `FROM <earlier-stage>`. */
const resolveUser = (stages: DockerStage[], index: number, seen: Set<number>): UserSetting | null => {
  if (index < 0 || index >= stages.length || seen.has(index)) return null;
  seen.add(index);
  const stage = stages[index]!;
  for (let i = stage.instructions.length - 1; i >= 0; i--) {
    const instruction = stage.instructions[i]!;
    if (instruction.keyword !== "USER") continue;
    // `USER app:app` and `USER 1000:1000` — the group half is irrelevant here.
    const user = (instruction.args.split(/\s+/)[0] ?? "").split(":")[0] ?? "";
    return { user, line: instruction.line, column: columnOf(instruction, user) };
  }
  return resolveUser(stages, stageIndexByName(stages, stage.image), seen);
};

/** The registry image a stage ultimately derives from, following stage references. */
const resolveBaseStage = (stages: DockerStage[], index: number, seen: Set<number>): DockerStage | null => {
  if (index < 0 || index >= stages.length || seen.has(index)) return null;
  seen.add(index);
  const stage = stages[index]!;
  const parent = stageIndexByName(stages, stage.image);
  return parent >= 0 ? resolveBaseStage(stages, parent, seen) : stage;
};

/** Does this stage — or any stage it inherits from — drop privileges at run time? */
const dropsPrivileges = (stages: DockerStage[], index: number, seen: Set<number>): boolean => {
  if (index < 0 || index >= stages.length || seen.has(index)) return false;
  seen.add(index);
  const stage = stages[index]!;
  if (stage.instructions.some((i) => PRIVILEGE_DROP_RE.test(i.args))) return true;
  return dropsPrivileges(stages, stageIndexByName(stages, stage.image), seen);
};

/**
 * Does the stage actually launch something? A Dockerfile with no CMD and no
 * ENTRYPOINT is a base image for someone else to extend, and that consumer is
 * the one who owns the `USER` decision — flagging the base would be noise.
 */
const declaresProcess = (stages: DockerStage[], index: number, seen: Set<number>): boolean => {
  if (index < 0 || index >= stages.length || seen.has(index)) return false;
  seen.add(index);
  const stage = stages[index]!;
  if (stage.instructions.some((i) => i.keyword === "CMD" || i.keyword === "ENTRYPOINT")) return true;
  return declaresProcess(stages, stageIndexByName(stages, stage.image), seen);
};

export const dockerfileRunsAsRoot = defineTextDiagnostic({
  id: "dockerfile-runs-as-root",
  title: "Container image runs as root",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["container", "docker"],
  files: DOCKERFILE_GLOBS,
  maxBytes: 128 * 1024,
  recommendation:
    "Create an unprivileged user in the final stage and switch to it before the entrypoint — `RUN adduser -D app` then `USER app` (official Node images already ship a `node` user). Give the user ownership of only the paths it must write, and keep the build steps that genuinely need root above the `USER` line.",
  scan: (ctx) => {
    if (NON_RUNTIME_FILE_RE.test(ctx.normalizedFilePath)) return;
    const instructions = parseDockerfile(ctx.content);
    if (!instructions) return;
    const stages = parseStages(instructions);
    if (stages.length === 0) return;

    // Which stage actually deploys is a build-time choice (`--target`, compose
    // `target:`) that the Dockerfile does not record, so \"the last one in the
    // file\" is a guess. When ANY runnable stage drops privileges, the author
    // demonstrably knows about USER and the remaining stages are targets we
    // cannot attribute — stay silent rather than flag the dev stage of a file
    // whose production stage is correctly hardened.
    const runnable = stages
      .map((_, i) => i)
      .filter((i) => declaresProcess(stages, i, new Set()));
    if (runnable.length > 1 && runnable.some((i) => resolveUser(stages, i, new Set()) !== null || dropsPrivileges(stages, i, new Set()))) {
      return;
    }

    const finalIndex = stages.length - 1;
    const finalStage = stages[finalIndex]!;
    if (!declaresProcess(stages, finalIndex, new Set())) return;
    if (dropsPrivileges(stages, finalIndex, new Set())) return;

    const user = resolveUser(stages, finalIndex, new Set());
    if (user) {
      // `USER $APP_UID` resolves at build time — unknowable, so say nothing.
      if (isTemplated(user.user) || !ROOT_USER_RE.test(user.user)) return;
      ctx.report({
        line: user.line,
        column: user.column,
        message:
          "The final stage explicitly runs as root, so the shipped container's process is uid 0 — an RCE in the app starts with full privileges inside the container.",
      });
      return;
    }

    // No USER anywhere in the final stage's inheritance chain. Only speak up
    // when the base image is one we know leaves the process as root; `scratch`
    // and unfamiliar bases may set their own user and cannot be assessed.
    const base = resolveBaseStage(stages, finalIndex, new Set());
    if (!base || base.image.length === 0 || isTemplated(base.image)) return;
    const ref = parseImageRef(base.image);
    const repository = canonicalRepository(ref.repository);
    if (!ROOT_BY_DEFAULT.has(repository)) return;
    if (NONROOT_TAG_RE.test(ref.tag ?? "")) return;

    ctx.report({
      line: finalStage.from.line,
      column: columnOf(finalStage.from, finalStage.image),
      message: `The final stage has no USER directive and \`${repository}\` runs as root by default, so the shipped container's process is uid 0.`,
    });
  },
});
