import { Reveal, CopyCommand } from "../components/ui.tsx";
import { Link } from "../router.tsx";

const CLIENTS = ["Claude Code", "Cursor", "Windsurf", "Codex", "Cline", "GitHub Copilot"];

const MCP_CONFIG = `{
  "mcpServers": {
    "node-doctor": {
      "command": "npx",
      "args": ["node-doctor", "mcp"]
    }
  }
}`;

const TOOLS = [
  ["node_doctor_scan", "Scan a directory → 0–100 score + full findings report."],
  ["node_doctor_diagnostics", "List every diagnostic with category, severity, and gating."],
  ["node_doctor_explain", "Explain one diagnostic: what it catches and the exact fix."],
  ["node_doctor_deslop", "Find unused files, exports, and dependencies."],
];

const QUESTIONS = [
  ["Where does a post-await rejection go?", "Is there a try/catch that calls next(err), or an async wrapper? An unhandled rejection after the first await hangs the client."],
  ["Does anything block the event loop?", "Any *Sync call, a big JSON.parse, a CPU loop, or a catastrophic-backtracking regex on the request path freezes every concurrent request."],
  ["Does it fan out with caller input?", "Promise.all over a caller-supplied array opens one socket per element — bound it, or the first large request is a self-inflicted DoS."],
  ["Where does caller data land?", "Track input to every sink: shell (execFile, not exec), SQL (bound params), the filesystem (containment check), and any eval-family call."],
];

export function AgentPage() {
  return (
    <div className="page-fade">
      <header className="page-head">
        <div className="aurora" />
        <div className="wrap">
          <Link to="/" className="back">
            ← back
          </Link>
          <div className="eyebrow">Agent integration — the thesis</div>
          <h1>Push the knowledge upstream, into the agent that writes the code.</h1>
          <p>
            A linter catches bad code after it's written. node.doctor also ships its knowledge into your
            coding agent — as an installable skill and a native MCP tool — so the code is correct the first
            time.
          </p>
        </div>
      </header>

      <section style={{ paddingTop: 24 }}>
        <div className="wrap">
          <div className="split">
            <Reveal>
              <div className="card">
                <div className="kicker">install the skill</div>
                <CopyCommand text="npx node-doctor@latest install" />
                <p>
                  Writes a thin, locally-bundled skill file into each client. No runtime remote fetch —
                  offline-first.
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                  {CLIENTS.map((c) => (
                    <span className="chip" key={c}>
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            </Reveal>
            <Reveal delay={80}>
              <div className="card">
                <div className="kicker">or run as an MCP server</div>
                <CopyCommand text="npx node-doctor@latest mcp" />
                <p>Register it once and any MCP client can call node.doctor as a native tool:</p>
                <pre className="code">{MCP_CONFIG}</pre>
              </div>
            </Reveal>
          </div>

          <Reveal>
            <div className="tool-list">
              {TOOLS.map(([name, desc]) => (
                <div className="tool" key={name}>
                  <code>{name}</code>
                  <span>{desc}</span>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      <section className="divider">
        <div className="wrap">
          <Reveal>
            <div className="eyebrow">What the skill teaches</div>
            <h2 className="section-title">Run the scanner. Then ask four questions of every handler.</h2>
            <p className="section-lead">
              A clean scan means "no detected defects", never "correct". The scanner is precise and largely
              intra-file — so the skill teaches the reasoning it can't yet automate.
            </p>
          </Reveal>
          <div className="grid-2">
            {QUESTIONS.map(([q, a], i) => (
              <Reveal key={q} delay={i * 60}>
                <div className="card">
                  <div className="kicker">Question 0{i + 1}</div>
                  <h3 style={{ fontSize: 17 }}>{q}</h3>
                  <p style={{ marginBottom: 0 }}>{a}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal>
            <div className="card" style={{ marginTop: 20, borderColor: "var(--brand2)" }}>
              <div className="kicker">the stance on the escape hatch</div>
              <p style={{ marginBottom: 0, fontSize: 15 }}>
                Do <b style={{ color: "var(--ink)" }}>not</b> suppress a diagnostic to make a scan pass. If a
                finding is wrong, say so and explain why — a false positive is a bug in the diagnostic and should
                be reported, not silenced. Every inline suppression must carry a reason; one without a
                reason is itself reported.
              </p>
            </div>
          </Reveal>
        </div>
      </section>
    </div>
  );
}
