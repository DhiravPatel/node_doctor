# node.doctor for VS Code

Inline diagnostics for Node.js backends, as you type — the same engine the CLI
runs, so the editor never disagrees with CI.

- **Squiggles on the unsaved buffer** for file-scope diagnostics.
- **Hover** for the finding, its category, and the exact fix.
- **Quick fix** to insert a suppression comment — with a mandatory reason, because
  node.doctor reports an unexplained suppression as its own finding.

Cross-file and secret-scanning diagnostics need the whole tree; run
`node.doctor: Scan Whole Project` (or `npx node-doctor@latest .`) for those.

## Server resolution

1. `nodeDoctor.serverPath` if set
2. `node_modules/.bin/node-doctor` in the workspace (so the project's pinned
   version runs — the same one CI uses)
3. `npx node-doctor@latest`
