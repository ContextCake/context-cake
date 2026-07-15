// Path resolution for the two lives of this app: a dev checkout (engine and
// console live in the monorepo) and a packaged bundle (both are copied into
// Contents/Resources by electron-builder — see electron-builder.yml
// extraResources).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'

const here = path.dirname(fileURLToPath(import.meta.url))

export function enginePaths() {
  if (app.isPackaged) {
    const res = process.resourcesPath
    return {
      serviceModule: path.join(res, 'engine', 'src', 'service.mjs'),
      consoleDist: path.join(res, 'console'),
      cliShim: path.join(res, 'bin', 'contextcake'),
    }
  }
  const repoRoot = path.resolve(here, '..', '..', '..', '..')
  return {
    serviceModule: path.join(repoRoot, 'packages', 'core', 'src', 'service.mjs'),
    consoleDist: path.join(repoRoot, 'apps', 'console', 'dist'),
    cliShim: path.resolve(here, '..', '..', 'resources', 'bin', 'contextcake'),
  }
}

// ~/Library/Application Support/ContextCake — survives updates and reinstalls
// (spec: config preservation). Updates must never write here.
export function configDir() {
  return app.getPath('userData')
}

export function manifestPath() {
  return path.join(configDir(), 'manifest.json')
}

export function settingsPath() {
  return path.join(configDir(), 'settings.json')
}
