import { Reveal } from "../components/ui.tsx";
import { Rules } from "../components/Rules.tsx";
import { Link } from "../router.tsx";
import { CATEGORY_COLORS } from "../data/site.ts";
import rulesData from "../data/diagnostics.json";

const CATEGORY_WEIGHTS = rulesData.categoryWeights as Record<string, number>;

export function RulesPage() {
  return (
    <div className="page-fade">
      <header className="page-head">
        <div className="aurora" />
        <div className="wrap">
          <Link to="/" className="back">
            ← back
          </Link>
          <div className="eyebrow">The diagnostics</div>
          <h1>
            {rulesData.total} diagnostics. {rulesData.defaultOn} on by default, {rulesData.optIn} opt-in.
          </h1>
          <p>
            Precision over recall, everywhere: a false positive gets the whole tool uninstalled, so every
            heuristic resolves toward silence. FP-prone diagnostics ship opt-in, and none of them fire on the
            <code style={{ fontFamily: "var(--mono)", color: "var(--brand)" }}> good-app </code>
            canary.
          </p>
        </div>
      </header>

      <section style={{ paddingTop: 20 }}>
        <div className="wrap">
          <Reveal>
            <div className="grid-3" style={{ marginTop: 0, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
              {Object.entries(rulesData.byCategory as Record<string, number>).map(([cat, n]) => (
                <div className="card" key={cat} style={{ padding: 18 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="swatch" style={{ width: 11, height: 11, borderRadius: 3, background: CATEGORY_COLORS[cat] }} />
                    <b>{cat}</b>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 26, fontWeight: 720 }}>{n}</div>
                  <div style={{ color: "var(--ink3)", fontSize: 12.5, fontFamily: "var(--mono)" }}>
                    weight ×{CATEGORY_WEIGHTS[cat]}
                  </div>
                </div>
              ))}
            </div>
          </Reveal>

          <Rules />
        </div>
      </section>
    </div>
  );
}
