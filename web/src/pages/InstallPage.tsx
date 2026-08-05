import { CopyCommand, Reveal } from "../components/ui.tsx";
import { Link } from "../router.tsx";

const PKG = "@dhiravpatel/node-doctor";

const FIRST_OUTPUT = `  node.doctor v1.0.0  checkout-service
  148 files · 21,904 lines · 74/137 diagnostics active
  detected: typescript esm express prisma

  ██████░░░░░░░░░░░░░░░░░░░░░░░░  21/100  critical
  38 errors · 17 warnings · 71.4 weighted/kLOC

  Security (19)
  ✖ SQL built by string interpolation · 6 sites
     src/orders/repository.ts:88:24
     → Use parameter binding: db.query("… WHERE id = $1", [id])
     node-doctor/no-sql-template-interpolation`;

const CONFIG = `// node-doctor.config.js
export default {
  // Rules that are noisy on YOUR codebase, off — with a reason.
  diagnostics: {
    "no-console-log-in-committed-code": "off",
    "max-function-length": "warn",
  },
  // Opt into the precision-first rules you want.
  //   node-doctor diagnostics --off   lists everything currently disabled.
  ignore: ["**/legacy/**", "**/*.generated.ts"],
};`;

const RATCHET = `# Pin today's debt. The build now fails only on NEW findings.
npx ${PKG}@latest ratchet init

# In CI:
npx ${PKG}@latest ratchet check`;

/** One numbered step of the walkthrough. */
function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Reveal>
      <section className="step">
        <div className="step-n">{n}</div>
        <div className="step-body">
          <h3>{title}</h3>
          {children}
        </div>
      </section>
    </Reveal>
  );
}

export function InstallPage() {
  return (
    <div className="page-fade">
      <header className="page-head">
        <div className="aurora" />
        <div className="wrap">
          <Link to="/" className="back">
            ← back
          </Link>
          <div className="eyebrow">Installation &amp; usage</div>
          <h1>From nothing to a scored codebase in one command.</h1>
          <p>
            node.doctor is a single CLI with no service to sign up for, no config to write, and no
            network call. It reads your code on your machine and prints what it finds. Everything
            below is optional except step&nbsp;1.
          </p>
        </div>
      </header>

      <div className="wrap page-body">
        <Step n={1} title="Run it — no install required">
          <p>
            <code>npx</code> fetches and runs the latest version. Nothing is added to your project,
            so this is safe to try on a repository you do not own.
          </p>
          <CopyCommand text={`npx ${PKG}@latest .`} />
          <p className="muted">
            Requires <b>Node 20.19+</b>. The first run takes a few seconds while npm downloads the
            package; after that it is cached.
          </p>
          <pre className="term">
            <code>{FIRST_OUTPUT}</code>
          </pre>
          <p>
            The score is computed from a published formula on your machine — no telemetry, no
            account, and the same input always gives the same number. Every finding names the rule
            that produced it, so you can look it up or turn it off.
          </p>
        </Step>

        <Step n={2} title="Install it into the project (optional)">
          <p>
            Add it as a dev dependency when you want a pinned version and a short script rather than
            a network fetch on every run.
          </p>
          <CopyCommand text={`npm install --save-dev ${PKG}`} />
          <p>
            Then add a script to <code>package.json</code>:
          </p>
          <pre className="term">
            <code>{`{
  "scripts": {
    "lint:doctor": "node-doctor ."
  }
}`}</code>
          </pre>
          <p className="muted">
            The binary is called <code>node-doctor</code> even though the package is scoped, so
            every command on this site works unchanged.
          </p>
        </Step>

        <Step n={3} title="Read the report">
          <p>Three commands cover most of what you need on day one:</p>
          <CopyCommand text="node-doctor ." />
          <p className="muted">Scan the current directory and print the score plus findings.</p>
          <CopyCommand text="node-doctor . --json" />
          <p className="muted">
            The same report as machine-readable JSON — the shape is versioned by{" "}
            <code>schemaVersion</code>, so you can build on it.
          </p>
          <CopyCommand text="node-doctor explain no-sql-template-interpolation" />
          <p className="muted">
            Why a rule exists, what it is looking for, and what it deliberately stays silent on.
          </p>
        </Step>

        <Step n={4} title="Tune it to your codebase">
          <p>
            Roughly a third of the catalog is <b>opt-in</b>: rules that are correct but noisy on
            some architectures ship disabled rather than trained into being ignored. Generate a
            config and adjust:
          </p>
          <CopyCommand text="node-doctor init" />
          <pre className="term">
            <code>{CONFIG}</code>
          </pre>
          <p>
            You can also silence a single line in place, and node.doctor requires you to say why —
            a suppression with no reason is itself a finding:
          </p>
          <pre className="term">
            <code>{`// node-doctor-disable-next-line no-weak-hash-for-password -- legacy checksum, not a password
const digest = createHash("md5").update(input).digest("hex");`}</code>
          </pre>
        </Step>

        <Step n={5} title="Adopt it on an existing codebase">
          <p>
            Pointing any analyzer at a mature repository finds hundreds of pre-existing issues, and
            the check gets disabled within a week. The <b>ratchet</b> pins today's findings as
            accepted debt and fails only on what a change actually introduces — and it can only
            tighten.
          </p>
          <pre className="term">
            <code>{RATCHET}</code>
          </pre>
          <p className="muted">
            See <Link to="/ci">CI setup</Link> for the baseline-delta alternative, which compares a
            PR against its own base branch instead of a committed file.
          </p>
        </Step>

        <Step n={6} title="Put it in front of your agent">
          <p>
            The rules matter most <i>before</i> the code is written. node.doctor installs itself as
            a skill into Claude Code, Cursor and friends, and runs as an MCP server so an agent can
            check its own work.
          </p>
          <CopyCommand text="node-doctor install" />
          <CopyCommand text="node-doctor mcp" />
          <p className="muted">
            More on the <Link to="/agent">agent skill</Link> page.
          </p>
        </Step>

        <Reveal>
          <section className="callout">
            <h3>Beyond the linter</h3>
            <p>
              Once a scan is clean, the same engine answers questions a linter cannot. Each is one
              command:
            </p>
            <ul className="cmd-list">
              <li>
                <code>node-doctor paths</code> — proof a finding is reachable: the source→sink chain
                from request handler to the injection sink, with <code>file:line</code> at every hop
              </li>
              <li>
                <code>node-doctor data-map</code> — which routes touch which database tables, and
                whether they read, write or delete
              </li>
              <li>
                <code>node-doctor architecture</code> — import cycles and layer violations
              </li>
              <li>
                <code>node-doctor openapi</code> — an OpenAPI 3.1 spec generated from the routes
                themselves, so the docs cannot drift
              </li>
              <li>
                <code>node-doctor review --diff main</code> — who should review a change, and how
                hard, from its blast radius
              </li>
              <li>
                <code>node-doctor context</code> — files an AI agent must never read, and the ignore
                rules to fence them off
              </li>
            </ul>
            <p className="muted">
              <code>node-doctor --help</code> lists all of them.
            </p>
          </section>
        </Reveal>

        <Reveal>
          <section className="callout">
            <h3>Troubleshooting</h3>
            <dl className="faq">
              <dt>“command not found: node-doctor”</dt>
              <dd>
                You installed it locally rather than globally. Use <code>npx node-doctor .</code>{" "}
                inside the project, or add it as an npm script (step&nbsp;2).
              </dd>
              <dt>It found nothing on a project I know has problems</dt>
              <dd>
                Check the header line — it prints how many diagnostics are active. Many are gated on
                what your project actually uses, and the opt-in ones start disabled. Run{" "}
                <code>node-doctor diagnostics</code> to see every rule and why it is on or off.
              </dd>
              <dt>A finding is wrong</dt>
              <dd>
                That is a bug, not something to suppress. A false positive is treated as a release
                blocker in this project — please{" "}
                <Link to="https://github.com/DhiravPatel/node_doctor/issues">open an issue</Link>{" "}
                with the snippet.
              </dd>
              <dt>It exits 1 and fails my build</dt>
              <dd>
                That is the CI gate doing its job. Use <code>--blocking none</code> to always exit
                0, or <code>--blocking error</code> to fail only on errors.
              </dd>
            </dl>
          </section>
        </Reveal>
      </div>
    </div>
  );
}
