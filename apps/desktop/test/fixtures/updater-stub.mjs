import { EventEmitter } from 'node:events'
export const app = Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '0.7.5' })
export const boxes = []
// `response` is the button the next dialog answers with (1 = Later/Cancel).
export const dialogAnswer = { response: 1 }
export const dialog = { showMessageBox: async (_win, options) => { boxes.push(options); return { response: dialogAnswer.response } } }
export const opened = []
export const shell = { openExternal: async (url) => { opened.push(url) } }
// The version the fake release feed reports; newer than getVersion() means an update.
export const feed = { latest: '0.7.5' }
export const preferences = { updateCheck: true }
export const readSettings = () => preferences
export const calls = { background: 0, manual: 0, install: 0 }
export const autoUpdater = Object.assign(new EventEmitter(), {
  async checkForUpdatesAndNotify() { calls.background++ },
  async checkForUpdates() {
    calls.manual++
    if (feed.latest === '0.7.5') this.emit('update-not-available')
    else this.emit('update-available', { version: feed.latest })
    return { updateInfo: { version: feed.latest } }
  },
  quitAndInstall() { calls.install++ },
})
export default { autoUpdater }
