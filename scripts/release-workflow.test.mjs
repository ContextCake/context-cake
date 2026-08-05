import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const appRelease = readFileSync(new URL('../.github/workflows/app-release.yml', import.meta.url), 'utf8')
const webDemoPreview = readFileSync(new URL('../.github/workflows/console-preview.yml', import.meta.url), 'utf8')
const rendererConfig = readFileSync(new URL('../apps/console/vite.config.ts', import.meta.url), 'utf8')
const siteReleaseData = readFileSync(new URL('../apps/site/src/data/app-release.ts', import.meta.url), 'utf8')
const retiredConsoleDeploy = new URL('../.github/workflows/console-deploy.yml', import.meta.url)

test('app-v is the only production release trigger', () => {
  assert.match(appRelease, /tags:\s*\n\s*- ["']app-v\*["']/)
  assert.doesNotMatch(appRelease, /console-v\*/)
  assert.equal(existsSync(retiredConsoleDeploy), false)
})

test('a signed app release deploys matching public surfaces', () => {
  assert.match(appRelease, /release-preflight:[\s\S]*?permissions: \{\}[\s\S]*?Require public-surface deployment credentials/)
  assert.match(appRelease, /api\.cloudflare\.com\/client\/v4\/accounts\/\$CLOUDFLARE_ACCOUNT_ID\/pages\/projects\/\$project/)
  assert.match(appRelease, /release:[\s\S]*?needs:\s*\n\s*- release-preflight/)
  assert.match(appRelease, /- name: Build Web Demo[\s\S]*?run: npm run build/)
  assert.match(appRelease, /name: web-demo-dist[\s\S]*?path: apps\/console\/dist/)
  assert.match(appRelease, /public-surfaces:[\s\S]*?needs:\s*\n\s*- release/)
  assert.match(appRelease, /if: needs\.release\.outputs\.signed == 'true'/)
  assert.match(appRelease, /retention-days: 7/)
  assert.match(appRelease, /- name: Build release site[\s\S]*?run: npm run build/)
  assert.match(appRelease, /- name: Build release site[\s\S]*?- name: Download Web Demo artifact[\s\S]*?- name: Deploy Web Demo production/)
  assert.match(appRelease, /pages deploy dist --project-name=\$\{\{ env\.WEB_DEMO_PROJECT_NAME \}\} --branch=main --commit-hash=\$\{\{ github\.sha \}\}/)
  assert.match(appRelease, /pages deploy dist --project-name=\$\{\{ env\.SITE_PROJECT_NAME \}\} --branch=main --commit-hash=\$\{\{ github\.sha \}\}/)
  assert.match(appRelease, /Verify deployed release provenance[\s\S]*?node scripts\/verify-release-surfaces\.mjs/)
})

test('the deployed Web Demo records the app tag and exact commit', () => {
  assert.match(appRelease, /dist\/release\.json/)
  assert.match(appRelease, /RELEASE_TAG: \$\{\{ github\.ref_name \}\}/)
  assert.match(appRelease, /RELEASE_COMMIT: \$\{\{ github\.sha \}\}/)
})

test('renderer and site derive the product version from the desktop package', () => {
  assert.match(rendererConfig, /from '\.\.\/desktop\/package\.json'/)
  assert.match(rendererConfig, /JSON\.stringify\(desktopPackage\.version\)/)
  assert.match(siteReleaseData, /from '\.\.\/\.\.\/\.\.\/desktop\/package\.json'/)
  assert.match(siteReleaseData, /appVersion = desktopPackage\.version/)
})

test('main-branch Web Demo deploys remain previews, not production releases', () => {
  assert.match(webDemoPreview, /^name: Web Demo Preview Deploy/m)
  assert.match(webDemoPreview, /preview-\$\{safe_branch\}/)
  assert.doesNotMatch(webDemoPreview, /--branch=main/)
})
