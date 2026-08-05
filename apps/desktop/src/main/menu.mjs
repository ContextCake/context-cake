import { app, Menu, shell } from 'electron'
import { checkInteractive } from './updater.mjs'
import { installCli } from './cli-install.mjs'
import { readSettings, writeLocalSettings, writeSettings } from './settings.mjs'

export function buildMenu(getWindow, onSettingsChange) {
  const invoke = (command) => getWindow()?.webContents.send('commands:invoke', command)
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => invoke('settings'),
        },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => checkInteractive(getWindow()),
        },
        { type: 'separator' },
        {
          label: 'Check for Updates Automatically',
          type: 'checkbox',
          checked: readSettings().updateCheck,
          click: (item) => onSettingsChange?.(writeSettings({ updateCheck: item.checked }), 'updateCheck'),
        },
        {
          label: 'Share Anonymous Usage Metrics',
          type: 'checkbox',
          checked: readSettings().anonymousMetrics === true,
          click: (item) => onSettingsChange?.(writeLocalSettings({ anonymousMetrics: item.checked }), 'anonymousMetrics'),
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
        { label: 'Go to Sources', accelerator: 'CmdOrCtrl+4', click: () => invoke('destination:4') },
        { label: 'Go to Review', accelerator: 'CmdOrCtrl+5', click: () => invoke('destination:5') },
        { type: 'separator' },
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+K', click: () => invoke('command-palette') },
        { label: 'Search This View', accelerator: 'CmdOrCtrl+F', click: () => invoke('search') },
        { label: 'Ask ContextCake', accelerator: 'CmdOrCtrl+Shift+A', click: () => invoke('ask') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', click: () => invoke('toggle-sidebar') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
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
