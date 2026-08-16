import { defineTextDiagnostic } from "../../core/text-scan.ts";
import { DOCKERFILE_GLOBS, columnOf, isTemplated, parseDockerfile } from "./dockerfile.ts";

/**
 * A real dotenv file copied into an image layer.
 *
 *   ❌ COPY .env ./
 *   ❌ COPY --from=builder /app/.env.production ./build/.env
 *   ✅ RUN --mount=type=secret,id=env  …          // never lands in a layer
 *   ✅ pass the values as runtime environment variables
 *
 * Layers are immutable and distributable. Once a `.env` is in one, `docker
 * history`, `docker save` and any registry mirror hand the live credentials to
 * anyone who can pull the image; a later `RUN rm .env` deletes the file in a new
 * layer but the old layer still contains it; and the credentials cannot be
 * rotated without rebuilding and redeploying.
 *
 * WHY THIS IS NOT ALREADY CAUGHT, which is the point of the rule. These files are
 * gitignored — that is what a `.env` is for — so every check that reasons about
 * committed content passes cleanly. node.doctor's own `no-committed-env-secret`
 * is `committedFilesOnly`, so it correctly says nothing, and the secret ships in
 * the image anyway. The sibling `dockerfile-secret-in-build-stage` does not cover
 * it either: that fires on an `ENV`/`ARG` whose VALUE is key material, and a
 * `COPY` carries no value in the Dockerfile at all. The Dockerfile is the only
 * artifact where the leak is visible, and it is visible as a filename.
 *
 * Found in a corpus sweep at 17 of 224 `COPY`/`ADD` instructions across 35
 * Dockerfiles — carrying, in the files they name, `OPENAI_API_KEY=sk-pro…`,
 * `GOOGLE_CLIENT_SECRET=GOCSPX…`, `JWT_SECRET` and a ClickHouse password.
 *
 * PRECISION MODEL.
 *
 *   - The source basename must match a POSITIVE allowlist of names that hold
 *     real values: `.env`, `.env.production`, `.env.prod`, `.env.staging`,
 *     `.env.stage`, `.env.live`, `.env.release`. An allowlist rather than a
 *     template blocklist means an unseen `.env.whatever` stays silent, and it
 *     costs nothing — every real corpus hit is exactly `.env` or
 *     `.env.production`.
 *   - `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `.env.test`,
 *     `.env.local` and `.env.development` are therefore never matched. Six of
 *     the 35 Dockerfiles ship one of those beside them.
 *   - **Any stage counts, not just the final one.** Restricting to the final
 *     stage would look tidier and would MISS three real leaks, where a builder
 *     does `COPY apps/api/.env apps/api/.env`, then `RUN cp apps/api/.env
 *     /deploy/.env`, and the runner does `COPY --from=builder /deploy ./`. The
 *     shell `cp` launders the path so no final-stage `COPY` ever names a dotenv.
 *   - A templated source (`COPY ${ENV_FILE} .env`) is resolved at build time and
 *     is not knowable offline.
 *   - A glob source (`COPY .env* ./`, `COPY . .`) depends on the build context
 *     and `.dockerignore`, neither of which is decidable from the Dockerfile.
 *   - A destination that is itself a template name (`COPY x .env.example`) is
 *     seeding a placeholder, not shipping values.
 */

/** Dotenv names that hold real values, as opposed to a checked-in template. */
const REAL_DOTENV_RE = /^\.env(\.(production|prod|staging|stage|live|release))?$/i;

/** Flags that may precede the operands: `--from=`, `--chown=`, `--chmod=`, `--link`. */
const FLAG_RE = /^--[a-z]+(=|$)/i;

/** Split a COPY/ADD argument string into operands, ignoring leading flags. */
const operandsOf = (args: string): string[] => {
  // The JSON-array form: COPY ["src", "dest"]
  const trimmed = args.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed as string[];
    } catch {
      /* not valid JSON — fall through to the shell form */
    }
    return [];
  }
  return trimmed.split(/\s+/).filter((token) => token !== "" && !FLAG_RE.test(token));
};

/** The final path segment, for either separator. */
const basename = (path: string): string => {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
};

export const dockerfileCopiesDotenvIntoImage = defineTextDiagnostic({
  id: "dockerfile-copies-dotenv-into-image",
  title: "Dotenv file copied into an image layer",
  severity: "error",
  category: "Security",
  confidence: "high",
  tags: ["container", "secrets", "docker"],
  files: DOCKERFILE_GLOBS,
  maxBytes: 256 * 1024,
  recommendation:
    "Do not put the file in the image. Supply the values as runtime environment variables (compose `environment:`, a k8s Secret, your platform's config), or mount them at build time with `RUN --mount=type=secret,id=env …`, which never lands in a layer. A later `RUN rm .env` does not help — the earlier layer still contains the file, and `docker history` will show it. Rotate anything an already-built image carries.",
  scan: (ctx) => {
    const instructions = parseDockerfile(ctx.content);
    if (!instructions) return;

    for (const instruction of instructions) {
      if (instruction.keyword !== "COPY" && instruction.keyword !== "ADD") continue;

      const operands = operandsOf(instruction.args);
      if (operands.length < 2) continue;
      const destination = operands[operands.length - 1]!;
      const sources = operands.slice(0, -1);

      // `COPY x .env.example` is seeding a placeholder, not shipping values.
      if (!REAL_DOTENV_RE.test(basename(destination)) && /^\.env\./i.test(basename(destination))) continue;

      for (const source of sources) {
        // Resolved at build time — not knowable from this file.
        if (isTemplated(source)) continue;
        // A glob depends on the build context and `.dockerignore`.
        if (/[*?[\]]/.test(source)) continue;
        const name = basename(source);
        if (!REAL_DOTENV_RE.test(name)) continue;

        ctx.report({
          line: instruction.line,
          column: columnOf(instruction, source),
          message: `\`${name}\` is copied into an image layer, and layers are immutable and distributable — \`docker history\`, \`docker save\` and any registry mirror hand the live credentials to anyone who can pull the image. A later \`RUN rm\` does not remove it, because the earlier layer still has it, and the values cannot be rotated without a rebuild. This is invisible to every check that reasons about committed files, since a \`.env\` is gitignored by design. Supply the values at runtime, or mount them with \`RUN --mount=type=secret\`.`,
        });
      }
    }
  },
});
