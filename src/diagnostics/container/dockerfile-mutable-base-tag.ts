import { defineTextDiagnostic } from "../../core/text-scan.ts";
import {
  DOCKERFILE_GLOBS,
  columnOf,
  isTemplated,
  parseDockerfile,
  parseImageRef,
  parseStages,
  stageIndexByName,
} from "./dockerfile.ts";

/**
 * A `FROM` with no tag, or `:latest` — a base image that changes underneath the
 * build.
 *
 * The image that passed CI is then not the image that ships: the same commit
 * rebuilt an hour later can pull a new OpenSSL, a new libc, or a major runtime
 * bump, so a green pipeline proves nothing about the artifact in production and
 * a rollback cannot reproduce the binary it is rolling back to. Bare `FROM img`
 * is the worse of the two because the implicit `:latest` is invisible in review.
 *
 * ❌ FROM node                      // implicitly :latest
 * ❌ FROM node:latest
 * ✅ FROM node:20.11-alpine3.19
 * ✅ FROM node:20-alpine@sha256:…   // digest-pinned
 * ✅ FROM builder                   // an earlier stage, not a registry pull
 */

const LATEST_TAG_RE = /^latest$/i;

/** `scratch` is the empty image — it has no registry content to pin. */
const isScratch = (repository: string): boolean => repository.toLowerCase() === "scratch";

export const dockerfileMutableBaseTag = defineTextDiagnostic({
  id: "dockerfile-mutable-base-tag",
  title: "Base image is not pinned to an immutable reference",
  severity: "warn",
  category: "Reliability",
  confidence: "high",
  tags: ["container", "docker", "reproducibility"],
  files: DOCKERFILE_GLOBS,
  maxBytes: 128 * 1024,
  recommendation:
    "Pin the base to a specific version (`FROM node:20.11-alpine3.19`) and, for release images, to a digest (`FROM node:20-alpine@sha256:…`) so the build is byte-reproducible. Let a bot (Renovate/Dependabot) raise the pin as a reviewable pull request instead of letting the tag drift silently.",
  scan: (ctx) => {
    const instructions = parseDockerfile(ctx.content);
    if (!instructions) return;
    const stages = parseStages(instructions);

    for (const stage of stages) {
      const image = stage.image;
      if (image.length === 0) continue;
      // `FROM ${BASE}` is pinned wherever the ARG is defined — not our call.
      if (isTemplated(image)) continue;
      // `FROM builder` copies an earlier stage; there is no registry tag here.
      if (stageIndexByName(stages, image) >= 0) continue;

      const ref = parseImageRef(image);
      // A digest is the strongest possible pin, whatever the tag says.
      if (ref.digest) continue;
      if (isScratch(ref.repository)) continue;

      if (ref.tag === null) {
        ctx.report({
          line: stage.from.line,
          column: columnOf(stage.from, image),
          message: `\`FROM ${image}\` has no tag, so the build silently follows \`:latest\` — the image that passed CI is not the image that ships.`,
        });
      } else if (LATEST_TAG_RE.test(ref.tag)) {
        ctx.report({
          line: stage.from.line,
          column: columnOf(stage.from, image),
          message: `\`FROM ${image}\` tracks a moving tag, so the same commit can rebuild into a different base image.`,
        });
      }
    }
  },
});
