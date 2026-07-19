import { Reveal, CopyCommand, Tilt, useSpotlight } from "../components/ui.tsx";
import { DiagnosticPanel } from "../components/DiagnosticPanel.tsx";
import { Marquee } from "../components/Marquee.tsx";
import { Bento } from "../components/Bento.tsx";
import { Pipeline } from "../components/Pipeline.tsx";
import { Link } from "../router.tsx";
import { PROBLEMS, COMPARISON } from "../data/site.ts";
import rulesData from "../data/diagnostics.json";
import { IconAsync, IconBolt, IconSpread, IconInject, IconArrow } from "../components/Icons.tsx";

const GITHUB = "https://github.com/your-org/node-doctor";
const INSTALL = "npx node-doctor@latest .";

const FRAMEWORKS = [
  "Express", "Fastify", "Nest", "Hono", "Koa", "Adonis", "Prisma", "Drizzle",
  "Knex", "Mongoose", "TypeORM", "Sequelize", "jsonwebtoken", "TypeScript", "ESM · CJS",
];
const PROBLEM_ICONS = [IconAsync, IconBolt, IconSpread, IconInject];

function Hero() {
  const spot = useSpotlight<HTMLElement>();
  return (
    <header className="hero hero-spot" ref={spot.ref} onMouseMove={spot.onMouseMove}>
      <div className="aurora" />
      <div className="wrap hero-grid">
        <div>
          <span className="badge-pill">
            <span className="live" /> v0.1 · 62 diagnostics · offline &amp; deterministic
          </span>
          <h1>
            Your agent writes <span className="grad-text">bad Node.</span>
            <br />
            This catches it.
          </h1>
          <p className="lead">
            Deterministic static analysis for Node.js backends — built for the defect that compiles, passes
            the test, runs fine on your machine, and falls over the moment two requests arrive at once.
          </p>
          <CopyCommand text={INSTALL} />
          <div className="cta-row">
            <Link to="/diagnostics" className="btn btn-primary">
              Explore the {rulesData.total} diagnostics <IconArrow className="arrow" />
            </Link>
            <Link to={GITHUB} className="btn btn-ghost">Read the source</Link>
          </div>
          <div className="chips">
            <span className="chip"><b>offline</b> · no network calls</span>
            <span className="chip"><b>deterministic</b> · byte-stable</span>
            <span className="chip"><b>zero-config</b> · reads your manifest</span>
          </div>
        </div>
        <Tilt max={4}>
          <DiagnosticPanel />
        </Tilt>
      </div>

      <div className="wrap" style={{ marginTop: 46 }}>
        <div className="strip-label">Understands your stack — version-aware, framework-aware</div>
        <Marquee items={FRAMEWORKS} />
      </div>
    </header>
  );
}

function BentoSection() {
  return (
    <section className="divider">
      <div className="wrap">
        <Reveal>
          <div className="eyebrow">Everything, local</div>
          <h2 className="section-title xl">One command. The whole diagnosis.</h2>
          <p className="section-lead">
            A health score, a 62-check catalog, cross-file analysis, a PR baseline delta, and an agent-callable
            MCP server — all offline, all on your machine.
          </p>
        </Reveal>
        <Reveal>
          <Bento />
        </Reveal>
      </div>
    </section>
  );
}

function Problems() {
  return (
    <section className="divider">
      <div className="wrap">
        <Reveal>
          <div className="eyebrow">The problem it solves</div>
          <h2 className="section-title xl">Four ways agent-written backends fall over.</h2>
          <p className="section-lead">
            Each is correct in isolation and wrong under load — so it passes review and ships. Each is a whole
            family of diagnostics.
          </p>
        </Reveal>
        <div className="grid-2">
          {PROBLEMS.map((p, i) => {
            const Icon = PROBLEM_ICONS[i]!;
            return (
              <Reveal key={p.kicker} delay={i * 60}>
                <div className="card icard">
                  <span className="num-badge">0{i + 1}</span>
                  <span className="ic"><Icon /></span>
                  <h3>{p.title}</h3>
                  <p>{p.body}</p>
                  <pre className="code">
                    {p.code.map((seg, j) => (<span key={j} className={seg.c}>{seg.t}</span>))}
                  </pre>
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function PipelineSection() {
  return (
    <section className="divider">
      <div className="wrap">
        <Reveal>
          <div className="eyebrow">How it works</div>
          <h2 className="section-title">A scan is a pipeline — and it explains what it can and can't catch.</h2>
        </Reveal>
        <Reveal>
          <Pipeline />
        </Reveal>
      </div>
    </section>
  );
}

function Comparison() {
  const cell = (v: boolean | "partial") =>
    v === true ? <span className="yes">✓</span> : v === "partial" ? <span className="no">partial</span> : <span className="no">—</span>;
  return (
    <section className="divider">
      <div className="wrap">
        <Reveal>
          <div className="eyebrow">Why not just ESLint</div>
          <h2 className="section-title">A focused complement, not a replacement.</h2>
          <p className="section-lead">
            Keep ESLint for style and the hundreds of general-purpose diagnostics it does brilliantly. node.doctor
            targets the load-dependent defects that are hard to express as a generic diagnostic.
          </p>
        </Reveal>
        <Reveal>
          <div className="table-scroll">
            <table className="cmp">
              <thead>
                <tr>{COMPARISON.cols.map((c, i) => (<th key={i} className={i === 2 ? "self" : ""}>{c || "Capability"}</th>))}</tr>
              </thead>
              <tbody>
                {COMPARISON.rows.map((row) => (
                  <tr key={row[0] as string}>
                    <td>{row[0]}</td>
                    <td>{cell(row[1])}</td>
                    <td className="self">{cell(row[2])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function CtaBand() {
  return (
    <section className="divider">
      <div className="wrap">
        <Reveal>
          <div className="cta-band">
            <div className="eyebrow" style={{ justifyContent: "center", display: "inline-flex" }}>ship it clean</div>
            <h2>Point it at your service. See the score in a second.</h2>
            <CopyCommand text={INSTALL} />
            <div className="cta-row" style={{ justifyContent: "center", marginTop: 22 }}>
              <Link to="/diagnostics" className="btn btn-primary">Explore the diagnostics <IconArrow className="arrow" /></Link>
              <Link to="/agent" className="btn btn-ghost">Install the agent skill</Link>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export function Home() {
  return (
    <div className="page-fade">
      <Hero />
      <BentoSection />
      <Problems />
      <PipelineSection />
      <Comparison />
      <CtaBand />
    </div>
  );
}
