import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Where "Install Command Line Tool…" puts the `contextcake` link
// (distribution design §11.2). macOS uses the conventional /usr/local/bin,
// which may need administrator rights. Linux never asks for sudo: the link goes
// in ~/.local/bin, which systemd's file-hierarchy and most distributions'
// ~/.profile put on PATH.
export function cliLinkPath({ platform = process.platform, homedir = os.homedir() } = {}) {
  if (platform === 'linux') return path.posix.join(homedir, '.local', 'bin', 'contextcake')
  return '/usr/local/bin/contextcake'
}

export function inspectCliStatus({
  isPackaged,
  cliShim,
  platform = process.platform,
  link = cliLinkPath({ platform }),
}) {
  const result = classifyCliLink({ isPackaged, cliShim, link, platform })
  // The console builds every harness connect command from this absolute shim
  // path, never the bare `contextcake` name: once the npm package ships, the
  // first `contextcake` on PATH may be a different install running a different
  // engine version. Development has no packaged shim, and a blocked
  // (translocated/DMG) path vanishes when the app quits or the image unmounts;
  // both report null so an ephemeral path never reaches a harness config.
  const shimPath = isPackaged && result.status !== 'blocked' ? cliShim : null
  return { ...result, shimPath, linkPath: link }
}

function realpathOrNull(file) {
  try { return fs.realpathSync(file) } catch { return null }
}

// A shim from some copy of the ContextCake app: <resources>/bin/contextcake
// beside <resources>/engine/cli/cli.mjs. Replacing a link to one (an older or
// moved app) is safe; replacing a link to anything else would break a tool the
// user installed on purpose, such as the npm CLI.
function isAppShim(file) {
  const resources = path.dirname(path.dirname(file))
  return path.basename(file) === 'contextcake' && fs.existsSync(path.join(resources, 'engine', 'cli', 'cli.mjs'))
}

function classifyCliLink({ isPackaged, cliShim, link, platform }) {
  if (!isPackaged) {
    return { status: 'development', message: 'CLI installation is available in packaged builds.' }
  }
  // Gatekeeper translocation and a mounted DMG exist only on macOS.
  if (platform === 'darwin' && (cliShim.includes('/AppTranslocation/') || cliShim.startsWith('/Volumes/'))) {
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
    if (resolvedTarget === path.resolve(cliShim) && fs.existsSync(cliShim)) {
      return { status: 'installed', message: 'The ContextCake command-line tool is installed.' }
    }
    const target = realpathOrNull(link)
    if (target && !isAppShim(target)) {
      return { status: 'conflict', message: 'Another program owns the contextcake command name. It was not changed.' }
    }
  } catch {
    return { status: 'stale', message: 'The command-line tool needs to be reinstalled.' }
  }

  return { status: 'stale', message: 'The command-line tool points to another or unavailable ContextCake installation.' }
}

/**
 * Point `link` at `cliShim`. The link is re-read here, immediately before any
 * unlink, because it may have changed since the status check: only a link to
 * some ContextCake app's shim, or a dangling link, is replaced. Anything else
 * (a real file, an npm-installed CLI) throws EEXIST and is left as it is.
 */
export function replaceCliLink({ cliShim, link }) {
  fs.mkdirSync(path.dirname(link), { recursive: true })
  let stat = null
  try { stat = fs.lstatSync(link) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  if (stat) {
    const target = stat.isSymbolicLink() ? realpathOrNull(link) : undefined
    const replaceable = stat.isSymbolicLink() && (target === null || isAppShim(target))
    if (!replaceable) {
      throw Object.assign(new Error(`${link} is not a ContextCake link and was not replaced.`), { code: 'EEXIST' })
    }
    fs.unlinkSync(link)
  }
  fs.symlinkSync(cliShim, link)
}

/** True when `dir` is one of the PATH entries this process was started with. */
export function isOnPath(dir, { pathEnv = process.env.PATH ?? '', platform = process.platform } = {}) {
  const delimiter = platform === 'win32' ? ';' : ':'
  const wanted = path.resolve(dir)
  return String(pathEnv).split(delimiter).some((entry) => entry && path.resolve(entry) === wanted)
}
