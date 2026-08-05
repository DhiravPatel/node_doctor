import { Link } from "../router.tsx";

const GITHUB = "https://github.com/DhiravPatel/node_doctor";

const NAV = [
  { to: "/install", label: "Install" },
  { to: "/diagnostics", label: "Diagnostics" },
  { to: "/ci", label: "CI" },
  { to: "/agent", label: "Agent skill" },
];

export function Nav({ route }: { route: string }) {
  return (
    <nav className="nav">
      <div className="wrap nav-inner">
        <Link to="/" className="brand always">
          <span className="brand-mark">+</span>
          node<span className="dot">.</span>doctor
        </Link>
        <div className="nav-links">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={route === n.to ? "active" : ""}>
              {n.label}
            </Link>
          ))}
          <Link to={GITHUB} className="nav-cta always">
            GitHub ↗
          </Link>
        </div>
      </div>
    </nav>
  );
}
