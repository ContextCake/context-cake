#!/usr/bin/env node
// Checks the npm tarball a signed release carries before the npm workflow
// publishes it. Publishing that exact file, rather than rebuilding the package
// on the publish runner, is what makes the registry copy byte-identical to the
// artifact in SHA256SUMS (control-plane spec §5.14).
//
//   node scripts/verify-npm-tarball.mjs --tarball <tgz> --sums <SHA256SUMS> --version X.Y.Z
//
// Prints the tarball's registry-style integrity string on success, so the
// workflow can tell an identical re-run from a conflicting one.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)

// npm runs these on install. The package ships none (distribution spec §8
// hardening amendment); a tarball that grew one is refused, not published.
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']

export function integrityOf(buffer) {
  return `sha512-${createHash('sha512').update(buffer).digest('base64')}`
}

export async function verifyReleaseTarball({ tarball, sums, version }) {
  const name = path.basename(tarball)
  const bytes = await readFile(tarball)
  const line = (await readFile(sums, 'utf8')).split(/\r?\n/).find((entry) => entry.endsWith(`  ${name}`))
  if (!line) throw new Error(`${name} has no SHA256SUMS line`)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (line.slice(0, 64) !== actual) throw new Error(`${name} does not match SHA256SUMS`)

  const { stdout: listing } = await run('tar', ['-tzf', tarball])
  const entries = listing.split('\n').filter(Boolean)
  const outside = entries.filter((entry) => !entry.startsWith('package/') || entry.split('/').includes('..'))
  if (outside.length) throw new Error(`${name} has entries outside package/: ${outside.slice(0, 3).join(', ')}`)
  if (entries.some((entry) => entry.split('/').includes('node_modules'))) throw new Error(`${name} contains node_modules`)

  const { stdout: manifest } = await run('tar', ['-xzOf', tarball, 'package/package.json'], { maxBuffer: 1024 * 1024 })
  const pkg = JSON.parse(manifest)
  if (pkg.name !== 'contextcake') throw new Error(`${name} is package ${pkg.name}, expected contextcake`)
  if (pkg.version !== version) throw new Error(`${name} is version ${pkg.version}, expected ${version}`)
  const lifecycle = LIFECYCLE_SCRIPTS.filter((script) => pkg.scripts?.[script] !== undefined)
  if (lifecycle.length) throw new Error(`${name} declares lifecycle script ${lifecycle.join(', ')}`)

  return { name: pkg.name, version: pkg.version, integrity: integrityOf(bytes) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (flag) => {
    const index = process.argv.indexOf(flag)
    if (index === -1 || !process.argv[index + 1]) throw new Error(`missing ${flag}`)
    return process.argv[index + 1]
  }
  try {
    const result = await verifyReleaseTarball({ tarball: arg('--tarball'), sums: arg('--sums'), version: arg('--version') })
    process.stdout.write(`${result.integrity}\n`)
  } catch (error) {
    console.error(`verify-npm-tarball: ${error.message}`)
    process.exit(1)
  }
}
