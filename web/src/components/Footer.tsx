import { Link } from "../router.tsx";

const GITHUB = "https://github.com/DhiravPatel/node_doctor";

export function Footer() {
  return (
    <footer>
      <div className="wrap">
        <div className="footer-grid">
          <div>
            <Link to="/" className="brand">
              <span className="brand-mark">+</span>
              node<span className="dot">.</span>doctor
            </Link>
            <div style={{ marginTop: 10, maxWidth: "34ch", color: "var(--ink3)" }}>
              Deterministic, offline-first static analysis for Node.js backends.
            </div>
          </div>
          <div className="footer-links">
            <Link to="/diagnostics">Diagnostics</Link>
            <Link to="/ci">CI</Link>
            <Link to="/agent">Agent skill</Link>
            <Link to={GITHUB}>GitHub</Link>
          </div>
        </div>
        <div className="footnote">
          MIT licensed · no telemetry · no network calls during a scan · the package and CLI are{" "}
          <span style={{ color: "var(--brand)" }}>node-doctor</span> (npm names cannot contain a dot).
        </div>
      </div>
    </footer>
  );
}
