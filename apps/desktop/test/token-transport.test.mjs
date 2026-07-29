import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainSource = fs.readFileSync(path.join(appRoot, 'src/main/main.mjs'), 'utf8')
const preloadSource = fs.readFileSync(path.join(appRoot, 'src/preload.cjs'), 'utf8')

test('the local API bearer travels through trusted IPC, never renderer argv', () => {
  assert.doesNotMatch(mainSource, /--cc-token=/)
  assert.doesNotMatch(preloadSource, /arg\(['"]cc-token['"]\)/)
  assert.match(mainSource, /handleTrustedIpc\(['"]contextcake:get-api-token['"]/)
  assert.match(preloadSource, /ipcRenderer\.invoke\(['"]contextcake:get-api-token['"]\)/)
})
