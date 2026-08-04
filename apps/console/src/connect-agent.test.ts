import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMMAND,
  DEFAULT_HARNESS_ID,
  HARNESS_DEFINITIONS,
  MCP_SERVER_JSON,
  buildHarnessDefinitions,
  harnessById,
  mcpServerJson,
} from './connect-agent'

const SHIM = '/Applications/ContextCake.app/Contents/Resources/bin/contextcake'
const READ_ONLY_TRUTH = 'ContextCake’s tools are read-only and surface conflicting layers with their dates instead of silently merging them.'

describe('harness definitions', () => {
  it('ships the approved five clients with Claude Code as the default', () => {
    expect(DEFAULT_HARNESS_ID).toBe('claude-code')
    expect(HARNESS_DEFINITIONS.map((item) => item.id)).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'claude-desktop',
      'generic',
    ])
    expect(buildHarnessDefinitions(SHIM).map((item) => item.id)).toEqual(HARNESS_DEFINITIONS.map((item) => item.id))
  })

  it('uses the exact global registration commands for the installed PATH name', () => {
    expect(DEFAULT_COMMAND).toBe('contextcake')
    expect(harnessById('claude-code').setupPayload).toBe('claude mcp add --scope user contextcake -- contextcake mcp')
    expect(harnessById('claude-code').verifyPayload).toBe('claude mcp get contextcake')
    expect(harnessById('codex').setupPayload).toBe('codex mcp add contextcake -- contextcake mcp')
    expect(harnessById('codex').verifyPayload).toBe('codex mcp list')
  })

  it('builds every payload from the quoted absolute shim path when the CLI name is unusable', () => {
    const definitions = buildHarnessDefinitions(SHIM)
    expect(harnessById('claude-code', definitions).setupPayload).toBe(`claude mcp add --scope user contextcake -- "${SHIM}" mcp`)
    expect(harnessById('codex', definitions).setupPayload).toBe(`codex mcp add contextcake -- "${SHIM}" mcp`)
    for (const id of ['cursor', 'claude-desktop', 'generic'] as const) {
      expect(JSON.parse(harnessById(id, definitions).setupPayload)).toEqual({
        mcpServers: { contextcake: { command: SHIM, args: ['mcp'] } },
      })
    }
    // The server name and verification commands stay `contextcake` — only the
    // executable path changes.
    expect(harnessById('claude-code', definitions).verifyPayload).toBe('claude mcp get contextcake')
    expect(harnessById('generic', definitions).setupDetail).toContain(`Command: \`${SHIM}\``)
  })

  it('uses the same portable stdio definition for JSON clients', () => {
    expect(JSON.parse(MCP_SERVER_JSON)).toEqual({
      mcpServers: { contextcake: { command: 'contextcake', args: ['mcp'] } },
    })
    expect(mcpServerJson(SHIM)).toBe(JSON.stringify({
      mcpServers: { contextcake: { command: SHIM, args: ['mcp'] } },
    }, null, 2))
    expect(harnessById('cursor').setupPayload).toBe(MCP_SERVER_JSON)
    expect(harnessById('claude-desktop').setupPayload).toBe(MCP_SERVER_JSON)
    expect(harnessById('generic').setupPayload).toBe(MCP_SERVER_JSON)
  })

  it('provides exact global targets and verification guidance for every client', () => {
    expect(HARNESS_DEFINITIONS.map(({ id, setupDetail, verifyDetail }) => ({ id, setupDetail, verifyDetail }))).toEqual([
      {
        id: 'claude-code',
        setupDetail: 'Run this once in Terminal. Claude Code stores it in your user configuration.',
        verifyDetail: `Confirm the server is registered, then start a new Claude Code session. ${READ_ONLY_TRUTH}`,
      },
      {
        id: 'codex',
        setupDetail: 'Run this once in Terminal. Codex clients on this machine share the configuration.',
        verifyDetail: `Confirm registration with the CLI. In a Codex session, \`/mcp\` shows the active server. ${READ_ONLY_TRUTH}`,
      },
      {
        id: 'cursor',
        setupDetail: 'Add this server entry to `~/.cursor/mcp.json`. Keep any servers already in the file.',
        verifyDetail: `Open Cursor Settings → Tools & MCP and confirm that ContextCake is enabled. ${READ_ONLY_TRUTH}`,
      },
      {
        id: 'claude-desktop',
        setupDetail: 'In Claude Desktop, open Settings → Developer → Edit Config and add this server entry.',
        verifyDetail: `Quit and reopen Claude Desktop, then use the + menu → Connectors to inspect ContextCake. ${READ_ONLY_TRUTH}`,
      },
      {
        id: 'generic',
        setupDetail: 'Server name: `contextcake` · Command: `contextcake` · Arguments: `["mcp"]`',
        verifyDetail: `Restart or reload the client, confirm \`contextcake\` exposes six tools, then call \`list_concepts\`. ${READ_ONLY_TRUTH}`,
      },
    ])
  })

  it('states the true tool count and keeps the read-only sentence out of the agent prompt', () => {
    expect(harnessById('generic').verifyDetail).toContain('six tools')
    expect(harnessById('generic').verifyDetail).not.toContain('four tools')
    for (const harness of buildHarnessDefinitions(SHIM)) {
      // Human-visible copy carries the reassurance once per harness…
      expect(harness.verifyDetail).toContain(READ_ONLY_TRUTH)
      // …and the agent prompt keeps only its original behavior text.
      expect(harness.prompt).not.toContain(READ_ONLY_TRUTH)
    }
  })

  it('embeds the active command text in every copyable agent prompt', () => {
    expect(harnessById('claude-code').prompt).toContain('Run `claude mcp add --scope user contextcake -- contextcake mcp`')
    expect(harnessById('codex').prompt).toContain('Run `codex mcp add contextcake -- contextcake mcp`')
    for (const id of ['cursor', 'claude-desktop', 'generic'] as const) {
      expect(harnessById(id).prompt).toContain('command `contextcake`')
    }
    const shimmed = buildHarnessDefinitions(SHIM)
    for (const harness of shimmed) {
      expect(harness.prompt).toContain(SHIM)
    }
    expect(harnessById('claude-code', shimmed).prompt).toContain(`Run \`claude mcp add --scope user contextcake -- "${SHIM}" mcp\``)
    expect(harnessById('codex', shimmed).prompt).toContain(`Run \`codex mcp add contextcake -- "${SHIM}" mcp\``)
    for (const id of ['cursor', 'claude-desktop', 'generic'] as const) {
      expect(harnessById(id, shimmed).prompt).toContain(`\`${SHIM}\``)
    }
  })

  it('teaches every harness the same provenance and conflict behavior without secrets', () => {
    for (const harness of [...HARNESS_DEFINITIONS, ...buildHarnessDefinitions(SHIM)]) {
      expect(harness.prompt).toContain('Preserve every existing MCP server')
      expect(harness.prompt).toContain('call list_concepts')
      expect(harness.prompt).toContain('Use ContextCake before answering project-specific questions')
      expect(harness.prompt).toContain('Respect source provenance')
      expect(harness.prompt).toContain('surface conflicts')
      expect(harness.prompt).toContain('read-only and run locally')
      // The shim lives in /Applications — user home paths never appear.
      expect(harness.prompt).not.toMatch(/\/Users\//)
      expect(harness.prompt).not.toMatch(/token|secret|password/i)
    }
  })
})
