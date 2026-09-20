// The npm workflow publishes the tarball the signed release already carries,
// so these checks are the last thing between that file and the registry.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildNpmPackage, npmTarballName, sha256 } from '../distribution-artifacts.mjs'
import { integrityOf, verifyReleaseTarball } from '../verify-npm-tarball.mjs'

const version = '9.8.7'

async function packedRelease(mutate) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'contextcake-verify-tgz-'))
  const staging = path.join(dir, 'staging')
  await buildNpmPackage({ version, outDir: staging })
  if (mutate) await mutate(staging)
  execFileSync('npm', ['pack', '--pack-destination', dir], {
    cwd: staging,
    stdio: 'ignore',
    env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_cache: path.join(dir, '.npm-cache') },
  })
  const tarball = path.join(dir, npmTarballName(version))
  const sums = path.join(dir, 'SHA256SUMS')
  await writeFile(sums, `${'0'.repeat(64)}  ContextCake-${version}-arm64.dmg\n${sha256(await readFile(tarball))}  ${npmTarballName(version)}\n`)
  return { dir, tarball, sums }
}

test('a release tarball that matches SHA256SUMS and the package rules verifies', async () => {
  const { dir, tarball, sums } = await packedRelease()
  try {
    const result = await verifyReleaseTarball({ tarball, sums, version })
    assert.equal(result.name, 'contextcake')
    assert.equal(result.version, version)
    assert.match(result.integrity, /^sha512-[A-Za-z0-9+/]+=*$/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a tarball whose bytes differ from its SHA256SUMS line is refused', async () => {
  const { dir, tarball, sums } = await packedRelease()
  try {
    await writeFile(sums, `${'a'.repeat(64)}  ${npmTarballName(version)}\n`)
    await assert.rejects(verifyReleaseTarball({ tarball, sums, version }), /does not match SHA256SUMS/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a tarball missing from SHA256SUMS is refused', async () => {
  const { dir, tarball, sums } = await packedRelease()
  try {
    await writeFile(sums, `${'a'.repeat(64)}  something-else.tgz\n`)
    await assert.rejects(verifyReleaseTarball({ tarball, sums, version }), /has no SHA256SUMS line/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a package with a lifecycle script is refused even when its checksum matches', async () => {
  const { dir, tarball, sums } = await packedRelease(async (staging) => {
    const file = path.join(staging, 'package.json')
    const pkg = JSON.parse(await readFile(file, 'utf8'))
    pkg.scripts = { postinstall: 'node -e 1' }
    await writeFile(file, JSON.stringify(pkg))
  })
  try {
    await assert.rejects(verifyReleaseTarball({ tarball, sums, version }), /lifecycle script/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a package that declares dependencies is refused', async () => {
  // A dependency runs its own install hooks on the consumer's machine, which is
  // the outcome the lifecycle-script check exists to prevent, one indirection
  // away. The engine is dependency-free, so this can be absolute.
  const { dir, tarball, sums } = await packedRelease(async (staging) => {
    const file = path.join(staging, 'package.json')
    const pkg = JSON.parse(await readFile(file, 'utf8'))
    pkg.dependencies = { 'left-pad': '1.3.0' }
    await writeFile(file, JSON.stringify(pkg))
  })
  try {
    await assert.rejects(verifyReleaseTarball({ tarball, sums, version }), /declares dependencies/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a tarball carrying a symlink is refused', async () => {
  // Built with tar rather than `npm pack`, which does not preserve symlinks —
  // which is the point: the verifier's job is to judge the bytes attached to a
  // release, not to assume they came out of npm. `tar -tzf` lists names only,
  // so a symlink reads as an ordinary file there; the verbose listing's type
  // flag is what catches one pointing out of the extracted tree.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'contextcake-verify-link-'))
  try {
    const staging = path.join(dir, 'package')
    await mkdir(path.join(staging, 'bin'), { recursive: true })
    await writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: 'contextcake', version }))
    await symlink('/etc/passwd', path.join(staging, 'bin', 'leak.mjs'))
    const tarball = path.join(dir, npmTarballName(version))
    execFileSync('tar', ['-czf', tarball, '-C', dir, 'package'])
    const sums = path.join(dir, 'SHA256SUMS')
    await writeFile(sums, `${sha256(await readFile(tarball))}  ${npmTarballName(version)}\n`)
    await assert.rejects(verifyReleaseTarball({ tarball, sums, version }), /link entries/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a tarball with an undeclared top-level entry is refused', async () => {
  const { dir, tarball, sums } = await packedRelease(async (staging) => {
    const file = path.join(staging, 'package.json')
    const pkg = JSON.parse(await readFile(file, 'utf8'))
    pkg.files = [...pkg.files, 'secrets']
    await writeFile(file, JSON.stringify(pkg))
    await mkdir(path.join(staging, 'secrets'), { recursive: true })
    await writeFile(path.join(staging, 'secrets', 'note.txt'), 'x')
  })
  try {
    await assert.rejects(verifyReleaseTarball({ tarball, sums, version }), /unexpected top-level entries: secrets/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a version other than the release tag is refused', async () => {
  const { dir, tarball, sums } = await packedRelease()
  try {
    await assert.rejects(verifyReleaseTarball({ tarball, sums, version: '9.8.8' }), /version 9\.8\.7, expected 9\.8\.8/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('integrityOf matches the registry dist.integrity format', () => {
  assert.equal(integrityOf(Buffer.from('abc')), 'sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==')
})
