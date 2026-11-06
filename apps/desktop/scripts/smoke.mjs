// Every standard smoke uses a temporary profile and log directory. Running a
// test must not open or rewrite the developer's normal sources/preferences.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const modes = { settings: 'CC_SMOKE_SETTINGS', ui: 'CC_SMOKE_UI', relaunch: 'CC_SMOKE_RELAUNCH' }
export function runSmoke({ mode = '', artifactDir = '' } = {}) {
  if (mode && !Object.hasOwn(modes, mode)) throw new Error(`Unknown smoke mode: ${mode}`)
  const electron = createRequire(import.meta.url)('electron')
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-smoke-'))
  const userData = path.join(temp, 'ContextCake')
  fs.mkdirSync(userData, { recursive: true })
  const env = { ...process.env, CC_SMOKE: '1', CC_ENGINE_LOG_DIR: path.join(temp, 'logs') }
  if (mode) env[modes[mode]] = '1'
  if (artifactDir) env.CC_SMOKE_ARTIFACT_DIR = artifactDir
  const child = spawn(electron, [appDir, `--user-data-dir=${userData}`], { stdio: 'inherit', env })
  const timeout = setTimeout(() => child.kill(), 120_000)
  timeout.unref()
  const cleanup = () => {
    clearTimeout(timeout)
    try { fs.rmSync(temp, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  child.on('error', (error) => { cleanup(); console.error(error.message); process.exitCode = 1 })
  child.on('exit', (code) => { cleanup(); process.exitCode = code ?? 1 })
  return child
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runSmoke({ mode: process.argv[2] || '' })
