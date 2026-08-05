import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electron = require('electron')
const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(here, '..')
const repoRoot = path.resolve(appDir, '..', '..')
const artifactDir = path.join(repoRoot, 'docs', 'review-assets', 'mac-first-final')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ui-artifacts-'))
const userData = path.join(temp, 'ContextCake')
fs.mkdirSync(userData, { recursive: true })

const child = spawn(electron, [appDir, `--user-data-dir=${userData}`], {
  stdio: 'inherit',
  env: { ...process.env, CC_SMOKE: '1', CC_SMOKE_UI: '1', CC_SMOKE_ARTIFACT_DIR: artifactDir },
})

child.on('exit', (code) => {
  try { fs.rmSync(temp, { recursive: true, force: true }) } catch { /* best effort */ }
  process.exitCode = code ?? 1
})
