import { useEffect, useState } from "react";
import { Ekg } from "./Ekg.tsx";

type Seg = { t: string; c?: string };

const CODE: Seg[][] = [
  [{ t: "app.", c: "" }, { t: "post", c: "fn" }, { t: '("/pay", ', c: "" }, { t: "async", c: "kw" }, { t: " (req, res) => {", c: "" }],
  [{ t: "  const { id } = req.body", c: "" }],
  [{ t: "  const rows = db.", c: "" }, { t: "query", c: "fn" }, { t: "(", c: "" }, { t: "`…${id}`", c: "str" }, { t: ")", c: "" }],
  [{ t: "  const tpl = ", c: "" }, { t: "fs.readFileSync", c: "fn" }, { t: "(p)", c: "" }],
  [{ t: "  ", c: "" }, { t: "await", c: "kw" }, { t: " Promise.all(ids.", c: "" }, { t: "map", c: "fn" }, { t: "(f))", c: "" }],
  [{ t: "  res.send(render(tpl))", c: "" }],
  [{ t: "})", c: "" }],
];

const FINDINGS = [
  { line: 3, sev: "err" as const, label: "SQL injection", diagnostic: "no-sql-template-interpolation", score: 68 },
  { line: 4, sev: "err" as const, label: "Sync I/O on request path", diagnostic: "no-sync-io-in-request-path", score: 42 },
  { line: 5, sev: "warn" as const, label: "Unbounded fan-out", diagnostic: "no-unbounded-promise-all", score: 21 },
];

const reduced = (): boolean =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const tone = (score: number): "good" | "warn" | "crit" => (score >= 75 ? "good" : score >= 50 ? "warn" : "crit");
const label = (score: number): string => (score >= 75 ? "healthy" : score >= 50 ? "needs work" : "critical");

export function DiagnosticPanel() {
  const r = reduced();
  const [shown, setShown] = useState(r ? FINDINGS.length : 0);
  const [score, setScore] = useState(r ? 21 : 100);
  const [scanning, setScanning] = useState(!r);

  useEffect(() => {
    if (r) return;
    let cancelled = false;
    let handles: ReturnType<typeof setTimeout>[] = [];
    const clearAll = (): void => {
      handles.forEach(clearTimeout);
      handles = [];
    };
    const run = (): void => {
      if (cancelled) return;
      clearAll();
      setShown(0);
      setScore(100);
      setScanning(true);
      FINDINGS.forEach((f, i) => {
        handles.push(
          setTimeout(() => {
            setShown(i + 1);
            setScore(f.score);
          }, 1150 + i * 820),
        );
      });
      handles.push(setTimeout(() => setScanning(false), 1150 + FINDINGS.length * 820));
      handles.push(setTimeout(run, 6400));
    };
    run();
    return () => {
      cancelled = true;
      clearAll();
    };
  }, [r]);

  const flaggedLines = new Map(FINDINGS.slice(0, shown).map((f) => [f.line, f.sev]));
  const t = tone(score);

  return (
    <div className="diag">
      <div className="diag-glow" />
      {/* vitals bar */}
      <div className="diag-top">
        <div className="diag-dots">
          <span className="tdot r" />
          <span className="tdot y" />
          <span className="tdot g" />
        </div>
        <span className="diag-file mono">checkout-service · scan</span>
        <div className={`vitals tone-${t}`}>
          <span className="v-label mono">HEALTH</span>
          <span className="v-num">{score}</span>
          <span className="v-max mono">/100</span>
          <span className="v-status mono">{label(score)}</span>
        </div>
      </div>
      <div className="diag-ekg">
        <Ekg tone={t} />
      </div>

      {/* body: code + findings rail */}
      <div className="diag-body">
        <div className="diag-code-wrap">
          {scanning && <div className="diag-beam" />}
          <div className="diag-code">
            {CODE.map((segs, i) => {
              const sev = flaggedLines.get(i + 1);
              return (
                <div className={`dl${sev ? ` flagged sev-${sev}` : ""}`} key={i}>
                  <span className="dl-num mono">{i + 1}</span>
                  <span className="dl-txt mono">
                    {segs.map((s, j) => (
                      <span key={j} className={s.c}>
                        {s.t}
                      </span>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="diag-rail">
          <div className="rail-head mono">
            FINDINGS <span className="rail-count">{shown}</span>
          </div>
          {FINDINGS.map((f, i) => (
            <div className={`rail-item sev-${f.sev}${shown > i ? " in" : ""}`} key={f.diagnostic}>
              <span className="ri-glyph">{f.sev === "warn" ? "⚠" : "✖"}</span>
              <div className="ri-body">
                <div className="ri-label">{f.label}</div>
                <div className="ri-loc mono">
                  L{f.line} · node-doctor/{f.diagnostic}
                </div>
              </div>
            </div>
          ))}
          {shown === 0 && <div className="rail-empty mono">scanning…</div>}
        </div>
      </div>
    </div>
  );
}
