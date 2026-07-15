export type HarnessId = 'claude-code' | 'codex' | 'cursor' | 'claude-desktop' | 'generic'

export type HarnessIcon = 'terminal' | 'cube' | 'cursor' | 'desktop' | 'brackets'

export interface HarnessDefinition {
  id: HarnessId
  label: string
  shortLabel: string
  icon: HarnessIcon
  summary: string
  docsUrl: string
  setupTitle: string
  setupDetail: string
  setupPayload: string
  verifyDetail: string
  verifyPayload?: string
  prompt: string
  firstPrompt: string
}

export const MCP_SERVER_JSON = JSON.stringify({
  mcpServers: {
    contextcake: {
      command: 'contextcake',
      args: ['mcp'],
    },
  },
}, null, 2)

const FIRST_PROMPT = 'Use ContextCake to list the concepts available to you. Briefly describe the contributing layers, then tell me which project-specific questions you can answer from this context.'

const BEHAVIOR = `After connecting, verify that the server is available and call list_concepts. Use ContextCake before answering project-specific questions. Respect source provenance and surface conflicts with their contributing layers and dates instead of silently reconciling them. ContextCake's tools are read-only and run locally.`

function setupPrompt(client: string, instruction: string): string {
  return `Connect ContextCake to ${client} as a global, user-scoped stdio MCP server named "contextcake". ${instruction} Preserve every existing MCP server and setting; do not overwrite the configuration wholesale. ${BEHAVIOR}`
}

export const HARNESS_DEFINITIONS: readonly HarnessDefinition[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    shortLabel: 'Claude Code',
    icon: 'terminal',
    summary: 'Available to Claude Code in every project.',
    docsUrl: 'https://code.claude.com/docs/en/mcp',
    setupTitle: 'Add the user-scoped MCP server',
    setupDetail: 'Run this once in Terminal. Claude Code stores it in your user configuration.',
    setupPayload: 'claude mcp add --scope user contextcake -- contextcake mcp',
    verifyDetail: 'Confirm the server is registered, then start a new Claude Code session.',
    verifyPayload: 'claude mcp get contextcake',
    prompt: setupPrompt('Claude Code', 'Run `claude mcp add --scope user contextcake -- contextcake mcp`, then verify it with `claude mcp get contextcake`.'),
    firstPrompt: FIRST_PROMPT,
  },
  {
    id: 'codex',
    label: 'Codex',
    shortLabel: 'Codex',
    icon: 'cube',
    summary: 'Shared by the Codex app, CLI, and IDE extension.',
    docsUrl: 'https://learn.chatgpt.com/docs/extend/mcp.md',
    setupTitle: 'Add ContextCake to Codex',
    setupDetail: 'Run this once in Terminal. Codex clients on this machine share the configuration.',
    setupPayload: 'codex mcp add contextcake -- contextcake mcp',
    verifyDetail: 'Confirm registration with the CLI. In a Codex session, `/mcp` shows the active server.',
    verifyPayload: 'codex mcp list',
    prompt: setupPrompt('Codex', 'Run `codex mcp add contextcake -- contextcake mcp`, then verify it with `codex mcp list`.'),
    firstPrompt: FIRST_PROMPT,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    shortLabel: 'Cursor',
    icon: 'cursor',
    summary: 'Available globally in Cursor Agent.',
    docsUrl: 'https://docs.cursor.com/context/model-context-protocol',
    setupTitle: 'Merge into the global MCP configuration',
    setupDetail: 'Add this server entry to `~/.cursor/mcp.json`. Keep any servers already in the file.',
    setupPayload: MCP_SERVER_JSON,
    verifyDetail: 'Open Cursor Settings → Tools & MCP and confirm that ContextCake is enabled.',
    prompt: setupPrompt('Cursor', 'Merge the provided ContextCake server entry into `~/.cursor/mcp.json`.'),
    firstPrompt: FIRST_PROMPT,
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    shortLabel: 'Claude',
    icon: 'desktop',
    summary: 'Available in Claude Desktop conversations.',
    docsUrl: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers',
    setupTitle: 'Merge into Claude Desktop configuration',
    setupDetail: 'In Claude Desktop, open Settings → Developer → Edit Config and add this server entry.',
    setupPayload: MCP_SERVER_JSON,
    verifyDetail: 'Quit and reopen Claude Desktop, then use the + menu → Connectors to inspect ContextCake.',
    prompt: setupPrompt('Claude Desktop', 'Guide me through merging the provided server entry into `claude_desktop_config.json`, then restart Claude Desktop.'),
    firstPrompt: FIRST_PROMPT,
  },
  {
    id: 'generic',
    label: 'Generic MCP',
    shortLabel: 'Other MCP',
    icon: 'brackets',
    summary: 'Use the same local server in any stdio MCP client.',
    docsUrl: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers',
    setupTitle: 'Add a local stdio server',
    setupDetail: 'Server name: `contextcake` · Command: `contextcake` · Arguments: `["mcp"]`',
    setupPayload: MCP_SERVER_JSON,
    verifyDetail: 'Restart or reload the client, confirm `contextcake` exposes four tools, then call `list_concepts`.',
    prompt: setupPrompt('my MCP client', 'Configure command `contextcake` with argument `mcp` using the provided JSON shape.'),
    firstPrompt: FIRST_PROMPT,
  },
]

export const DEFAULT_HARNESS_ID: HarnessId = 'claude-code'

export function harnessById(id: HarnessId): HarnessDefinition {
  return HARNESS_DEFINITIONS.find((item) => item.id === id) ?? HARNESS_DEFINITIONS[0]
}
