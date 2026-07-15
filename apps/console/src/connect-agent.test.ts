import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_ID, HARNESS_DEFINITIONS, MCP_SERVER_JSON, harnessById } from './connect-agent'

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
  })

  it('uses the exact global registration commands', () => {
    expect(harnessById('claude-code').setupPayload).toBe('claude mcp add --scope user contextcake -- contextcake mcp')
    expect(harnessById('claude-code').verifyPayload).toBe('claude mcp get contextcake')
    expect(harnessById('codex').setupPayload).toBe('codex mcp add contextcake -- contextcake mcp')
    expect(harnessById('codex').verifyPayload).toBe('codex mcp list')
  })

  it('uses the same portable stdio definition for JSON clients', () => {
    expect(JSON.parse(MCP_SERVER_JSON)).toEqual({
      mcpServers: { contextcake: { command: 'contextcake', args: ['mcp'] } },
    })
    expect(harnessById('cursor').setupPayload).toBe(MCP_SERVER_JSON)
    expect(harnessById('claude-desktop').setupPayload).toBe(MCP_SERVER_JSON)
    expect(harnessById('generic').setupPayload).toBe(MCP_SERVER_JSON)
  })

  it('provides exact global targets and verification guidance for every client', () => {
    expect(HARNESS_DEFINITIONS.map(({ id, setupDetail, verifyDetail }) => ({ id, setupDetail, verifyDetail }))).toEqual([
      {
        id: 'claude-code',
        setupDetail: 'Run this once in Terminal. Claude Code stores it in your user configuration.',
        verifyDetail: 'Confirm the server is registered, then start a new Claude Code session.',
      },
      {
        id: 'codex',
        setupDetail: 'Run this once in Terminal. Codex clients on this machine share the configuration.',
        verifyDetail: 'Confirm registration with the CLI. In a Codex session, `/mcp` shows the active server.',
      },
      {
        id: 'cursor',
        setupDetail: 'Add this server entry to `~/.cursor/mcp.json`. Keep any servers already in the file.',
        verifyDetail: 'Open Cursor Settings → Tools & MCP and confirm that ContextCake is enabled.',
      },
      {
        id: 'claude-desktop',
        setupDetail: 'In Claude Desktop, open Settings → Developer → Edit Config and add this server entry.',
        verifyDetail: 'Quit and reopen Claude Desktop, then use the + menu → Connectors to inspect ContextCake.',
      },
      {
        id: 'generic',
        setupDetail: 'Server name: `contextcake` · Command: `contextcake` · Arguments: `["mcp"]`',
        verifyDetail: 'Restart or reload the client, confirm `contextcake` exposes four tools, then call `list_concepts`.',
      },
    ])
  })

  it('teaches every harness the same provenance and conflict behavior without secrets or absolute paths', () => {
    for (const harness of HARNESS_DEFINITIONS) {
      expect(harness.prompt).toContain('Preserve every existing MCP server')
      expect(harness.prompt).toContain('call list_concepts')
      expect(harness.prompt).toContain('Use ContextCake before answering project-specific questions')
      expect(harness.prompt).toContain('Respect source provenance')
      expect(harness.prompt).toContain('surface conflicts')
      expect(harness.prompt).toContain('read-only and run locally')
      expect(harness.prompt).not.toMatch(/\/Users\//)
      expect(harness.prompt).not.toMatch(/token|secret|password/i)
    }
  })
})
