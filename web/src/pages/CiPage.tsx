import { Reveal } from "../components/ui.tsx";
import { Link } from "../router.tsx";

const WORKFLOW = `name: node-doctor
on: pull_request
jobs:
  scan:
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: |
          git checkout --detach origin/\${{ github.base_ref }}
          npx node-doctor@latest . --json-out /tmp/base.json --blocking none
          git checkout --detach \${{ github.sha }}
          npx node-doctor@latest . --json-out /tmp/head.json --blocking none
          npx node-doctor@latest delta \\
            --baseline /tmp/base.json --current /tmp/head.json \\
            --blocking error`;

const DELTA_OUT = `  ✓ 1 finding resolved by this change

  2 new findings introduced:

  ✖ src/invoices/routes.ts:94:26
    Async route handler with no error path
    → Wrap the handler or add try/catch that calls next(error).
    node-doctor/express-async-handler-unprotected`;

const GITLAB = `node-doctor:
  image: node:20
  script:
    - git fetch origin $CI_MERGE_REQUEST_TARGET_BRANCH_NAME
    - git checkout FETCH_HEAD
    - npx node-doctor@latest . --json-out base.json --blocking none
    - git checkout $CI_COMMIT_SHA
    - npx node-doctor@latest . --json-out head.json --blocking none
    - npx node-doctor@latest delta --baseline base.json --current head.json --blocking error
  diagnostics:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"`;

export function CiPage() {
  return (
    <div className="page-fade">
      <header className="page-head">
        <div className="aurora" />
        <div className="wrap">
          <Link to="/" className="back">
            ← back
          </Link>
          <div className="eyebrow">Continuous integration</div>
          <h1>Adoptable on a legacy codebase from day one.</h1>
          <p>
            Point any analyzer at a large existing codebase and it finds thousands of pre-existing issues.
            The <b style={{ color: "var(--ink)" }}>baseline delta</b> reports only the findings your PR
            introduced — so the first PR after adoption isn't buried, and the check never gets disabled.
          </p>
        </div>
      </header>

      <section style={{ paddingTop: 24 }}>
        <div className="wrap">
          <Reveal>
            <div className="eyebrow">How it works</div>
            <h2 className="section-title">Scan base, scan head, report the difference.</h2>
          </Reveal>
          <div className="steps">
            {[
              ["Scan the base branch", "Informational only — runs with --blocking none and writes a JSON baseline. It never fails the job."],
              ["Scan the head branch", "The same scan on your PR's commit, written to a second JSON report."],
              ["Diff by stable id", "node-doctor delta reports only findings the PR introduced (and, for context, those it resolved). Pre-existing issues are ignored."],
              ["Enforce policy on the delta", "Only the delta step blocks — on the introduced set alone, at the severity you choose."],
            ].map(([h, p]) => (
              <div className="step" key={h}>
                <span className="num" />
                <div>
                  <h4>{h}</h4>
                  <p>{p}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="split">
            <Reveal>
              <div className="card">
                <div className="kicker">.github/workflows/node-doctor.yml</div>
                <pre className="code">{WORKFLOW}</pre>
              </div>
            </Reveal>
            <Reveal delay={80}>
              <div className="card">
                <div className="kicker">example delta output</div>
                <pre className="code">{DELTA_OUT}</pre>
                <p style={{ marginTop: 14, marginBottom: 0, color: "var(--ink3)", fontSize: 13 }}>
                  Findings carry a deterministic id (hash of location + diagnostic + message), so an unchanged
                  finding matches across the two scans and never re-reports.
                </p>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="divider">
        <div className="wrap">
          <Reveal>
            <div className="eyebrow">Other setups</div>
            <h2 className="section-title">GitLab, pre-commit, or a plain script.</h2>
          </Reveal>
          <div className="split">
            <Reveal>
              <div className="card">
                <div className="kicker">.gitlab-ci.yml</div>
                <pre className="code">{GITLAB}</pre>
              </div>
            </Reveal>
            <Reveal delay={80}>
              <div className="card">
                <div className="kicker">package.json + husky</div>
                <pre className="code">{`{
  "scripts": {
    "precommit:node-doctor": "node-doctor . --blocking error"
  }
}

# .husky/pre-commit
npm run precommit:node-doctor`}</pre>
                <p style={{ marginTop: 14, marginBottom: 0, color: "var(--ink3)", fontSize: 13 }}>
                  Exit codes: 0 = no blocking findings, 1 = blocking findings, 2 = tool error.
                </p>
              </div>
            </Reveal>
          </div>
        </div>
      </section>
    </div>
  );
}
