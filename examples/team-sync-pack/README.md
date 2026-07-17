# ContextCake Team Sync Pack

Shared working memory for AI-assisted teams: when one person's agent resolves
an investigation, everyone else's agent can find it within ~2 minutes. This
pack teaches each harness the two calls that make it work — `find_captures`
before investigating, `log_capture` → preview → `confirm_capture` after a
capture-worthy outcome.

Spec: `specs/contextcake-team-sync/spec.md` · Design:
`specs/contextcake-team-sync/design.md`.

## 1. Set up the team's live repo (once per team)

The live layer is a plain git repo — captures and telemetry sync through it;
nothing passes through any ContextCake-operated server.

```bash
# one person creates it (an empty private repo on your git host)
git clone <your-git-host>/acme/team-live.git ~/kb-live
cd ~/kb-live && git commit --allow-empty -m init && git push -u origin main
```

**Trust boundary:** anyone who can push to this repo can inject unreviewed
context into every teammate's agent. Scope repo access to the team — repo
membership IS the trust decision.

## 2. Each teammate: manifest + identity

Add the live layer to your `layers.json` (exactly one layer may be `live`):

```json
{ "layers": [
  { "name": "team",      "level": 2, "source": "okf-local", "path": "~/kb-team" },
  { "name": "team-live", "level": 1, "source": "okf-local", "path": "~/kb-live",
    "live": true,
    "git": { "pullTtlSeconds": 90, "retentionDays": 14 },
    "cache": { "ttlSeconds": 60 } }
] }
```

Attribution comes from `git config user.name` in the live repo; if you keep
that unset, add `"profileName": "<display name>"` to the `git` block (the
skills prompt once if both are missing). Commits fall back to a synthetic
noreply identity — no git config is ever written for you.

Start the server with capture (and optionally telemetry) enabled:

```bash
node mcp-server.mjs --manifest layers.json --capture --telemetry --harness claude-code
```

Without `--capture` the server stays fully read-only (6 tools). With it,
`log_capture`/`confirm_capture` appear (8 tools) — staging is previewed and
nothing is shared without an explicit yes.

## 3. Install per harness

- **Claude Code:** `claude --plugin-dir examples/team-sync-pack/claude-code`
  (or copy `claude-code/` into your plugin marketplace). Ships the
  `team-sync` skill plus a deterministic Stop-hook nudge: if a session looks
  capture-worthy and nothing was logged, the agent is continued once —
  `stop_hook_active` guards against loops — to offer a capture. It reminds;
  it never blocks or auto-shares.
- **Cursor:** copy `cursor/team-sync.mdc` into `.cursor/rules/`.
- **Copilot:** paste `copilot/AGENTS-snippet.md` into your `AGENTS.md` or
  `.github/copilot-instructions.md`.

Set `CONTEXTCAKE_HARNESS` (or pass `--harness`) per client so telemetry can
tell harnesses apart.

## 4. Telemetry — what is and is not recorded

With `--telemetry`, the server appends events to
`telemetry/<author>/<YYYY-MM>.ndjson` in the live repo. Exact schema, one
line per event:

```json
{ "ts": "…", "user": "…", "harness": "…", "event": "read|search_hit|capture|confirm|promote", "concept": "…", "layer": "…", "captureKind": "…" }
```

Concept ids and enums only — **never prompts, transcripts, or capture
bodies**. Telemetry off (`--telemetry` absent) changes nothing else.
Dashboard: `node team-activity.mjs --live-root ~/kb-live --out
apps/control-surface/team-activity.json`, then serve the control surface.

## 5. Promotion — the review gate

Captures decay from default retrieval after 14 days (still readable by id;
the control surface shows them as archived). Durability comes only from
promotion:

```bash
# request (stages under _review/promotions/ in the curated bundle)
node promote.mjs --from-live ~/kb-live --capture captures/investigation/<id> --target ~/kb-team
# approve (writes the curated concept durably, THEN cleans up)
node promote.mjs --from-live ~/kb-live --target ~/kb-team --approve ~/kb-team/_review/promotions/<slug>.md
```

Defaults: `decision` → `decisions/`, `investigation` → `systems/`; `gotcha`
and `artifact` need `--dest`. Add `--telemetry` to record the promote event.

## 6. Failure recovery

- **Push fails (offline):** the capture commit stays local, marked queued.
  Any explicit sync — or the next confirmed capture — retries it.
- **Approve interrupted after the curated write:** re-run the same approve;
  it is idempotent (a valid curated concept is never rewritten, cleanup just
  completes). The live capture is never deleted before the curated write is
  verified durable.
- **Rebase conflict on pull:** aborted automatically; the server serves the
  current tree and your queued commits stay intact. Per-author file paths
  make this rare by construction.
- **Credential in a capture:** hard-rejected at staging — remove the secret
  and re-stage. Captures are never redacted-and-shared.
