# Launch runbook

Everything that can be automated already is. What remains are the steps that
need **your** credentials — nobody else can run them.

Work top to bottom. Each step says what it does and how to confirm it worked.

---

## 0. Rotate the GitHub token first (do this before anything else)

Your git remote currently embeds a personal access token in plaintext:

```
https://DhiravPatel:ghp_****@github.com/DhiravPatel/node_doctor.git
```

It is **not** in the repository and **not** in git history — it lives only in
`.git/config` on this machine. But it is printed by any `git remote -v`, appears
in shell history and terminal logs, and has already surfaced in tool output. Treat
it as compromised and rotate it:

1. Revoke it: <https://github.com/settings/tokens> → find the token → **Delete**.
2. Remove it from the remote so it is never stored in a file again:

   ```bash
   git remote set-url origin https://github.com/DhiravPatel/node_doctor.git
   ```

3. Authenticate the supported way instead — pick one:

   ```bash
   gh auth login                      # GitHub CLI manages the credential itself
   # or, for HTTPS without a CLI:
   git config --global credential.helper osxkeychain   # macOS keychain
   ```

Confirm: `git remote -v` shows no `ghp_` and `git fetch` still works.

---

## 1. npm account and token

The package publishes as **`@dhiravpatel/node-doctor`** (the unscoped
`node-doctor` is taken by an unrelated live package).

1. Create/log in to npm and make sure the username matches the scope:

   ```bash
   npm login          # username must be "dhiravpatel" for the @dhiravpatel scope
   npm whoami
   ```

2. Create an **Automation** access token for CI:
   npmjs.com → avatar → **Access Tokens** → **Generate New Token** →
   **Classic → Automation** (it bypasses 2FA, which is what CI needs).

3. Add it to the repo:
   GitHub → repo → **Settings → Secrets and variables → Actions → New repository
   secret** → name `NPM_TOKEN`, value the token.

Confirm: `npm whoami` prints `dhiravpatel`.

---

## 2. Make the repository public

GitHub → repo → **Settings → General → Danger Zone → Change repository
visibility → Public**.

While you are there, add a description and topics (`static-analysis`, `nodejs`,
`security`, `linter`, `sast`) — they drive GitHub search.

---

## 3. Deploy the docs site to Vercel — ✅ DONE (https://node-doctor.vercel.app/)

The site lives in `web/` (Vite + React: the landing page and the browsable rule
catalog). It builds standalone — `web/src/data/diagnostics.json` is committed, so
Vercel never needs the analyzer itself.

1. <https://vercel.com/new> → **Import** `DhiravPatel/node_doctor`.
2. Set **Root Directory** to `web`. This is the only setting that matters — the
   repo root is the CLI, not the site.
3. Everything else auto-detects (Framework: Vite · Build: `npm run build` ·
   Output: `dist`). Leave it alone.
4. **Deploy.**

Vercel then rebuilds on every push to `main` automatically.

Once you have the URL, put it in the repo's **About** panel (⚙️ next to About →
Website) and in the README header.

> The rule catalog stays honest because CI enforces it: `ci.yml` runs
> `npm run check:web`, which fails the build if `web/src/data/diagnostics.json`
> drifts from the engine's actual diagnostic set. Regenerate with
> `npm run gen:web` whenever you add or change a rule.

## 4. Publish

Releases are tag-driven. The `release` workflow re-runs the full suite, the drift
guards, a self-scan, and **installs the packed tarball into a clean project and
runs the CLI from it** before it will publish — a broken build cannot reach the
registry.

```bash
# make sure main is green and committed first
npm version 1.0.0          # bumps package.json, commits, creates tag v1.0.0
git push --follow-tags
```

That single push:

1. runs `verify` (typecheck → drift guards → 2025 tests → build → self-scan →
   tarball install check),
2. publishes to npm with **provenance** (a signed, verifiable link from the
   package back to the exact commit and workflow run that built it),
3. cuts the GitHub release.

Confirm:

```bash
npm view @dhiravpatel/node-doctor version
npx @dhiravpatel/node-doctor@latest --version
```

> **Dry run first, if you want:** Actions → **release** → *Run workflow* → leave
> `dry_run` checked. It packs and verifies without publishing.

### Version choice

`package.json` is at `0.1.0`. Publishing `1.0.0` says the CLI flags and the JSON
report shape are stable — which they are (`schemaVersion` pins the report). If
you would rather signal "usable but still moving", publish `0.9.0` and save
`1.0.0` for after real-world feedback.

---

## 5. Tell people it exists

The tool is only useful if someone runs it. In rough order of return:

- **README first impression** — the terminal sample at the top is the whole pitch.
  It is already there; make sure the npm badge resolves after the first publish.
- **MCP directories** — it ships an MCP server (`node-doctor mcp`), so it belongs
  in the MCP server lists (modelcontextprotocol/servers, mcp.so, Smithery). This
  is the highest-leverage listing: it makes the tool reachable from every MCP
  client, not just terminals.
- **The agent-skill angle** — `node-doctor install` pushes the rules into Claude
  Code / Cursor. "Your agent writes bad Node; this catches it" is the sharpest
  framing for the current moment; lead with it.
- **Show, don't claim** — run it against a well-known open-source Node service and
  post the real output. A concrete finding beats any feature list.
- Where: r/node, Hacker News (Show HN), the Node.js Discord, Bluesky/X, dev.to.

---

## Ongoing releases

```bash
npm version patch | minor | major
git push --follow-tags
```

CI gates every release, so the ratchet holds: 2025 tests, the three drift guards
(registry / config schema / web catalog), a 100/100 self-scan, and a clean-install
smoke test of the packed artifact.

---

## What is already done for you

| Item | State |
|---|---|
| Package name, scope, `publishConfig.access: public` | ✅ set |
| `repository` / `homepage` / `bugs` / `author` metadata | ✅ real URLs (the `your-org` placeholder is gone) |
| `files` allowlist | ✅ ships `dist`, `bin`, `skill`, README, CHANGELOG, LICENSE — 544 KB, no source or tests |
| `bin` → `node-doctor` | ✅ short command survives the scoped package name |
| MIT `LICENSE` | ✅ present |
| CI (test matrix on Node 20.19 + 22) | ✅ existing `ci` workflow |
| Release automation with provenance | ✅ new `release` workflow |
| Docs-site deploy | ✅ live at https://node-doctor.vercel.app/ |
| Install-from-tarball verification | ✅ proven locally and enforced in CI |
| README / SKILL install commands | ✅ updated to the scoped name |
