import { IconScan, IconTarget, IconRules, IconBranch, IconGauge } from "./Icons.tsx";

const STAGES = [
  { icon: IconBranch, label: "discover", sub: "package.json → capability tokens" },
  { icon: IconScan, label: "parse", sub: "oxc → ESTree, per file" },
  { icon: IconTarget, label: "request-path", sub: "handlers · taint · call graph" },
  { icon: IconRules, label: "diagnostics", sub: "62 diagnostics, each isolated" },
  { icon: IconGauge, label: "score", sub: "0–100, deterministic, local" },
];

export function Pipeline() {
  return (
    <div className="pipeline">
      {STAGES.map((s, i) => {
        const Icon = s.icon;
        return (
          <div className="pl-wrap" key={s.label}>
            <div className="pl-node">
              <span className="pl-ico"><Icon /></span>
              <div className="pl-label">{s.label}</div>
              <div className="pl-sub">{s.sub}</div>
            </div>
            {i < STAGES.length - 1 && (
              <div className="pl-conn" aria-hidden="true">
                <span className="pl-flow" style={{ animationDelay: `${i * 0.3}s` }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
