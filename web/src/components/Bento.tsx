import { useEffect, useState } from "react";
import { Link } from "../router.tsx";
import { DEMOS } from "../data/site.ts";
import { IconArrow, IconScan, IconAgent } from "./Icons.tsx";
import rulesData from "../data/diagnostics.json";

const statusColor = (s: number): string => (s >= 75 ? "var(--good)" : s >= 50 ? "var(--warning)" : "var(--critical)");
const reduced = (): boolean => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function MiniRing({ score }: { score: number }) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const color = statusColor(score);
  return (
    <div className="mini-ring">
      <svg width="104" height="104" viewBox="0 0 104 104">
        <circle cx="52" cy="52" r={r} fill="none" stroke="var(--s3)" strokeWidth="9" />
        <circle
          cx="52" cy="52" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)}
          transform="rotate(-90 52 52)" style={{ transition: "stroke-dashoffset .7s cubic-bezier(.4,0,.2,1), stroke .4s" }}
        />
      </svg>
      <div className="mini-ring-val" style={{ color }}>{score}</div>
    </div>
  );
}

/** Cell 1 — the local health score, toggleable between the two fixtures. */
function VitalsCell() {
  const [which, setWhich] = useState<"bad" | "good">("bad");
  const d = DEMOS[which];
  return (
    <div className="bcell b-vitals">
      <div className="bcell-head">
        <span className="bk">Local health score</span>
        <div className="mini-toggle">
          <button className={which === "bad" ? "on" : ""} onClick={() => setWhich("bad")}>agent-app</button>
          <button className={which === "good" ? "on" : ""} onClick={() => setWhich("good")}>good-app</button>
        </div>
      </div>
      <div className="vitals-body">
        <MiniRing score={d.score} />
        <div>
          <div className="vitals-label" style={{ color: statusColor(d.score) }}>{d.label}</div>
          <div className="vitals-sub mono">{d.errors} err · {d.warnings} warn</div>
          <div className="vitals-sub mono dim">{d.perKloc} weighted / kLOC</div>
        </div>
      </div>
      <div className="bcell-foot">Computed on your machine from a published formula. No server call.</div>
    </div>
  );
}

/** Cell 2 — the same call, module scope vs request path. */
function ContextCell() {
  const [hot, setHot] = useState<0 | 1>(1);
  useEffect(() => {
    if (reduced()) return;
    const id = setInterval(() => setHot((h) => (h ? 0 : 1)), 2600);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="bcell b-context">
      <span className="bk">Context-aware</span>
      <div className="ctx-mini">
        <div className={`cm-line ${hot === 0 ? "cm-safe" : ""}`}>
          <span className="cm-num">1</span>
          <span className="mono">const cfg = <b className="fn">readFileSync</b>(p)</span>
          <span className="cm-badge">module</span>
        </div>
        <div className="cm-line mono dim"><span className="cm-num">2</span><span>app.get("/r", (req, res) =&gt; {"{"}</span></div>
        <div className={`cm-line ${hot === 1 ? "cm-danger" : ""}`}>
          <span className="cm-num">3</span>
          <span className="mono">&nbsp;&nbsp;<b className="fn">readFileSync</b>(p)</span>
          <span className="cm-badge">handler</span>
        </div>
      </div>
      <div className={`ctx-verdict-mini ${hot === 0 ? "ok" : "bad"}`}>
        {hot === 0 ? "✓ one-time boot cost — silent" : "✖ blocks every request — flagged"}
      </div>
    </div>
  );
}

/** Cell 3 — CI baseline delta. */
function DeltaCell() {
  return (
    <Link to="/ci" className="bcell b-delta linkcell">
      <span className="bk">CI baseline delta</span>
      <div className="delta-rows">
        <div className="delta-row res"><span>−1</span> resolved</div>
        <div className="delta-row add"><span>+2</span> introduced</div>
      </div>
      <div className="bcell-foot">Only the findings your PR added. <span className="go">setup <IconArrow className="arrow" /></span></div>
    </Link>
  );
}

/** Cell 4 — diagnostic ticker. */
function RulesCell() {
  const ids = (rulesData.diagnostics as { id: string; severity: string }[]).map((r) => r.id);
  const loop = [...ids, ...ids];
  return (
    <Link to="/diagnostics" className="bcell b-diagnostics linkcell">
      <span className="bk">The diagnostics</span>
      <div className="diagnostics-num">{rulesData.total}<span> diagnostics</span></div>
      <div className="ticker">
        <div className="ticker-track">
          {loop.map((id, i) => (
            <span className="tk mono" key={i}>node-doctor/{id}</span>
          ))}
        </div>
      </div>
      <div className="bcell-foot"><span className="go">browse <IconArrow className="arrow" /></span></div>
    </Link>
  );
}

/** Cell 5 — offline / no telemetry. */
function OfflineCell() {
  return (
    <div className="bcell b-offline">
      <div className="off-cloud">
        <IconScan />
        <span className="off-slash" />
      </div>
      <div className="off-num">0</div>
      <div className="bk">network calls · no telemetry</div>
    </div>
  );
}

/** Cell 6 — MCP + agent. */
function McpCell() {
  return (
    <Link to="/agent" className="bcell b-mcp linkcell">
      <div className="mcp-ico"><IconAgent /></div>
      <span className="bk">Agent skill + MCP server</span>
      <div className="mcp-call mono">
        <span className="mcp-dot" /> node_doctor_scan()
      </div>
      <div className="bcell-foot">Callable as a native tool. <span className="go">wire it up <IconArrow className="arrow" /></span></div>
    </Link>
  );
}

export function Bento() {
  return (
    <div className="bento">
      <VitalsCell />
      <ContextCell />
      <RulesCell />
      <McpCell />
      <DeltaCell />
      <OfflineCell />
    </div>
  );
}
