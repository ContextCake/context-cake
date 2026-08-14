#!/usr/bin/env node
import { writeReleaseChannelArtifacts } from './distribution-artifacts.mjs'

function parseArgs(argv) {
  let version
  let distDir
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[++index]
    if (!value || !['--version', '--dist'].includes(flag)) {
      throw new Error('Usage: node scripts/build-distribution-artifacts.mjs --version X.Y.Z --dist PATH')
    }
    if (flag === '--version' && !version) version = value
    else if (flag === '--dist' && !distDir) distDir = value
    else throw new Error('Each release artifact option may be supplied once.')
  }
  if (!version || !distDir) throw new Error('Usage: node scripts/build-distribution-artifacts.mjs --version X.Y.Z --dist PATH')
  return { version, distDir }
}

const { version, distDir } = parseArgs(process.argv.slice(2))
const artifacts = await writeReleaseChannelArtifacts({ version, distDir })
process.stdout.write(`${JSON.stringify(artifacts, null, 2)}\n`)
