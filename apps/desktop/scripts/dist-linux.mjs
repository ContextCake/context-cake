// Builds the Linux .deb (the linux-x64-deb row of scripts/release-platforms.mjs).
//
//   CC_DEB_MAINTAINER="Name <address>" npm run dist:linux -- --publish never
//
// A .deb must name a maintainer, and electron-builder otherwise takes one from
// package.json `author`. The repository names nobody: the release workflow
// passes the DEB_MAINTAINER repository variable in, and this script refuses to
// build without it rather than invent one.
//
// After the build it checks the packaged resources carry the accounts marker
// that `predist:linux` wrote, the same guarantee `npm run dist` has on macOS:
// a shipped build without the marker would read Supabase settings from the
// environment of whoever launches it.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(here, '..')

export function debMaintainer(env = process.env) {
  const value = String(env.CC_DEB_MAINTAINER ?? '').trim()
  if (!value) {
    throw new Error(
      'dist:linux needs CC_DEB_MAINTAINER, the .deb maintainer ("Name <address>"). '
      + 'The release workflow reads it from the DEB_MAINTAINER repository variable. '
      + 'Set it in your shell to build locally.',
    )
  }
  return value
}

export function electronBuilderArgs({ maintainer, extraArgs = [] }) {
  return ['--linux', `--config.deb.maintainer=${maintainer}`, ...extraArgs]
}

// Throws unless the built app's resources hold the same accounts marker as
// build/supabase-config.json, and that marker says accounts are disabled
// (unless the build asked for accounts with CC_ACCOUNTS=1).
export function checkPackagedAccounts({ resourcesDir, buildConfigFile, env = process.env }) {
  const packagedFile = path.join(resourcesDir, 'supabase-config.json')
  if (!fs.existsSync(packagedFile)) {
    throw new Error(`The Linux build has no ${packagedFile}. Run scripts/generate-supabase-config.mjs before electron-builder.`)
  }
  const packaged = fs.readFileSync(packagedFile, 'utf8')
  if (packaged !== fs.readFileSync(buildConfigFile, 'utf8')) {
    throw new Error(`${packagedFile} differs from ${buildConfigFile}; the build packaged a stale accounts marker.`)
  }
  if (env.CC_ACCOUNTS !== '1' && JSON.parse(packaged).accounts !== 'disabled') {
    throw new Error(`${packagedFile} enables accounts, but CC_ACCOUNTS=1 was not set for this build.`)
  }
  return packagedFile
}

function main() {
  const maintainer = debMaintainer()
  const builder = path.join(appDir, 'node_modules', '.bin', 'electron-builder')
  const result = spawnSync(builder, electronBuilderArgs({ maintainer, extraArgs: process.argv.slice(2) }), {
    cwd: appDir,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  const checked = checkPackagedAccounts({
    resourcesDir: path.join(appDir, 'dist', 'linux-unpacked', 'resources'),
    buildConfigFile: path.join(appDir, 'build', 'supabase-config.json'),
  })
  console.log(`dist:linux: ${path.relative(appDir, checked)} matches build/supabase-config.json`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(`dist:linux: ${error?.message ?? error}`)
    process.exit(1)
  }
}
