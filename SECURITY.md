# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/ContextCake/context-cake/security/advisories/new)
(**Security → Report a vulnerability** on this repository). Do not open a public
issue for anything you believe is exploitable.

What to expect:

- Acknowledgement within **3 business days**.
- An assessment and remediation plan within **14 days** for confirmed reports.
- Credit in the release notes when a fix ships, if you want it.

Please include reproduction steps, the affected surface (engine, console, site,
or desktop app), and the version or commit you tested.

## Supported versions

ContextCake is pre-1.0. Security fixes land on `main` and ship in the next
release; only the **latest release** is supported.

## Scope notes

- **The manifest is a trust boundary by design.** A layer with `"source": "mcp"`
  spawns the `command` declared in the manifest, with the caller's privileges.
  Running a manifest you did not author is equivalent to running a program you
  did not author. Reports that reduce to "a hostile manifest can run commands"
  describe documented behavior, not a vulnerability — see the trust-boundary
  documentation on the product site.
- **The engine is dependency-free on purpose.** The core (`packages/core/`) uses
  Node.js built-ins only; there is no `npm install` step and no lifecycle
  scripts. Supply-chain reports against the engine should target the release
  artifacts themselves.
- The web console demo and product site are static deployments; reports about
  them are still welcome (XSS in rendered content, CSP gaps, dependency CVEs in
  `apps/console/` or `apps/site/`).
