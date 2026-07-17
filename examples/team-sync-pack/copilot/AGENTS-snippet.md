# Team sync via ContextCake (paste into AGENTS.md or copilot-instructions.md)

This project uses the `contextcake` MCP server as the team's shared brain,
including a live layer of recent, unreviewed captures from teammates' agent
sessions. Set `CONTEXTCAKE_HARNESS=copilot` in the environment so reuse
telemetry attributes this client correctly.

**Before investigating anything:** call `find_captures` with keywords from
the problem. A teammate may have hit the same issue recently — their capture
carries the problem, attempts, and fix. Captures are unreviewed; weigh the
author, age, and status shown on each hit, and prefer curated concepts
(`search`, `read_file`) where they disagree.

**After a capture-worthy outcome** — a resolved investigation (problem +
fix), a decision (choice + why), a gotcha (body), or a produced spec/plan/PR
(artifact: summary + pointer) — share it in two phases:

1. Call `log_capture` with kind, a specific title, and the sections.
2. Show the returned preview to the user verbatim.
3. Call `confirm_capture` with the token ONLY after the user explicitly
   approves. Never confirm without an explicit yes.

If staging is refused (scratch work) say why and move on. If it rejects on a
credential match, remove the secret and re-stage — never paraphrase secrets.
If the server reports no author identity, ask once for a display name and
point the user at the live layer's `"git": { "profileName": "<name>" }`
manifest setting.
