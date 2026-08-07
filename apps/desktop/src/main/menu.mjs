import { app, Menu, shell } from 'electron'
import { checkInteractive } from './updater.mjs'
import { installCli } from './cli-install.mjs'
export function buildMenu(getWindow, openSettings) {
  const invoke = (command) => {
    const window = getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send('commands:invoke', command)
  }
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => openSettings?.(),
        },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => checkInteractive(getWindow()),
        },
        { type: 'separator' },
        {
          label: 'Install Command Line Tool…',
          click: () => installCli(getWindow()),
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Go to Home', accelerator: 'CmdOrCtrl+1', click: () => invoke('destination:1') },
        { label: 'Go to Cascade', accelerator: 'CmdOrCtrl+2', click: () => invoke('destination:2') },
        { label: 'Go to Knowledge', accelerator: 'CmdOrCtrl+3', click: () => invoke('destination:3') },
        // The source navigator. ⌘3 restores whichever Knowledge subview was
        // last open; this one always lands on Files, and the renderer binds
        // the same chord so the browser build behaves identically.
        { label: 'Go to Files', accelerator: 'CmdOrCtrl+Shift+F', click: () => invoke('view:files') },
        { label: 'Go to Sources', accelerator: 'CmdOrCtrl+4', click: () => invoke('destination:4') },
        { label: 'Go to Review', accelerator: 'CmdOrCtrl+5', click: () => invoke('destination:5') },
        { type: 'separator' },
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+K', click: () => invoke('command-palette') },
        { label: 'Search This View', accelerator: 'CmdOrCtrl+F', click: () => invoke('search') },
        { label: 'Ask ContextCake', accelerator: 'CmdOrCtrl+Shift+A', click: () => invoke('ask') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', click: () => invoke('toggle-sidebar') },
        // Reload bypasses the renderer's unsaved-file navigation guard, and
        // neither reload nor DevTools belongs in the shipped desktop app.
        // Keep both available to developers running an unpackaged build.
        ...(!app.isPackaged ? [
          { type: 'separator' },
          { role: 'reload' },
          { role: 'toggleDevTools' },
        ] : []),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'ContextCake Documentation',
          click: () => shell.openExternal('https://contextcake.com/docs/'),
        },
        {
          label: 'Report an Issue',
          click: () => shell.openExternal('https://github.com/ContextCake/context-cake/issues'),
        },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}
