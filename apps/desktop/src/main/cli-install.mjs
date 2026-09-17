// "Install Command Line Tool…" — symlinks the bundled shim onto PATH (VS Code
// pattern): /usr/local/bin on macOS, ~/.local/bin on Linux (no sudo). We only
// ever write a symlink pointing at the installed app; the shim itself ships
// inside the app's resources and is replaced by updates automatically.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, clipboard, dialog } from 'electron'
import { enginePaths } from './paths.mjs'
import { cliLinkPath, inspectCliStatus, isOnPath } from './cli-status.mjs'

export function getCliStatus() {
  return inspectCliStatus({
    isPackaged: app.isPackaged,
    cliShim: enginePaths().cliShim,
  })
}

// What a person pastes into a terminal: the absolute shim path, so the harness
// runs this app's engine even when another `contextcake` comes first on PATH.
function connectHint(cliShim) {
  return `Connect a harness with:\nclaude mcp add --scope user contextcake -- "${cliShim}" mcp`
}

// "~/.local/bin" reads better in a dialog than the expanded home path.
function displayDir(dir) {
  const home = os.homedir()
  return dir === home || dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir
}

export async function installCli(win, { showSuccess = true } = {}) {
  const { cliShim } = enginePaths()
  const link = cliLinkPath()
  const linkDir = path.dirname(link)
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
      message: `ContextCake did not replace '${displayDir(link)}'.`,
      detail: 'Another program or a real file already uses that name. Move or rename it yourself, then try again.',
    })
    return current
  }

  if (current.status === 'installed') {
    if (showSuccess) {
      await dialog.showMessageBox(win, {
        type: 'info',
        message: "The 'contextcake' command is already installed.",
        detail: connectHint(cliShim),
      })
    }
    return current
  }

  try {
    fs.mkdirSync(linkDir, { recursive: true })
    try {
      // Replace only things that are already symlinks; never clobber a real file.
      if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link)
    } catch {
      // ENOENT — nothing there, proceed.
    }
    fs.symlinkSync(cliShim, link)
    const installed = getCliStatus()
    // A GUI session's PATH is fixed at login. ~/.local/bin is added by
    // ~/.profile only if it existed then, so a folder this install just
    // created reaches terminals after the next login.
    const pathNote = process.platform === 'linux' && !isOnPath(linkDir)
      ? `\n\n${displayDir(linkDir)} is not on your PATH yet. Log out and back in, or add it to your shell profile, to run 'contextcake' by name.`
      : ''
    if (showSuccess) {
      await dialog.showMessageBox(win, {
        type: pathNote ? 'warning' : 'info',
        message: `Installed 'contextcake' in ${displayDir(linkDir)}.`,
        detail: `${connectHint(cliShim)}${pathNote}`,
      })
    }
    return pathNote ? { ...installed, message: `${installed.message} ${displayDir(linkDir)} is not on PATH yet.` } : installed
  } catch (err) {
    if (err?.code === 'EEXIST') {
      const conflict = getCliStatus()
      await dialog.showMessageBox(win, {
        type: 'warning',
        message: `ContextCake did not replace '${displayDir(link)}'.`,
        detail: 'The command path changed while ContextCake was installing. Inspect it yourself, then try again.',
      })
      return conflict.status === 'missing'
        ? { ...conflict, status: 'conflict', message: 'The command path changed during installation and was not replaced.', shimPath: cliShim }
        : conflict
    }
    // Only /usr/local/bin can need administrator rights. A Linux home folder
    // that refuses a write is not something sudo should paper over.
    if (process.platform === 'darwin' && err && (err.code === 'EACCES' || err.code === 'EPERM')) {
      const cmd = `sudo ln -sf "${cliShim}" ${link}`
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        message: 'Finish the install in Terminal.',
        detail: `Creating ${link} needs administrator rights. Run:\n\n${cmd}`,
        buttons: ['Copy Command', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) clipboard.writeText(cmd)
      return { ...current, status: 'missing', message: 'Administrator approval is required. The finishing command was offered for copying.', shimPath: cliShim }
    }
    await dialog.showMessageBox(win, {
      type: 'error',
      message: 'Could not install the command line tool.',
      detail: String(err?.message ?? err),
    })
    return { ...current, status: 'missing', message: 'The command-line tool could not be installed. Use the ContextCake app menu to try again.', shimPath: cliShim }
  }
}
