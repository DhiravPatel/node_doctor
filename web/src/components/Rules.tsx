import { useMemo, useState } from "react";
import rulesData from "../data/diagnostics.json";
import { CATEGORY_COLORS } from "../data/site.ts";

interface Diagnostic {
  id: string;
  title: string;
  category: string;
  severity: string;
  tags: string[];
  requires: string[];
  disabledWhen: string[];
  optIn: boolean;
  recommendation: string;
}

const CATEGORIES = ["Security", "Reliability", "Bugs", "Performance", "Maintainability"];

export function Rules() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const diagnostics = rulesData.diagnostics as Diagnostic[];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return diagnostics.filter((r) => {
      if (category && r.category !== category) return false;
      if (!q) return true;
      return (
        r.id.includes(q) ||
        r.title.toLowerCase().includes(q) ||
        r.tags.some((t) => t.includes(q)) ||
        r.recommendation.toLowerCase().includes(q)
      );
    });
  }, [diagnostics, query, category]);

  return (
    <div>
      <div className="diagnostics-controls">
        <label className="search">
          <span aria-hidden="true" style={{ color: "var(--ink-3)" }}>⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search diagnostics — id, tag, or fix…"
            aria-label="Search diagnostics"
          />
        </label>
        <div className="filter-chips">
          <button className={`fchip ${category === null ? "active" : ""}`} onClick={() => setCategory(null)}>
            All {rulesData.total}
          </button>
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              className={`fchip ${category === cat ? "active" : ""}`}
              onClick={() => setCategory(category === cat ? null : cat)}
            >
              <span className="swatch" style={{ background: CATEGORY_COLORS[cat] }} />
              {cat} {(rulesData.byCategory as Record<string, number>)[cat] ?? 0}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="diagnostics-empty">No diagnostics match “{query}”.</div>
      ) : (
        <div className="diagnostics-grid">
          {filtered.map((r) => (
            <article className="diagnostic" key={r.id}>
              <div className="diagnostic-head">
                <div>
                  <div className="diagnostic-title">{r.title}</div>
                  <div className="diagnostic-id">node-doctor/{r.id}</div>
                </div>
                <span className={`badge ${r.severity === "error" ? "sev-error" : "sev-warn"}`}>
                  {r.severity === "error" ? "✖ error" : "⚠ warn"}
                </span>
              </div>
              <p className="diagnostic-rec">{r.recommendation}</p>
              <div className="diagnostic-meta">
                <span className="badge">
                  <span className="swatch" style={{ background: CATEGORY_COLORS[r.category] }} />
                  {r.category}
                </span>
                {r.requires.map((t) => (
                  <span className="badge" key={t}>
                    requires {t}
                  </span>
                ))}
                {r.disabledWhen.map((t) => (
                  <span className="badge" key={t}>
                    off on {t}
                  </span>
                ))}
                {r.optIn && <span className="badge optin">opt-in</span>}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
