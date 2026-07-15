# Connect an Agent Onboarding

ContextCake gives desktop users a fast, trustworthy way to connect their
resolved cascade to the AI harness they already use, without requiring them to
understand MCP configuration formats.

**Date:** 2026-07-14
**Status:** Approved (implementation plan approved by John, 2026-07-14)
**Depends on:** `specs/contextcake-integrations/spec.md`,
`specs/contextcake-distribution/design.md`

## Problem Statement

ContextCake already exposes a local read-only MCP server, but users currently
receive one Claude-specific command with little guidance. Every client stores
MCP configuration differently, so connecting ContextCake still requires users
to find external documentation, translate commands into configuration files,
and invent a first prompt that teaches the agent how to use provenance and
conflicts correctly. That friction undermines the product promise that a user
configures ContextCake once and then uses the same resolved context everywhere.

## User Stories

- As a desktop user, I can choose my AI client and receive instructions that
  match it, so I do not have to translate generic MCP documentation.
- As a user who prefers agent-assisted setup, I can copy one complete prompt
  that tells my harness how to connect and verify ContextCake safely.
- As a user who prefers manual setup, I can copy the exact command or
  configuration and follow a short numbered sequence.
- As a cautious user, I can see that ContextCake runs locally and exposes
  read-only tools before I connect it.
- As a keyboard or small-screen user, I can complete the same workflow without
  losing access to any action or instruction.

## Acceptance Criteria

- [ ] WHEN a configured desktop user opens Connect an agent THE SYSTEM SHALL
  present Claude Code, Codex, Cursor, Claude Desktop, and Generic MCP choices,
  with Claude Code selected initially.
- [ ] WHEN the selected client changes THE SYSTEM SHALL update the setup
  prompt, registration instructions, verification instructions, and first-use
  prompt as one consistent client-specific set.
- [ ] WHEN the user copies any payload THE SYSTEM SHALL announce whether the
  copy succeeded and SHALL provide a manual fallback if clipboard access is
  unavailable.
- [ ] WHEN the ContextCake command-line tool is unavailable THE SYSTEM SHALL
  explain the prerequisite and provide the existing safe installation path
  before presenting setup as ready.
- [ ] WHEN no usable cascade exists THE SYSTEM SHALL direct the user through
  source setup instead of generating a connection that cannot start.
- [ ] WHEN the workflow is complete THE USER SHALL be able to verify the
  `contextcake` server and ask the client to call `list_concepts` within two
  minutes, excluding third-party application download time.
- [ ] WHEN any client receives the generated guidance THE GUIDANCE SHALL say to
  consult ContextCake for project-specific facts, respect provenance, and
  surface conflicts rather than silently reconciling them.
- [ ] WHEN the dialog is used at supported desktop sizes THE SYSTEM SHALL keep
  every action keyboard accessible, maintain visible focus, and avoid
  page-level horizontal scrolling.
- [ ] WHEN the MCP server initializes THE SYSTEM SHALL describe its read-only
  usage guidance and identify its tools as non-destructive.
- [ ] WHEN the public web demo or browser console renders THE SYSTEM SHALL keep
  its existing behavior; the working onboarding flow belongs to the desktop
  app.

## Out of Scope

- Directly editing another application's configuration.
- One-click deep links or a packaged Claude Desktop extension.
- Profile selection, new source adapters, or redesigning source onboarding.
- Write-capable MCP tools, permission toggles, or remote ContextCake hosting.
- Slack, Confluence, Google Drive, authentication, or account work.

## Open Questions

None for this release.

## Dependencies

- The packaged ContextCake command-line tool and its existing safe installer.
- The local default manifest produced by desktop source setup.
- The existing read-only MCP tools: `search`, `read_file`, `list_concepts`, and
  `get_links`.
