# ContextCake Distribution & Auto-Update

Give ContextCake a way to be **downloaded, installed, set up, and kept current** on modern Macs — across every audience from a non-technical user who never opens a terminal to a developer living in one — with updates that propagate from a single release and can self-apply where we own the install.

**Date:** 2026-07-02
**Status:** Approved — ready for design & implementation handoff (all open questions resolved)
**Workflow:** Requirements-First (desired behavior known; architecture flexible)
**Primary target:** macOS on Apple Silicon (arm64)
**Depends on:** `specs/contextcake-core/design.md` (the engine being distributed)

---

## 1. Problem Statement

ContextCake today is a dependency-free Node.js toolkit — MCP server, CLI, and a local web
playground — with **no install story at all**: you clone the repo and run `.mjs` files. That
excludes everyone who isn't already inside the codebase, and it has no answer for "how do users get
new versions." To be a product, it needs (a) a way to obtain and install it that fits several very
different audiences, (b) a first-run setup that produces a working configuration without hand-editing
files, and (c) a regular, low-friction update path — including an in-app "Relaunch to update" for the
surfaces we control — so users don't drift onto stale versions.

## 2. Goals

- One install experience per audience, from **zero-terminal double-click** to **developer package
  manager**, all delivering the **same core capabilities** from **one engine**.
- A **first-run setup wizard** that writes a valid configuration through UI prompts.
- **Uniform update awareness** everywhere, with **self-applied "Relaunch to update"** on channels we own.
- **One release → every channel**, from a single pipeline, with verified update integrity.
- Native, first-class experience on **Apple Silicon MacBooks**.

## 3. User Stories

- **Nadia (non-technical Mac user):** downloads ContextCake, double-clicks, follows a setup wizard,
  and her agent can read her knowledge — she never opens a terminal.
- **Dana (developer):** installs via `npx`/Homebrew or drops a one-click `.mcpb` into Claude
  Desktop/Code/Cursor, and uses the CLI (`resolver`/`ingest`/`write`/`promote`) directly.
- **Theo (team lead):** rolls a consistent version out to his team and pushes updates on a regular
  cadence without each member reinstalling by hand.
- **All of them:** get a clear "update available" nudge and, where possible, a one-click "Relaunch to
  update" — never a manual reinstall, never a stale version silently lingering.

## 4. Product Principles (constraints on any design)

- **One core, many front-ends.** The MCP server, CLI, and GUI SHALL be thin adapters over a single
  engine — the GUI drives the same core/CLI logic, never a parallel reimplementation.
- **User data is sacred and separate.** Configuration and knowledge live apart from versioned program
  files; no install/update/reinstall may touch them.
- **Own-it-or-defer-to-it.** We self-update only channels whose files we own; for package-manager
  channels we defer to the manager, never fight it.
- **Trust is verified, not assumed.** Any self-applied update is authenticated before it runs; any
  macOS artifact a user downloads is signed and notarized.
- **Privacy by default.** Any network call the app makes on its own behalf (e.g. an update check)
  carries the minimum data, no PII, and can be turned off.

## 5. Acceptance Criteria (EARS)

### Obtain & install
- [ ] WHEN a non-technical user on a modern Mac obtains ContextCake THE SYSTEM SHALL offer at least
  one install path completable with **zero terminal use** (download → open → guided setup).
- [ ] WHEN a developer installs ContextCake THE SYSTEM SHALL be available via **npm** (`npx` and
  global, published as `contextcake`, with `context-cake` reserved as a pointer package to
  block typosquatting), **Homebrew**, and a **one-click MCP bundle (`.mcpb`)** for
  MCP-capable clients. *(npm publication is additionally gated — see §8 amendment.)*
- [ ] WHEN ContextCake is installed through any channel THE SYSTEM SHALL expose the **same core
  capabilities** (MCP server, CLI, GUI) backed by one engine.
- [ ] WHEN installed on Apple Silicon THE SYSTEM SHALL run natively as arm64 without Rosetta.

### First-run setup
- [ ] WHEN ContextCake first runs with no existing configuration THE SYSTEM SHALL present an
  **interactive setup wizard** that collects the user's layer sources and writes a valid
  configuration, WITHOUT the user hand-editing any file.
- [ ] WHEN setup runs in a no-terminal channel (GUI app / `.mcpb`) THE SYSTEM SHALL collect
  configuration through **UI prompts**, not a shell.
- [ ] WHEN the wizard completes THE SYSTEM SHALL leave ContextCake in a working, agent-resolvable
  state (at minimum a personal layer configured).

### Update awareness (all channels)
- [ ] WHEN ContextCake starts, and periodically while running, THE SYSTEM SHALL check a **single
  authoritative version source** and determine whether a newer version exists for its install channel.
- [ ] WHEN a newer version is available THE SYSTEM SHALL surface a **consistent, non-blocking "update
  available"** indication across CLI, MCP server, and GUI.
- [ ] WHEN presenting the update THE SYSTEM SHALL offer the action **appropriate to the detected
  channel** (self-apply where owned; the correct upgrade command where package-managed; the host's
  mechanism for `.mcpb`).
- [ ] WHEN ContextCake checks for updates THE SYSTEM SHALL transmit **no personally identifiable
  information**, SHALL send only the minimum needed to determine availability (e.g. current version,
  channel, platform/arch), SHALL disclose this behavior in the docs, and SHALL provide a documented
  way to **disable update checks**.

### Self-update (owned channels: standalone binary, native GUI app)
- [ ] WHEN a newer version is available on an owned channel THE SYSTEM SHALL download, **verify**, and
  stage it and offer a **"Relaunch to update"** action that applies it on restart — no manual
  reinstall, no elevated privileges.
- [ ] WHEN an update is applied THE SYSTEM SHALL NOT modify or destroy existing user configuration or
  knowledge data.
- [ ] WHEN ContextCake was installed via a package manager (Homebrew, npm global) THE SYSTEM SHALL NOT
  mutate the manager's files, and SHALL instead direct the user to the correct upgrade command.

### Integrity & Gatekeeper
- [ ] WHEN ContextCake applies a self-update THE SYSTEM SHALL verify its authenticity
  (signature/checksum against a trusted key) **before** applying, and SHALL refuse an unverified update.
- [ ] WHEN ContextCake is distributed as a macOS binary or app THE SYSTEM SHALL be **code-signed with
  a Developer ID and notarized**, so Gatekeeper admits it without warnings.
- [ ] WHEN checking or downloading updates THE SYSTEM SHALL use authenticated transport (HTTPS)
  against a **pinned update host**.
- [ ] WHEN release artifacts are signed THE SYSTEM SHALL keep signing keys in a secrets store (**never
  in the repository**), use them **only** within the release pipeline, and follow a documented key
  rotation/recovery procedure.

### Release pipeline
- [ ] WHEN maintainers cut a **single release** THE SYSTEM SHALL propagate that version to **every
  supported channel from one pipeline** (no per-channel manual publishing) and regenerate the
  authoritative version source.
- [ ] WHEN a release is published THE SYSTEM SHALL produce **one changelog** reused across channels.
- [ ] WHEN a `.mcpb` bundle is released THE SYSTEM SHALL **publish it to the public MCP
  registry/directory** in addition to being installable by direct download.

### Config preservation (cross-cutting)
- [ ] WHEN ContextCake is installed, updated, or reinstalled THE SYSTEM SHALL keep user configuration
  and knowledge in a location **separate from versioned program files**, so updates never clobber them.

## 6. Out of Scope

- **Windows / Linux native installers and self-update** — `npx`/npm remain incidentally
  cross-platform, but double-click installers, notarization equivalents, and self-update are
  **macOS-first** for v1.
- **Multiple release channels** (beta/nightly) — single stable channel only for v1.
- **Enterprise/MDM-managed `.mcpb` auto-update infrastructure** — deferred.
- **Mac App Store** distribution — Developer ID direct distribution instead.
- **Knowledge-resolution behavior** — owned by `contextcake-core`; unchanged here.

## 7. Boundaries

- ✅ **Always:** one core engine — every channel and the GUI exercise the same logic. Keep user data
  separate from program files. Sign **and** notarize every macOS artifact before it ships to end users.
- ✅ **Always:** every "download-and-run" macOS artifact passes Gatekeeper cleanly before release.
- ⚠️ **Ask first:** before adding an npm runtime dependency to the **core engine** (it stays
  dependency-free; the GUI/updater may carry their own stack); before adding a second release channel;
  before expanding to non-macOS native installers.
- 🚫 **Never:** apply an unverified/unsigned update; self-mutate a package manager's install; clobber
  user config/knowledge on update; ship an unnotarized binary to end users; commit signing keys; put
  real secrets/PII into installers, manifests, or fixtures.

## 8. Resolved Decisions & Prerequisites

Resolved during spec sign-off (2026-07-02):

- **Channels in scope (v1):** npm/npx, one-click `.mcpb`, Homebrew, standalone signed+notarized
  binary (self-update), **and** a native double-click GUI app. The GUI is a **first-class product
  surface**, not a debug view — it is a front-end over the same core/CLI (Principle §4).
- **Primary user:** **both** — a non-technical Mac user MUST be able to install with **zero terminal**
  (hard requirement, §5), while developer channels are served in parallel.
- **First-run setup:** **interactive setup wizard** generates the configuration; no hand-editing.
- **Privacy posture:** update check is **anonymous, minimal, disclosed, and disable-able** (§5).
- **Signing-key custody:** **follow best practice** — secrets store, CI-only use, documented
  rotation/recovery (§5, §7); the GUI updater's signing key is distinct from the Apple Developer ID.
- **`.mcpb` updates:** rely on the host (Claude Desktop) update mechanism **and also publish** to the
  public MCP registry/directory (§5).
- **npm name:** ~~`context-cake`~~ **amended 2026-07-02 (spec-merge session): `contextcake`**,
  matching contextcake.com, the MCP `serverInfo` name, and the brand; `context-cake` is
  **also reserved** as a pointer package (anti-typosquat).

**Prerequisite & sequencing risk — no Apple Developer Program account exists yet.**
Notarization gates the two "owned" macOS channels (standalone binary and GUI app), which are also the
channels that deliver the flagship **zero-terminal** experience. Therefore:

- Acquiring an **Apple Developer Program** account + Developer ID certificate is a **hard prerequisite**
  before the standalone-binary and GUI channels ship to end users.
- Channels that do **not** require our own notarization — the **`.mcpb`** bundle (runs under Claude
  Desktop's already-notarized runtime) and the **Homebrew** formula (built from source on the user's
  machine) — can be built and shipped **first**, in parallel with obtaining the account.

**Amendment (2026-07-02, on merge with the site branch):** the **npm channel is gated behind a
supply-chain-hardening review** and no longer ships first. Context: John deferred npm publication
after the 2026 registry compromises of AI/agent tooling (Mastra 144-package backdoor, TrapDoor);
the public site currently presents clone-and-run as a deliberate security property
(`specs/contextcake-site/spec.md`, Open Questions). Before the npm channel ships: provenance /
trusted publishing, **no lifecycle scripts**, 2FA on the publishing account, minimal `files`
allowlist — and update the site's `/install` "Why isn't this on npm?" section in the same release.
`.mcpb` and Homebrew lead; npm follows the review.
- The GUI app and its self-updater can be **built and tested locally with ad-hoc/development signing**
  in the meantime, but MUST NOT be distributed to end users until notarized.

## 9. Dependencies

- `specs/contextcake-core/design.md` — the engine and its `layers.json` configuration contract.
- **Apple Developer Program** — Developer ID signing + notarization service *(to be acquired — see §8)*.
- A **host for the authoritative version source + release artifacts** (e.g. GitHub Releases).
- **npm registry** (package `context-cake`), a **Homebrew tap** repo, the **MCPB toolchain** + the
  **MCP registry/directory**, and a **native desktop-app framework** (Tauri is the leading candidate)
  — final choices made in design.

## 10. For the Implementing Agent

This spec is being handed to a separate session to **review, design, and implement**. Intended path:

1. **Review** this spec; challenge scope, criteria, and the §8 sequencing risk.
2. **Design first** — run `superpowers:brainstorming`, then write `specs/contextcake-distribution/design.md`.
   The design phase (not this spec) decides: the **GUI framework**, the **version-manifest format**,
   the **self-update swap mechanism**, **install locations**, and the **release-automation tooling**.
   Resolve any new `[NEEDS CLARIFICATION]` with the user before planning.
3. **Implement** per the project workflow below, tracing each task back to a §5 acceptance criterion.

**Project facts (do not re-derive):**
- **Commands, architecture, gotchas:** see root `CLAUDE.md`. **Engine contract:** `specs/contextcake-core/design.md`.
- **Testing:** bash-based — `npm test` runs `smoke-test.sh`, `resolver-test.sh`, `source-test.sh`,
  `playground-test.sh`. Add tests alongside; run from repo root. Prefer TDD (`superpowers:test-driven-development`).
- **Code style:** ESM `.mjs`, Node ≥18. **The core engine (`resolver.mjs`, `sources/`) is
  dependency-free (plain Node built-ins) — keep it that way** (§7). GUI/updater may use their own
  stack, but must not pull deps into the core.
- **Git workflow:** conventional commits (`feat:`/`fix:`/`docs:`…); branch per feature; **specs are
  committed, plans are never committed** (`docs/plans/` stays local).
- **GUI design:** for HIG-native macOS patterns, use the `macos-design` skill and
  `research/design/mac-catalyst-app-design.md`.

**Self-verification (run before claiming done):**
> Compare your implementation against §5 of this spec and list any acceptance criteria not addressed.
