# ContextCake Integrations — Spec

**Date:** 2026-07-14
**Status:** Approved (decisions locked with John, 2026-07-14)
**Workflow:** Requirements-First, constrained by the existing source-adapter
contract (`specs/contextcake-core/design.md` §10) — integrations are new
adapters against that contract, not an engine re-architecture
**Depends on:** `specs/contextcake-core/design.md` (adapter contract, OKF
translation rule), `specs/contextcake-auth/spec.md` (Keychain custody),
`specs/contextcake-distribution/design.md` (service, config layout)

---

## 1. Problem statement

Real teams keep context in many places at once: markdown scattered across
GitHub repos, a Confluence space, pinned Slack messages, a Google Drive folder,
plain folders on disk. Wiring each of those into each AI harness means N×M MCP
configurations that don't transfer between tools. ContextCake's job is to be
the **single access point**: configure a source once, group sources into
per-project profiles with an explicit priority order, and every harness reads
the same resolved graph through one MCP endpoint.

This reframes the product: source breadth and effortless configuration are the
headline; per-section conflict surfacing (the existing engine) is the
trust-building differentiator underneath.

## 2. Goals

- v1 source kinds: **`files`** (any local folder — no OKF authoring required),
  **`github`**, **`slack`**, **`confluence`**, **`gdrive`**, alongside the
  existing `okf-local` and a **generalized `mcp`**.
- A **cache layer** so remote sources are fast and usable offline.
- **Credential indirection**: manifests reference credentials; they never
  contain them.
- **Profiles**: named per-project source sets with explicit level ordering,
  selected per harness invocation.
- Setup for any given source ≤ 2 minutes in the app; one MCP config line per
  harness, ever.

## 3. Adapter contract (unchanged core, one addition)

Every source implements `{ name, level, async loadConcept(id) →
{frontmatter, sections} | null, async listConceptIds() → string[], close() }`
per core design §10. Remote adapters are wrapped by the cache
(`withCache(source, {ttlMs, cacheDir})`), which adds `sync()` and `lastSynced`.
Unreachable sources warn-and-continue (core design §8); within TTL the cache
serves and marks staleness.

## 4. Translation rules per source (OKF is the lingua franca)

| Kind | Concept id | Sections | `updated` | Auth (read-only scopes) |
|---|---|---|---|---|
| `files` | relative path minus extension | OKF frontmatter honored when present; plain markdown → `##` headings (slug keys), preamble → `overview`; `.txt` → `body` | file mtime unless OKF attr | none |
| `github` | `<owner>/<repo>/<path minus ext>` within the layer | same plain-markdown rules as `files` | latest commit date for the file (cached; repo `pushed_at` fallback) | GitHub App **device flow**, `contents:read` |
| `slack` | `<channel>/<pin-or-canvas-slug>` + one `<channel>/channel` concept (topic/purpose) | canvas headings → sections; a pinned message → `body` | message/canvas edit timestamp | Slack app user token: `channels:read`, `pins:read`, `canvases:read` |
| `confluence` | `<space-key>/<page-slug>` (subtree of a chosen space/parent) | page storage format → heading-split sections | `version.when` | Atlassian OAuth 2.0 (3LO), granular read scopes |
| `gdrive` | `<folder>/<doc-slug>` | Google Docs exported as text → heading-split; `.md` files parsed as `files` | `modifiedTime` | Google OAuth PKCE, `drive.readonly` (**ships only after scope verification clears**) |

Defaults for `github` path selection: `CLAUDE.md`, `AGENTS.md`, `README.md`,
`docs/**`, `.context/**` — overridable per layer.

## 5. Acceptance criteria (EARS)

### Credential custody
- [ ] WHEN a remote source is configured in the app THE SYSTEM SHALL store its
  credential in the OS keychain under an alias and write only
  `"auth": "keychain:<alias>"` to the manifest.
- [ ] WHEN the engine runs headless (CI, CLI without the app) THE SYSTEM SHALL
  accept credentials via environment variables declared as
  `"auth": {"tokenEnv": "NAME"}`.
- [ ] WHEN a manifest or synced settings blob is written THE SYSTEM SHALL never
  contain a raw credential; a credential-pattern check SHALL fail the write.
- [ ] WHEN the engine needs a credential THE SYSTEM SHALL receive it injected
  by the caller (app or env); the engine SHALL never read the keychain itself.

### Resilience & cache
- [ ] WHEN a remote source is unreachable THE SYSTEM SHALL resolve from the
  remaining sources and serve that source from cache if within TTL, surfacing
  the degradation as a warning with the cache age — never a hard failure.
- [ ] WHEN the user triggers Sync (per source or all) THE SYSTEM SHALL bypass
  TTL, refresh the cache, and update `lastSynced` visibly.
- [ ] WHEN remote content lacks OKF structure THE SYSTEM SHALL synthesize
  concepts per §4 rather than skipping or erroring (graceful plain-content
  ingestion).

### Profiles
- [ ] WHEN a manifest declares `profiles` THE SYSTEM SHALL resolve using only
  the selected profile's layers in that profile's level order.
- [ ] WHEN `contextcake mcp` starts THE SYSTEM SHALL select the profile by
  `--profile` flag, else by longest-prefix match of the client working
  directory against the manifest `projects` map, else the `default` profile.
- [ ] WHEN a legacy flat `{"layers": []}` manifest is loaded THE SYSTEM SHALL
  treat it as the sole/default profile (full back-compat, zero migration).
- [ ] WHEN profile resolution happens THE SYSTEM SHALL require no new
  resolution rules — priority is expressed entirely as the existing per-layer
  `level` (core design §9 two-rules ceiling holds).

### Scopes & privacy
- [ ] WHEN any integration authorizes THE SYSTEM SHALL request read-only,
  minimal scopes per §4; a scope expansion is a spec change (⚠️ below).
- [ ] WHEN integration content is fetched THE SYSTEM SHALL keep it on-device
  (cache + resolved output); no integration content is proxied through any
  ContextCake-operated server.

## 6. Manifest v2 (shape)

```json
{
  "profiles": {
    "default": { "layers": [ { "name": "personal", "level": 3, "source": "okf-local", "path": "~/kb-personal" } ] },
    "payments-service": {
      "layers": [
        { "name": "notes",   "level": 4, "source": "files",  "path": "~/notes/payments" },
        { "name": "repo",    "level": 3, "source": "github", "repo": "acme/payments", "paths": ["docs/**", "CLAUDE.md"], "auth": "keychain:github", "cache": { "ttlSeconds": 900 } },
        { "name": "wiki",    "level": 2, "source": "confluence", "site": "acme.atlassian.net", "space": "PAY", "auth": "keychain:atlassian", "cache": { "ttlSeconds": 3600 } },
        { "name": "slack",   "level": 1, "source": "slack",  "channel": "C0123PAYME", "auth": { "tokenEnv": "SLACK_TOKEN" }, "cache": { "ttlSeconds": 900 } }
      ]
    }
  },
  "projects": { "/Users/dana/repos/payments": "payments-service" }
}
```

## 7. Out of scope (v1)

Write-back to remote sources (read-only product) · Slack message-history
ingestion (pins + canvases only) · Notion, Linear (next wave, same contract) ·
`gdrive` end-user availability before Google verification · webhooks/live
push (cache TTL + manual sync only).

## 8. Boundaries

- ✅ **Always:** engine stays dependency-free (built-in `fetch` only); OKF is
  the output format (foreign shapes translate in); read-only scopes;
  warn-and-continue on source failure; cache dir passed in by the caller
  (engine hardcodes no OS paths).
- ⚠️ **Ask first:** new source kinds; any scope expansion; message-history
  ingestion; webhook/live-sync machinery; any new resolution rule.
- 🚫 **Never:** raw tokens in manifests, settings, logs, or synced blobs;
  write scopes; engine reading the keychain; integration content proxied
  through ContextCake servers; npm dependencies in `packages/core`.

## 9. For the implementing agent

- **Commands:** adapters live in `packages/core/src/sources/<kind>.mjs`,
  factory-registered in `sources/index.mjs`; run `npm test` from repo root.
- **Testing:** bash suites per adapter under `packages/core/tests/`
  (`<kind>-source-test.sh`), using a local `node:http` fixture server for
  remote APIs (no network in tests) — follow `source-test.sh` idiom (temp
  dirs, `trap` cleanup). Cache behavior gets its own assertions (stale-read,
  sync, disk round-trip).
- **Project structure:** OAuth flows and pickers live in `apps/desktop` +
  `apps/console` (Sources UI); the engine sees only tokens-by-value.
- **Code style:** ESM `.mjs`, Node ≥ 18 built-ins, sparse comments, match
  `okf-local.mjs` voice.
- **Git:** conventional commits; one PR per adapter or coherent pair.
- **Self-verification:** compare implementation against §5 and list any
  criteria not addressed.
