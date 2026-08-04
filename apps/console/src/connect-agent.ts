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

/** The PATH-resolved command name used once the optional CLI shortcut exists. */
export const DEFAULT_COMMAND = 'contextcake'

export function mcpServerJson(command: string): string {
  return JSON.stringify({
    mcpServers: {
      contextcake: {
        command,
        args: ['mcp'],
      },
    },
  }, null, 2)
}

export const MCP_SERVER_JSON = mcpServerJson(DEFAULT_COMMAND)

const FIRST_PROMPT = 'Use ContextCake to list the concepts available to you. Briefly describe the contributing layers, then tell me which project-specific questions you can answer from this context.'

const BEHAVIOR = `After connecting, verify that the server is available and call list_concepts. Use ContextCake before answering project-specific questions. Respect source provenance and surface conflicts with their contributing layers and dates instead of silently reconciling them. ContextCake's tools are read-only and run locally.`

// Human-visible reassurance shown with every harness's verify step. The
// agent-facing prompt already teaches this behavior (BEHAVIOR above) — keep
// this copy out of the prompts so agents aren't told twice.
const READ_ONLY_TRUTH = 'ContextCake’s tools are read-only and surface conflicting layers with their dates instead of silently merging them.'

function setupPrompt(client: string, instruction: string): string {
  return `Connect ContextCake to ${client} as a global, user-scoped stdio MCP server named "contextcake". ${instruction} Preserve every existing MCP server and setting; do not overwrite the configuration wholesale. ${BEHAVIOR}`
}

// A bare command name travels unquoted (matching what users see in docs); an
// absolute shim path is always double-quoted so paths survive shells verbatim.
function shellCommand(command: string): string {
  return command === DEFAULT_COMMAND ? command : `"${command}"`
}

/**
 * Build the five harness definitions around one MCP server command. Callers
 * pass the bare `contextcake` name when the CLI shortcut is installed (or when
 * no desktop shell is present) and the app's absolute shim path when it is not
 * — connecting a harness never requires the sudo-gated PATH install.
 */
export function buildHarnessDefinitions(command: string = DEFAULT_COMMAND): readonly HarnessDefinition[] {
  const shell = shellCommand(command)
  const serverJson = mcpServerJson(command)
  const claudeAdd = `claude mcp add --scope user contextcake -- ${shell} mcp`
  const codexAdd = `codex mcp add contextcake -- ${shell} mcp`
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      shortLabel: 'Claude Code',
      icon: 'terminal',
      summary: 'Available to Claude Code in every project.',
      docsUrl: 'https://code.claude.com/docs/en/mcp',
      setupTitle: 'Add the user-scoped MCP server',
      setupDetail: 'Run this once in Terminal. Claude Code stores it in your user configuration.',
      setupPayload: claudeAdd,
      verifyDetail: `Confirm the server is registered, then start a new Claude Code session. ${READ_ONLY_TRUTH}`,
      verifyPayload: 'claude mcp get contextcake',
      prompt: setupPrompt('Claude Code', `Run \`${claudeAdd}\`, then verify it with \`claude mcp get contextcake\`.`),
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
      setupPayload: codexAdd,
      verifyDetail: `Confirm registration with the CLI. In a Codex session, \`/mcp\` shows the active server. ${READ_ONLY_TRUTH}`,
      verifyPayload: 'codex mcp list',
      prompt: setupPrompt('Codex', `Run \`${codexAdd}\`, then verify it with \`codex mcp list\`.`),
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
      setupPayload: serverJson,
      verifyDetail: `Open Cursor Settings → Tools & MCP and confirm that ContextCake is enabled. ${READ_ONLY_TRUTH}`,
      prompt: setupPrompt('Cursor', `Merge a ContextCake server entry into \`~/.cursor/mcp.json\`: command \`${command}\` with arguments \`["mcp"]\`.`),
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
      setupPayload: serverJson,
      verifyDetail: `Quit and reopen Claude Desktop, then use the + menu → Connectors to inspect ContextCake. ${READ_ONLY_TRUTH}`,
      prompt: setupPrompt('Claude Desktop', `Guide me through merging a server entry with command \`${command}\` and arguments \`["mcp"]\` into \`claude_desktop_config.json\`, then restart Claude Desktop.`),
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
      setupDetail: `Server name: \`contextcake\` · Command: \`${command}\` · Arguments: \`["mcp"]\``,
      setupPayload: serverJson,
      verifyDetail: `Restart or reload the client, confirm \`contextcake\` exposes six tools, then call \`list_concepts\`. ${READ_ONLY_TRUTH}`,
      prompt: setupPrompt('my MCP client', `Configure command \`${command}\` with argument \`mcp\` using the provided JSON shape.`),
      firstPrompt: FIRST_PROMPT,
    },
  ]
}

export const HARNESS_DEFINITIONS: readonly HarnessDefinition[] = buildHarnessDefinitions()

export const DEFAULT_HARNESS_ID: HarnessId = 'claude-code'

export function harnessById(id: HarnessId, definitions: readonly HarnessDefinition[] = HARNESS_DEFINITIONS): HarnessDefinition {
  return definitions.find((item) => item.id === id) ?? definitions[0]
}
