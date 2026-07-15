// "Install Command Line Tool…" — symlinks the bundled shim into
// /usr/local/bin (VS Code pattern). We only ever write a symlink pointing at
// the app bundle; the shim itself ships inside Resources and is replaced by
// updates automatically.
import fs from 'node:fs'
import path from 'node:path'
import { app, clipboard, dialog } from 'electron'
import { enginePaths } from './paths.mjs'

const LINK = '/usr/local/bin/contextcake'

export async function installCli(win) {
  const { cliShim } = enginePaths()

  if (!app.isPackaged) {
    await dialog.showMessageBox(win, {
      type: 'info',
      message: 'CLI install is for packaged builds.',
      detail: `In development, run the shim directly:\n${cliShim}`,
    })
    return
  }

  // Gatekeeper App Translocation runs a quarantined app from an ephemeral,
  // randomized mount; a DMG mounts read-only under /Volumes. Symlinking into
  // either points /usr/local/bin/contextcake at a path that vanishes when the
  // app quits or the image unmounts — the exact scenario that leaves
  // `contextcake mcp` dead. Refuse and tell the user to move the app first.
  if (cliShim.includes('/AppTranslocation/') || cliShim.startsWith('/Volumes/')) {
    await dialog.showMessageBox(win, {
      type: 'warning',
      message: 'Move ContextCake to Applications first.',
      detail:
        'ContextCake is running from the disk image or a temporary quarantine '
        + 'location. Drag ContextCake into your Applications folder, reopen it '
        + 'from there, then install the command line tool.',
    })
    return
  }

  try {
    fs.mkdirSync(path.dirname(LINK), { recursive: true })
    try {
      // Replace only things that are already symlinks; never clobber a real file.
      if (fs.lstatSync(LINK).isSymbolicLink()) fs.unlinkSync(LINK)
    } catch {
      // ENOENT — nothing there, proceed.
    }
    fs.symlinkSync(cliShim, LINK)
    await dialog.showMessageBox(win, {
      type: 'info',
      message: `Installed 'contextcake' in ${path.dirname(LINK)}.`,
      detail: `Connect a harness with:\nclaude mcp add contextcake -- contextcake mcp`,
    })
  } catch (err) {
    if (err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EEXIST')) {
      const cmd = `sudo ln -sf "${cliShim}" ${LINK}`
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        message: 'Finish the install in Terminal.',
        detail: `Creating ${LINK} needs administrator rights. Run:\n\n${cmd}`,
        buttons: ['Copy Command', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) clipboard.writeText(cmd)
      return
    }
    await dialog.showMessageBox(win, {
      type: 'error',
      message: 'Could not install the command line tool.',
      detail: String(err?.message ?? err),
    })
  }
}
