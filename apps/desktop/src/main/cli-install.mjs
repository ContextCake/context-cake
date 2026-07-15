// "Install Command Line Tool…" — symlinks the bundled shim into
// /usr/local/bin (VS Code pattern). We only ever write a symlink pointing at
// the app bundle; the shim itself ships inside Resources and is replaced by
// updates automatically.
import fs from 'node:fs'
import path from 'node:path'
import { app, clipboard, dialog } from 'electron'
import { enginePaths } from './paths.mjs'
import { CLI_LINK, inspectCliStatus } from './cli-status.mjs'

export function getCliStatus() {
  return inspectCliStatus({
    isPackaged: app.isPackaged,
    cliShim: enginePaths().cliShim,
  })
}

export async function installCli(win, { showSuccess = true } = {}) {
  const { cliShim } = enginePaths()
  const current = getCliStatus()

  if (current.status === 'development') {
    await dialog.showMessageBox(win, {
      type: 'info',
      message: 'CLI install is for packaged builds.',
      detail: `In development, run the shim directly:\n${cliShim}`,
    })
    return current
  }

  // Gatekeeper App Translocation runs a quarantined app from an ephemeral,
  // randomized mount; a DMG mounts read-only under /Volumes. Symlinking into
  // either points /usr/local/bin/contextcake at a path that vanishes when the
  // app quits or the image unmounts — the exact scenario that leaves
  // `contextcake mcp` dead. Refuse and tell the user to move the app first.
  if (current.status === 'blocked') {
    await dialog.showMessageBox(win, {
      type: 'warning',
      message: 'Move ContextCake to Applications first.',
      detail:
        'ContextCake is running from the disk image or a temporary quarantine '
        + 'location. Drag ContextCake into your Applications folder, reopen it '
        + 'from there, then install the command line tool.',
    })
    return current
  }

  if (current.status === 'conflict') {
    await dialog.showMessageBox(win, {
      type: 'warning',
      message: "ContextCake did not replace '/usr/local/bin/contextcake'.",
      detail: 'That path contains a real file rather than a ContextCake symlink. Move or rename it yourself, then try again.',
    })
    return current
  }

  if (current.status === 'installed') {
    if (showSuccess) {
      await dialog.showMessageBox(win, {
        type: 'info',
        message: "The 'contextcake' command is already installed.",
        detail: 'Connect a harness with:\nclaude mcp add --scope user contextcake -- contextcake mcp',
      })
    }
    return current
  }

  try {
    fs.mkdirSync(path.dirname(CLI_LINK), { recursive: true })
    try {
      // Replace only things that are already symlinks; never clobber a real file.
      if (fs.lstatSync(CLI_LINK).isSymbolicLink()) fs.unlinkSync(CLI_LINK)
    } catch {
      // ENOENT — nothing there, proceed.
    }
    fs.symlinkSync(cliShim, CLI_LINK)
    const installed = getCliStatus()
    if (showSuccess) {
      await dialog.showMessageBox(win, {
        type: 'info',
        message: `Installed 'contextcake' in ${path.dirname(CLI_LINK)}.`,
        detail: 'Connect a harness with:\nclaude mcp add --scope user contextcake -- contextcake mcp',
      })
    }
    return installed
  } catch (err) {
    if (err?.code === 'EEXIST') {
      const conflict = getCliStatus()
      await dialog.showMessageBox(win, {
        type: 'warning',
        message: "ContextCake did not replace '/usr/local/bin/contextcake'.",
        detail: 'The command path changed while ContextCake was installing. Inspect it yourself, then try again.',
      })
      return conflict.status === 'missing'
        ? { status: 'conflict', message: 'The command path changed during installation and was not replaced.' }
        : conflict
    }
    if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
      const cmd = `sudo ln -sf "${cliShim}" ${CLI_LINK}`
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        message: 'Finish the install in Terminal.',
        detail: `Creating ${CLI_LINK} needs administrator rights. Run:\n\n${cmd}`,
        buttons: ['Copy Command', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) clipboard.writeText(cmd)
      return { status: 'missing', message: 'Administrator approval is required. The finishing command was offered for copying.' }
    }
    await dialog.showMessageBox(win, {
      type: 'error',
      message: 'Could not install the command line tool.',
      detail: String(err?.message ?? err),
    })
    return { status: 'missing', message: 'The command-line tool could not be installed. Use the ContextCake app menu to try again.' }
  }
}
