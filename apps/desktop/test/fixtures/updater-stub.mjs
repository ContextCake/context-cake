import { EventEmitter } from 'node:events'
export const app = Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '0.7.5' })
export const boxes = []
export const dialog = { showMessageBox: async (_win, options) => { boxes.push(options); return { response: 1 } } }
export const preferences = { updateCheck: true }
export const readSettings = () => preferences
export const calls = { background: 0, manual: 0, install: 0 }
export const autoUpdater = Object.assign(new EventEmitter(), {
  async checkForUpdatesAndNotify() { calls.background++ },
  async checkForUpdates() { calls.manual++; this.emit('update-not-available'); return { updateInfo: { version: '0.7.5' } } },
  quitAndInstall() { calls.install++ },
})
export default { autoUpdater }
