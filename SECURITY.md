# Security Policy

node.doctor is a security-analysis tool, so its own supply chain and behavior
matter. Two things are worth stating plainly.

## What node.doctor does with your code

- It reads your source files locally and analyzes them in-process.
- It makes **no network calls** during a scan. There is **no telemetry**.
- The score, the rules, and the agent skill all run on your machine.
- It never modifies your source. It is a detector, not a fixer.

If you observe node.doctor making a network request during a scan, that is a
security bug — please report it (see below).

## Supply chain

A security tool with a large dependency tree is a contradiction. node.doctor
ships with a deliberately small set of production dependencies:

- `oxc-parser` — the Rust-backed parser (the one heavy dependency),
- `fast-glob` — file discovery,
- `picocolors` — terminal color (zero-dependency).

Everything else is the Node standard library. Every new production dependency
must be justified in its pull request.

## Reporting a vulnerability

If you find a security issue in node.doctor itself — a rule that leaks data, a
crash that could be weaponized, a dependency concern, or any network activity
during a scan — please **do not open a public issue**.

Instead, email the maintainers or use GitHub's private vulnerability reporting
("Report a vulnerability" under the repository's *Security* tab). Include:

- a description of the issue and its impact,
- a minimal reproduction (a small source file plus the command you ran),
- the node.doctor version (`node-doctor --version`) and your Node version.

We aim to acknowledge reports within a few business days and to ship a fix or a
mitigation promptly, crediting reporters who wish to be credited.

## Reporting a false positive

A false positive is not a vulnerability, but it is the failure mode we care about
most. Please open a normal issue with a minimal reproduction — it is treated as a
bug in the rule, exactly as the agent skill instructs.
