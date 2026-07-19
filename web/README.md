# node.doctor — landing site

The marketing / landing site for [node.doctor](../README.md), built with React +
Vite. It is a static site (no backend) — node.doctor's parser is a native Node
addon, so the site does not run a live in-browser analyzer; it showcases the
tool, an interactive health-score demo, and a filterable catalog of the full
ruleset.

## Develop

```bash
cd web
npm install
npm run dev          # vite dev server
```

## Build

```bash
npm run build        # tsc --noEmit + vite build → web/dist
npm run preview      # serve the production build
```

## Keeping the rule catalog in sync

The rules shown on the site come from `src/data/rules.json`, generated from the
live registry so the catalog never drifts:

```bash
npm run gen:rules    # → node ../scripts/gen-web-rules.ts
```

Re-run it whenever the ruleset changes. Content is original to node.doctor; the
site's *shape* is inspired by react.doctor.

## Structure

```
web/
├── index.html
├── src/
│   ├── main.tsx            # entry
│   ├── App.tsx             # sections: nav, hero, problem, how-it-works, CI, agent, footer
│   ├── styles.css          # the whole design system (dark, one committed look)
│   ├── components/
│   │   ├── ScoreDemo.tsx   # health-score ring + category breakdown (agent-app ↔ good-app)
│   │   └── Rules.tsx       # searchable / filterable catalog
│   └── data/
│       ├── site.ts         # static section content
│       └── rules.json      # generated from the node.doctor registry
└── vite.config.ts
```

Data-visualization colors (the score meter, category bars) use a colorblind-safe
palette validated with the data-viz method; the brand green is decorative only.
