/** A looping EKG/heartbeat line. Turns amber/red as health drops. */
export function Ekg({ tone = "good" }: { tone?: "good" | "warn" | "crit" }) {
  const color = tone === "crit" ? "var(--critical)" : tone === "warn" ? "var(--warning)" : "var(--brand)";
  return (
    <svg className="ekg" viewBox="0 0 240 40" preserveAspectRatio="none" aria-hidden="true">
      <path
        className="ekg-path"
        d="M0 20 H60 l6 -14 l8 28 l7 -20 l6 6 H150 l6 -12 l8 24 l6 -12 H240"
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
