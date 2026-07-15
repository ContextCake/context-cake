import { app, Menu, shell } from 'electron'
import { checkInteractive } from './updater.mjs'
import { installCli } from './cli-install.mjs'
import { readSettings, writeSettings } from './settings.mjs'

export function buildMenu(getWindow) {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates…',
          click: () => checkInteractive(getWindow()),
        },
        { type: 'separator' },
        {
          label: 'Check for Updates Automatically',
          type: 'checkbox',
          checked: readSettings().updateCheck,
          click: (item) => writeSettings({ updateCheck: item.checked }),
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
    { role: 'viewMenu' },
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
