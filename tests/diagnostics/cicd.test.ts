import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTextScan, type TextDiagnostic } from "../../src/core/text-scan.ts";
import type { NodeDoctorConfig } from "../../src/core/config.ts";
import { ciScriptInjection } from "../../src/diagnostics/cicd/ci-script-injection.ts";
import { ciUnpinnedAction } from "../../src/diagnostics/cicd/ci-unpinned-action.ts";
import { ciPullRequestTargetCheckout } from "../../src/diagnostics/cicd/ci-pull-request-target-checkout.ts";

const CICD: TextDiagnostic[] = [ciScriptInjection, ciUnpinnedAction, ciPullRequestTargetCheckout];

/** Run the CI/CD diagnostics over one fabricated workflow file. */
const scan = async (
  content: string,
  options: { name?: string; config?: NodeDoctorConfig } = {},
): Promise<string[]> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-cicd-"));
  try {
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await writeFile(join(dir, ".github", "workflows", options.name ?? "ci.yml"), content);
    const findings = await runTextScan(dir, { textDiagnostics: CICD, config: options.config });
    return findings.map((f) => f.diagnostic).sort();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** `ci-unpinned-action` is opt-in, so it needs an explicit config entry. */
const OPT_IN: NodeDoctorConfig = { diagnostics: { "ci-unpinned-action": "warn" } };

const lineOf = async (content: string, diagnostic: string): Promise<number> => {
  const dir = await mkdtemp(join(tmpdir(), "nd-cicd-"));
  try {
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await writeFile(join(dir, ".github", "workflows", "ci.yml"), content);
    const findings = await runTextScan(dir, { textDiagnostics: CICD, config: OPT_IN });
    const hit = findings.find((f) => f.diagnostic === diagnostic);
    return hit ? hit.line : -1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("ci-script-injection", () => {
  test("fires on an issue title interpolated into an inline run", async () => {
    const yml = [
      "on: issues",
      "jobs:",
      "  triage:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      '      - run: echo "${{ github.event.issue.title }}"',
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), ["ci-script-injection"]);
    assert.equal(await lineOf(yml, "ci-script-injection"), 6);
  });

  test("fires inside a multi-line run block", async () => {
    const yml = [
      "on: issue_comment",
      "jobs:",
      "  a:",
      "    steps:",
      "      - name: reply",
      "        run: |",
      "          set -e",
      "          echo ${{ github.event.comment.body }}",
      "      - run: echo done",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), ["ci-script-injection"]);
    assert.equal(await lineOf(yml, "ci-script-injection"), 8);
  });

  test("fires on every listed attacker-controlled context", async () => {
    const paths = [
      "github.event.issue.title",
      "github.event.issue.body",
      "github.event.pull_request.title",
      "github.event.pull_request.body",
      "github.event.pull_request.head.ref",
      "github.event.pull_request.head.label",
      "github.event.comment.body",
      "github.event.review.body",
      "github.event.discussion.title",
      "github.event.discussion.body",
      "github.event.head_commit.message",
      "github.event.pages[0].page_name",
      "github.event.pages.*.page_name",
      "github.head_ref",
    ];
    for (const path of paths) {
      const yml = `on: push\njobs:\n  a:\n    steps:\n      - run: echo "\${{ ${path} }}"\n`;
      assert.deepEqual(await scan(yml), ["ci-script-injection"], path);
    }
  });

  test("fires through format() and a fallback expression", async () => {
    const yml = [
      "on: pull_request",
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: echo ${{ format('pr {0}', github.event.pull_request.title) }}",
      "      - run: echo ${{ github.event.issue.body || 'none' }}",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), ["ci-script-injection", "ci-script-injection"]);
  });

  test("SILENT on the documented env-indirection fix — this is the fix, not the bug", async () => {
    const yml = [
      "on: issues",
      "jobs:",
      "  triage:",
      "    steps:",
      "      - name: safe",
      "        env:",
      "          TITLE: ${{ github.event.issue.title }}",
      "          BODY: ${{ github.event.issue.body }}",
      '        run: echo "$TITLE" | grep -q x && echo "$BODY"',
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), []);
  });

  test("SILENT when env: follows a multi-line run block", async () => {
    const yml = [
      "on: issues",
      "jobs:",
      "  triage:",
      "    steps:",
      "      - run: |",
      '          echo "$TITLE"',
      "",
      '          echo "$TITLE" >> report.txt',
      "        env:",
      "          TITLE: ${{ github.event.issue.title }}",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), []);
  });

  test("SILENT on safe, constrained contexts", async () => {
    const safe = [
      "github.sha",
      "github.ref",
      "github.ref_name",
      "github.repository",
      "github.repository_owner",
      "github.actor",
      "github.run_id",
      "github.run_number",
      "github.workspace",
      "github.token",
      "secrets.NPM_TOKEN",
      "env.NODE_VERSION",
      "inputs.environment",
      "matrix.node",
      "needs.build.outputs.artifact",
      "steps.meta.outputs.tags",
      "job.status",
      "runner.os",
      "vars.REGISTRY",
      "github.event.pull_request.number",
      "github.event.pull_request.head.sha",
      "github.event.pull_request.base.ref",
      "github.event.issue.number",
      "github.event.head_commit.id",
    ];
    for (const path of safe) {
      const yml = `on: push\njobs:\n  a:\n    steps:\n      - run: echo "\${{ ${path} }}"\n`;
      assert.deepEqual(await scan(yml), [], path);
    }
  });

  test("SILENT on look-alike identifiers that merely share a prefix", async () => {
    const yml = [
      "on: push",
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: echo ${{ env.github_head_ref }} ${{ inputs.github_event_issue_title }}",
      "      - run: echo ${{ steps.x.outputs.github.head_ref_slug }}",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), []);
  });

  test("SILENT on toJSON(), the other sanctioned escape", async () => {
    const yml = [
      "on: issues",
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: echo '${{ toJSON(github.event.issue.title) }}'",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), []);
  });

  test("SILENT when the expression is under with:, if: or a job-level env:", async () => {
    const yml = [
      "on: pull_request_target",
      "env:",
      "  PR_TITLE: ${{ github.event.pull_request.title }}",
      "jobs:",
      "  a:",
      "    if: contains(github.event.pull_request.title, 'wip')",
      "    steps:",
      "      - uses: actions/github-script@v7",
      "        with:",
      "          body: ${{ github.event.issue.body }}",
      '      - run: echo "$PR_TITLE"',
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), []);
  });

  test("SILENT on a concurrency group — the real-world shape this must not break", async () => {
    // Verbatim from fastify/avvio: the most common legitimate use of head_ref.
    const yml = [
      "on:",
      "  pull_request:",
      "concurrency:",
      '  group: "${{ github.workflow }}-${{ github.event.pull_request.head.label || github.head_ref || github.ref }}"',
      "  cancel-in-progress: true",
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: npm test",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), []);
  });

  test("SILENT on a run block whose shell text merely mentions the context", async () => {
    const yml = [
      "on: push",
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: |",
      "          echo 'set TITLE from github.event.issue.title in env:'",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), []);
  });

  test("SILENT on `defaults: run:` — a settings block, not a script", async () => {
    const yml = [
      "on: issues",
      "defaults:",
      "  run:",
      "    shell: bash",
      "    working-directory: ./app",
      "jobs:",
      "  a:",
      "    steps:",
      '      - run: echo "$TITLE"',
      "        env:",
      "          TITLE: ${{ github.event.issue.title }}",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), []);
  });

  test("SILENT on a `run` input under with: — that is data an action reads, not a script", async () => {
    const yml = [
      "on: issues",
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: some/action@v1",
      "        with:",
      "          run: ${{ github.event.issue.title }}",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), []);
  });

  test("SILENT on a non-workflow YAML that happens to sit in the folder", async () => {
    const yml = "name: not a workflow\ndescription: ${{ github.event.issue.title }}\n";
    assert.deepEqual(await scan(yml, { name: "notes.yml" }), []);
  });

  test("handles CRLF line endings", async () => {
    const yml = [
      "on: issues",
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: |",
      "          echo ${{ github.event.issue.title }}",
      "",
    ].join("\r\n");
    assert.deepEqual(await scan(yml), ["ci-script-injection"]);
  });

  test("is deterministic across repeated runs", async () => {
    const yml = [
      "on: issues",
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: echo ${{ github.event.issue.title }} ${{ github.event.issue.body }}",
      "",
    ].join("\n");
    const first = await scan(yml);
    const second = await scan(yml);
    assert.deepEqual(first, second);
    assert.equal(first.length, 2);
  });
});

describe("ci-unpinned-action", () => {
  test("is opt-in — silent without an explicit config entry", async () => {
    const yml = "on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n";
    assert.deepEqual(await scan(yml), []);
  });

  test("fires on a version tag once enabled", async () => {
    const yml = "on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n";
    assert.deepEqual(await scan(yml, { config: OPT_IN }), ["ci-unpinned-action"]);
  });

  test("fires on a branch ref", async () => {
    const yml = "on: push\njobs:\n  a:\n    steps:\n      - uses: some/action@main\n";
    assert.deepEqual(await scan(yml, { config: OPT_IN }), ["ci-unpinned-action"]);
  });

  test("SILENT on a 40-hex commit SHA, with or without a version comment", async () => {
    const sha = "08c6903cd8c0fde910a37f88322edcfb5dd907a8";
    const yml = [
      "on: push",
      "jobs:",
      "  a:",
      "    steps:",
      `      - uses: actions/checkout@${sha}`,
      `      - uses: actions/setup-node@${sha}  # v4.0.2`,
      `      - uses: "actions/cache@${sha}"`,
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml, { config: OPT_IN }), []);
  });

  test("SILENT on a local action", async () => {
    const yml = [
      "on: push",
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: ./.github/actions/setup",
      "      - uses: ../shared/action",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml, { config: OPT_IN }), []);
  });

  test("SILENT on a docker action", async () => {
    const yml = [
      "on: push",
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: docker://alpine:3.19",
      "      - uses: docker://ghcr.io/owner/image:latest",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml, { config: OPT_IN }), []);
  });

  test("SILENT on a computed uses: — it cannot be resolved offline", async () => {
    const yml = "on: push\njobs:\n  a:\n    steps:\n      - uses: ${{ matrix.action }}@${{ matrix.ref }}\n";
    assert.deepEqual(await scan(yml, { config: OPT_IN }), []);
  });

  test("SILENT on shell text inside a run block that mentions uses:", async () => {
    const yml = [
      "on: push",
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: |",
      '          echo "uses: actions/checkout@v4" >> generated.yml',
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml, { config: OPT_IN }), []);
  });

  test("SILENT on a mistyped SHA pin — broken, but not a mutable ref", async () => {
    // n8n ships exactly this: 41 hex characters where 40 were intended.
    const yml =
      "on: push\njobs:\n  a:\n    steps:\n      - uses: actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a0 # v3.0.0\n";
    assert.deepEqual(await scan(yml, { config: OPT_IN }), []);
  });

  test("SILENT on a `uses` input under with:", async () => {
    const yml = [
      "on: push",
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8",
      "      - uses: some/runner@08c6903cd8c0fde910a37f88322edcfb5dd907a8",
      "        with:",
      "          uses: node:20",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml, { config: OPT_IN }), []);
  });

  test("fires on a reusable workflow pinned to a tag", async () => {
    const yml = "on: push\njobs:\n  a:\n    uses: owner/repo/.github/workflows/release.yml@v1\n";
    assert.deepEqual(await scan(yml, { config: OPT_IN }), ["ci-unpinned-action"]);
  });
});

describe("ci-pull-request-target-checkout", () => {
  const dangerous = (trigger: string, ref: string): string =>
    [
      trigger,
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "        with:",
      `          ref: ${ref}`,
      "      - run: npm ci && npm test",
      "",
    ].join("\n");

  test("fires on pull_request_target checking out the head sha", async () => {
    const yml = dangerous("on: pull_request_target", "${{ github.event.pull_request.head.sha }}");
    assert.deepEqual(await scan(yml), ["ci-pull-request-target-checkout"]);
    assert.equal(await lineOf(yml, "ci-pull-request-target-checkout"), 8);
  });

  test("fires on head.ref, github.head_ref, merge_commit_sha and refs/pull", async () => {
    for (const ref of [
      "${{ github.event.pull_request.head.ref }}",
      "${{ github.head_ref }}",
      "${{ github.event.pull_request.merge_commit_sha }}",
      "refs/pull/${{ github.event.number }}/merge",
    ]) {
      assert.deepEqual(await scan(dangerous("on: pull_request_target", ref)), [
        "ci-pull-request-target-checkout",
      ], ref);
    }
  });

  test("fires for every spelling of the trigger", async () => {
    const ref = "${{ github.event.pull_request.head.sha }}";
    const triggers = [
      "on: pull_request_target",
      "on: [push, pull_request_target]",
      'on:\n  pull_request_target:\n    types: [opened, synchronize]',
      "on:\n  - push\n  - pull_request_target",
      '"on":\n  pull_request_target:\n    branches: [main]',
    ];
    for (const trigger of triggers) {
      assert.deepEqual(await scan(dangerous(trigger, ref)), ["ci-pull-request-target-checkout"], trigger);
    }
  });

  test("fires on the inline flow-mapping form of with:", async () => {
    const yml = [
      "on: pull_request_target",
      "jobs:",
      "  a:",
      "    steps:",
      '      - uses: actions/checkout@v4',
      '        with: { ref: "${{ github.event.pull_request.head.sha }}" }',
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), ["ci-pull-request-target-checkout"]);
  });

  test("fires when the checkout step leads with name: and follows other steps", async () => {
    const yml = [
      "on:",
      "  pull_request_target:",
      "    branches:",
      "      - main",
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 20",
      "      - name: Checkout PR",
      "        uses: actions/checkout@v4",
      "        with:",
      "          repository: ${{ github.event.pull_request.head.repo.full_name }}",
      "          ref: ${{ github.event.pull_request.head.ref }}",
      "      - run: yarn install",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), ["ci-pull-request-target-checkout"]);
    assert.equal(await lineOf(yml, "ci-pull-request-target-checkout"), 15);
  });

  test("SILENT on a plain pull_request trigger — that is the safe design", async () => {
    const yml = dangerous("on: pull_request", "${{ github.event.pull_request.head.sha }}");
    assert.deepEqual(await scan(yml), []);
  });

  test("SILENT on pull_request_target that does not check out the head", async () => {
    const yml = [
      "on: pull_request_target",
      "jobs:",
      "  label:",
      "    steps:",
      "      - uses: actions/labeler@v5",
      "      - uses: actions/checkout@v4",
      "      - run: echo hello",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), []);
  });

  test("SILENT on pull_request_target checking out the base", async () => {
    for (const ref of ["${{ github.event.pull_request.base.sha }}", "main", "${{ github.base_ref }}"]) {
      assert.deepEqual(await scan(dangerous("on: pull_request_target", ref)), [], ref);
    }
  });

  test("SILENT when the head ref belongs to a different step", async () => {
    const yml = [
      "on: pull_request_target",
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: some/other-action@v1",
      "        with:",
      "          ref: ${{ github.event.pull_request.head.sha }}",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), []);
  });

  test("SILENT when a run block merely mentions the head sha", async () => {
    const yml = [
      "on: pull_request_target",
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - run: |",
      "          echo 'do not use ref: github.event.pull_request.head.sha here'",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), []);
  });

  test("SILENT on the real-world label/rebase workflows that need the write token", async () => {
    // Verbatim shapes from ljharb's `string.prototype.includes`: both use
    // pull_request_target legitimately and neither checks out the fork's code.
    const rebase = [
      "name: Automatic Rebase",
      "on: [pull_request_target]",
      "jobs:",
      "  _:",
      "    uses: ljharb/actions/.github/workflows/rebase.yml@main",
      "    secrets:",
      "      token: ${{ secrets.GITHUB_TOKEN }}",
      "",
    ].join("\n");
    const allowEdits = [
      "name: Require Allow Edits",
      "on: [pull_request_target]",
      "jobs:",
      "  _:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: ljharb/require-allow-edits@main",
      "",
    ].join("\n");
    assert.deepEqual(await scan(rebase), []);
    assert.deepEqual(await scan(allowEdits), []);
  });

  test("SILENT on a workflow with no pull_request_target trigger at all", async () => {
    const yml = dangerous("on:\n  workflow_run:\n    workflows: [ci]", "${{ github.head_ref }}");
    assert.deepEqual(await scan(yml), []);
  });

  test("reports once per checkout step, not once per matching line", async () => {
    const yml = [
      "on: pull_request_target",
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "        with:",
      "          ref: ${{ github.event.pull_request.head.sha }}",
      "          persist-credentials: false",
      "  b:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "        with:",
      "          ref: ${{ github.head_ref }}",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml), [
      "ci-pull-request-target-checkout",
      "ci-pull-request-target-checkout",
    ]);
  });
});

describe("a realistic release workflow stays silent on all three", () => {
  test("no findings on a well-formed pipeline", async () => {
    const yml = [
      "name: CI",
      "on:",
      "  push:",
      "    branches: [main]",
      "  pull_request:",
      "permissions:",
      "  contents: read",
      "env:",
      "  NODE_VERSION: 20",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    strategy:",
      "      matrix:",
      "        node: [20, 22]",
      "    steps:",
      "      - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8  # v4.1.1",
      "      - uses: actions/setup-node@60edb5dd545a775178f52524783378180af0d1f8  # v4.0.2",
      "        with:",
      "          node-version: ${{ matrix.node }}",
      "      - run: npm ci",
      "      - name: Test",
      "        run: |",
      "          npm test -- --reporter=spec",
      "          echo \"tested ${{ github.sha }} on ${{ runner.os }}\"",
      "        env:",
      "          CI: 'true'",
      "      - name: Comment",
      "        if: github.event_name == 'pull_request'",
      "        env:",
      "          PR_TITLE: ${{ github.event.pull_request.title }}",
      '        run: echo "$PR_TITLE" > title.txt',
      "      - uses: ./.github/actions/upload",
      "",
    ].join("\n");
    assert.deepEqual(await scan(yml, { config: OPT_IN }), []);
  });
});
