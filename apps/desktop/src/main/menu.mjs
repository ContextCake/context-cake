import { app, Menu, shell } from 'electron'
import { checkInteractive } from './updater.mjs'
import { installCli } from './cli-install.mjs'
export function buildMenu(getWindow, openSettings) {
  return Menu.buildFromTemplate(menuTemplate({ getWindow, openSettings }))
}

// The platform and the actions are injectable so both menu shapes are tested
// without Electron (test/menu.test.mjs).
export function menuTemplate({
  getWindow,
  openSettings,
  platform = process.platform,
  isPackaged = app.isPackaged,
  appName = app.name,
  checkForUpdates = (window) => checkInteractive(window),
  installCommandLineTool = (window) => installCli(window),
  openExternal = (url) => shell.openExternal(url),
}) {
  const invoke = (command) => {
    const window = getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send('commands:invoke', command)
  }
  const mac = platform === 'darwin'
  const documentationItems = [
    {
      label: 'ContextCake Documentation',
      click: () => openExternal('https://contextcake.com/docs/'),
    },
    {
      label: 'Report an Issue',
      click: () => openExternal('https://github.com/ContextCake/context-cake/issues'),
    },
  ]
  // macOS keeps app-level items in the app menu. Linux has no app menu, so it
  // follows its own convention: Settings and Quit under File; About, updates,
  // and the command-line tool under Help.
  const appMenus = mac ? [
    {
      label: appName,
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
          click: () => checkForUpdates(getWindow()),
        },
        { type: 'separator' },
        {
          label: 'Install Command Line Tool…',
          click: () => installCommandLineTool(getWindow()),
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
  ] : [
    {
      label: 'File',
      submenu: [
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => openSettings?.(),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
  ]
  const helpMenu = {
    role: 'help',
    submenu: mac ? documentationItems : [
      ...documentationItems,
      { type: 'separator' },
      {
        label: 'Check for Updates…',
        click: () => checkForUpdates(getWindow()),
      },
      {
        label: 'Install Command Line Tool…',
        click: () => installCommandLineTool(getWindow()),
      },
      { type: 'separator' },
      { role: 'about' },
    ],
  }
  return [
    ...appMenus,
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Go to Workspace', accelerator: 'CmdOrCtrl+1', click: () => invoke('destination:1') },
        { label: 'Go to Map', accelerator: 'CmdOrCtrl+2', click: () => invoke('destination:2') },
        { label: 'Go to Library', accelerator: 'CmdOrCtrl+3', click: () => invoke('destination:3') },
        // The source navigator. ⌘3 restores whichever Knowledge subview was
        // last open; this one always lands on Files, and the renderer binds
        // the same chord so the browser build behaves identically.
        { label: 'Go to Files', accelerator: 'CmdOrCtrl+Shift+F', click: () => invoke('view:files') },
        { label: 'Go to Sources', accelerator: 'CmdOrCtrl+4', click: () => invoke('destination:4') },
        { label: 'Go to Diagnostics', accelerator: 'CmdOrCtrl+6', click: () => invoke('destination:6') },
        { label: 'Go to Trust', accelerator: 'CmdOrCtrl+5', click: () => invoke('destination:5') },
        { type: 'separator' },
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+K', click: () => invoke('command-palette') },
        { label: 'Search This View', accelerator: 'CmdOrCtrl+F', click: () => invoke('search') },
        { label: 'Ask ContextCake', accelerator: 'CmdOrCtrl+Shift+A', click: () => invoke('ask') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', click: () => invoke('toggle-sidebar') },
        // Reload bypasses the renderer's unsaved-file navigation guard, and
        // neither reload nor DevTools belongs in the shipped desktop app.
        // Keep both available to developers running an unpackaged build.
        ...(!isPackaged ? [
          { type: 'separator' },
          { role: 'reload' },
          { role: 'toggleDevTools' },
        ] : []),
      ],
    },
    { role: 'windowMenu' },
    helpMenu,
  ]
}
