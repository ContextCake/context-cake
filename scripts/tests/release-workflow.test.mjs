import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const appRelease = readFileSync(new URL('../../.github/workflows/app-release.yml', import.meta.url), 'utf8')
const webDemoPreview = readFileSync(new URL('../../.github/workflows/console-preview.yml', import.meta.url), 'utf8')
const rendererConfig = readFileSync(new URL('../../apps/console/vite.config.ts', import.meta.url), 'utf8')
const siteReleaseData = readFileSync(new URL('../../apps/site/src/data/app-release.ts', import.meta.url), 'utf8')
const siteDeploy = readFileSync(new URL('../../.github/workflows/site-deploy.yml', import.meta.url), 'utf8')
const npmPublish = readFileSync(new URL('../../.github/workflows/npm-publish.yml', import.meta.url), 'utf8')
const retiredConsoleDeploy = new URL('../../.github/workflows/console-deploy.yml', import.meta.url)

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
  assert.match(appRelease, /Sync tagged published app release[\s\S]*?sync-app-release\.mjs --tag "\$GITHUB_REF_NAME"/)
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

test('renderer uses the candidate package version while the site uses a published release record', () => {
  assert.match(rendererConfig, /from '\.\.\/desktop\/package\.json'/)
  assert.match(rendererConfig, /JSON\.stringify\(desktopPackage\.version\)/)
  assert.match(siteReleaseData, /from '\.\/app-release\.json'/)
  assert.match(siteReleaseData, /appVersion = release\.version/)
  assert.match(siteReleaseData, /appDownloadUrl = '\/download\/mac'/)
  assert.match(siteDeploy, /Sync published app release[\s\S]*?node scripts\/sync-app-release\.mjs/)
})

test('main-branch Web Demo deploys remain previews, not production releases', () => {
  assert.match(webDemoPreview, /^name: Web Demo Preview Deploy/m)
  assert.match(webDemoPreview, /preview-\$\{safe_branch\}/)
  assert.doesNotMatch(webDemoPreview, /--branch=main/)
})

test('each signed app release produces linked Homebrew, MCPB, and npm artifacts before publishing', () => {
  assert.match(appRelease, /Build verified distribution channel artifacts[\s\S]*?build-distribution-artifacts\.mjs/)
  assert.match(appRelease, /shasum -a 256 \*\.dmg \*\.zip \*\.mcpb \*\.tgz > SHA256SUMS/)
  assert.match(appRelease, /contextcake\.rb contextcake-mcp-server\.json/)
  assert.match(appRelease, /mcpb-install-ping\.txt/)
  assert.match(appRelease, /assertVersionAlignment/)
})

test('npm publication is a separate OIDC-only, provenance-backed gate', () => {
  assert.match(npmPublish, /workflow_dispatch/)
  assert.match(npmPublish, /id-token: write/)
  assert.match(npmPublish, /environment: npm-publish/)
  assert.match(npmPublish, /npm publish --provenance --access public/)
  assert.doesNotMatch(npmPublish, /NODE_AUTH_TOKEN|NPM_TOKEN/)
  assert.match(npmPublish, /npm pack --dry-run/)
})
