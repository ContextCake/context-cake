import fs from 'node:fs'
import path from 'node:path'

export const CLI_LINK = '/usr/local/bin/contextcake'

export function inspectCliStatus({ isPackaged, cliShim, link = CLI_LINK }) {
  const result = classifyCliLink({ isPackaged, cliShim, link })
  // Harness connection is sudo-free: the console builds `claude mcp add …`
  // payloads from this absolute shim path whenever the /usr/local/bin name is
  // unusable (missing/stale/conflict). Development has no packaged shim, and a
  // blocked (translocated/DMG) path vanishes when the app quits or the image
  // unmounts — both report null so an ephemeral absolute path can never leak
  // into a harness configuration.
  const shimPath = isPackaged && result.status !== 'blocked' ? cliShim : null
  return { ...result, shimPath }
}

function classifyCliLink({ isPackaged, cliShim, link }) {
  if (!isPackaged) {
    return { status: 'development', message: 'CLI installation is available in packaged builds.' }
  }
  if (cliShim.includes('/AppTranslocation/') || cliShim.startsWith('/Volumes/')) {
    return { status: 'blocked', message: 'Move ContextCake to Applications and reopen it before installing the command-line tool.' }
  }

  let linkStat
  try {
    linkStat = fs.lstatSync(link)
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing', message: 'The ContextCake command-line tool is not installed.' }
    return { status: 'conflict', message: 'ContextCake could not inspect the command-line tool safely.' }
  }

  if (!linkStat.isSymbolicLink()) {
    return { status: 'conflict', message: 'A real file already uses the ContextCake command name. It was not changed.' }
  }

  try {
    const rawTarget = fs.readlinkSync(link)
    const resolvedTarget = path.resolve(path.dirname(link), rawTarget)
    if (resolvedTarget !== path.resolve(cliShim) || !fs.existsSync(cliShim)) {
      return { status: 'stale', message: 'The command-line tool points to another or unavailable ContextCake installation.' }
    }
  } catch {
    return { status: 'stale', message: 'The command-line tool needs to be reinstalled.' }
  }

  return { status: 'installed', message: 'The ContextCake command-line tool is installed.' }
}
