#!/usr/bin/env node
// Release asset list for the release workflow, from the platform table plus the
// channel artifacts (scripts/distribution-artifacts.mjs releaseAssetNames).
//
//   node scripts/release-assets.mjs --version X.Y.Z
//       print every asset name, one per line (the gh release create list)
//   node scripts/release-assets.mjs --version X.Y.Z --dist DIR --verify-uploaded FILE
//       FILE is `gh release view TAG --json assets` output; exit non-zero unless
//       the draft carries exactly those names with the local byte sizes
import { readFileSync } from 'node:fs'
import { releaseAssetNames, verifyUploadedAssets } from './distribution-artifacts.mjs'

const USAGE = 'Usage: node scripts/release-assets.mjs --version X.Y.Z [--dist DIR --verify-uploaded FILE]'

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = { '--version': 'version', '--dist': 'dist', '--verify-uploaded': 'uploaded' }[argv[index]]
    if (!key || !argv[index + 1] || options[key] !== undefined) throw new Error(USAGE)
    options[key] = argv[index + 1]
  }
  if (!options.version || Boolean(options.dist) !== Boolean(options.uploaded)) throw new Error(USAGE)
  return options
}

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.uploaded) {
    const { assets } = JSON.parse(readFileSync(options.uploaded, 'utf8'))
    const names = verifyUploadedAssets({ version: options.version, dist: options.dist, uploaded: assets })
    console.error(`release ${options.version}: draft carries all ${names.length} assets`)
  } else {
    process.stdout.write(releaseAssetNames(options.version).map((name) => `${name}\n`).join(''))
  }
} catch (error) {
  console.error(error?.message ?? error)
  process.exitCode = 1
}
