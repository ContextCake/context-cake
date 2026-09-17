import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readPackageType } from '../src/main/package-type.mjs'
import { installMetricAsset } from '../src/main/install-metrics.mjs'

test('package-type names the Linux package the app was installed from', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-package-type-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.equal(readPackageType(dir), null)
  assert.equal(readPackageType(undefined), null)

  // electron-builder writes the bare target name with no newline.
  fs.writeFileSync(path.join(dir, 'package-type'), 'deb')
  assert.equal(readPackageType(dir), 'deb')
  fs.writeFileSync(path.join(dir, 'package-type'), 'deb\n')
  assert.equal(readPackageType(dir), 'deb')
  // Anything that is not a plain target name is ignored, not trusted.
  fs.writeFileSync(path.join(dir, 'package-type'), '../../etc')
  assert.equal(readPackageType(dir), null)
})

test('a .deb install counts under its own ping asset', () => {
  assert.equal(installMetricAsset({ platform: 'linux', arch: 'x64', packageType: 'deb' }), 'install-ping-linux-x64-deb.txt')
  assert.equal(installMetricAsset({ platform: 'darwin', arch: 'arm64', packageType: null }), 'install-ping-mac-arm64.txt')
})
