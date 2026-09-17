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

test('a manual dispatch is a dry run that never publishes or deploys', () => {
  assert.match(appRelease, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*dry_run:[\s\S]*?type: boolean[\s\S]*?default: true/)
  assert.match(appRelease, /Refuse a publishing dispatch\s*\n\s*if: github\.event_name == 'workflow_dispatch' && inputs\.dry_run != true/)
  // The tag checks and the Cloudflare preflight belong to a real release only.
  assert.match(appRelease, /Require public-surface deployment credentials\s*\n\s*if: github\.event_name == 'push'/)
  assert.match(appRelease, /Verify tag is on main and matches package version\s*\n\s*if: github\.event_name == 'push'/)
  // A release comes only from a signed tag push, and deploys follow only a created release.
  assert.match(appRelease, /- name: Publish GitHub Release\s*\n\s*id: release\s*\n\s*if: needs\.build-mac\.outputs\.signed == 'true' && github\.event_name == 'push'/)
  assert.match(appRelease, /echo "released=true" >> "\$GITHUB_OUTPUT"/)
  assert.match(appRelease, /public-surfaces:[\s\S]*?needs:\s*\n\s*- publish\s*\n\s*if: needs\.publish\.outputs\.released == 'true'/)
  assert.equal((appRelease.match(/gh release create/g) ?? []).length, 1)
  // Unsigned builds and dry runs keep their artifacts for inspection instead.
  assert.match(appRelease, /Upload inspection artifacts \(unsigned build or dry run\)\s*\n\s*if: needs\.build-mac\.outputs\.signed != 'true' \|\| github\.event_name != 'push'/)
  assert.match(appRelease, /Build \(unsigned — no release\)\s*\n\s*if: steps\.creds\.outputs\.signed != 'true'/)
})

test('the release splits into build-mac, an Intel smoke, and one publish job', () => {
  assert.match(appRelease, /build-mac:[\s\S]*?runs-on: macos-14[\s\S]*?needs:\s*\n\s*- release-preflight/)
  assert.match(appRelease, /smoke-mac-x64:[\s\S]*?runs-on: macos-15-intel[\s\S]*?needs:\s*\n\s*- build-mac/)
  assert.match(appRelease, /smoke-mac-x64:[\s\S]*?--id mac-x64[\s\S]*?CC_SMOKE=1 "\$BIN" \| tee smoke\.log\s*\n\s*grep -q "SMOKE OK" smoke\.log/)
  assert.match(appRelease, /publish:[\s\S]*?runs-on: ubuntu-latest[\s\S]*?needs:\s*\n\s*- build-mac\s*\n\s*- smoke-mac-x64/)
  assert.match(appRelease, /check dist\/mac-arm64 arm64\s*\n\s*check dist\/mac x86_64/)
  assert.match(appRelease, /for DIR in dist\/mac-arm64 dist\/mac; do[\s\S]*?spctl -a -vv -t install "\$APP"[\s\S]*?xcrun stapler validate "\$APP"/)
  assert.match(appRelease, /npm run dist -- --publish never --config\.mac\.notarize=true/)
})

test('every artifact name in the release workflow comes from the platform table', () => {
  // No step spells an installer, an update file, or a per-platform ping by hand.
  assert.doesNotMatch(appRelease, /arm64\.dmg|x64\.dmg|-mac\.zip|\*\.dmg|\*\.zip|install-ping-mac/)
  assert.match(appRelease, /release-platforms\.mjs --check apps\/desktop\/dist --version "\$VERSION" --stage build --os mac/)
  assert.match(appRelease, /release-platforms\.mjs --check release-dist --version "\$VERSION" --stage build\n/)
  assert.match(appRelease, /release-platforms\.mjs --check release-dist --version "\$VERSION" --stage publish/)
  assert.match(appRelease, /for KIND in installers updaters feeds pings; do/)
  assert.match(appRelease, /--list pings --version "\$VERSION"\); do\s*\n\s*cp apps\/desktop\/release-assets\/install-ping\.txt "release-dist\/\$NAME"/)
  // Inside publish: check rows, build channel artifacts, checksum, check again, release.
  assert.match(appRelease, /--stage build\n[\s\S]*?build-distribution-artifacts\.mjs[\s\S]*?sha256sum \$NAMES > SHA256SUMS[\s\S]*?--stage publish[\s\S]*?gh release create/)
})

test('a signed app release deploys matching public surfaces', () => {
  assert.match(appRelease, /release-preflight:[\s\S]*?permissions: \{\}[\s\S]*?Require public-surface deployment credentials/)
  assert.match(appRelease, /api\.cloudflare\.com\/client\/v4\/accounts\/\$CLOUDFLARE_ACCOUNT_ID\/pages\/projects\/\$project/)
  assert.match(appRelease, /- name: Build Web Demo[\s\S]*?run: npm run build/)
  assert.match(appRelease, /name: web-demo-dist[\s\S]*?path: apps\/console\/dist/)
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
  assert.match(siteReleaseData, /release\.platforms\.filter\(\(row\) => row\.available\)/)
  assert.match(siteDeploy, /Sync published app release[\s\S]*?node scripts\/sync-app-release\.mjs/)
})

test('main-branch Web Demo deploys remain previews, not production releases', () => {
  assert.match(webDemoPreview, /^name: Web Demo Preview Deploy/m)
  assert.match(webDemoPreview, /preview-\$\{safe_branch\}/)
  assert.doesNotMatch(webDemoPreview, /--branch=main/)
})

test('each signed app release produces linked Homebrew, MCPB, and npm artifacts before publishing', () => {
  assert.match(appRelease, /Build verified distribution channel artifacts[\s\S]*?build-distribution-artifacts\.mjs/)
  assert.match(appRelease, /--list checksummed --version "\$VERSION"\) ContextCake-\$VERSION\.mcpb contextcake-\$VERSION\.tgz"/)
  assert.match(appRelease, /contextcake\.rb contextcake-mcp-server\.json SHA256SUMS mcpb-install-ping\.txt/)
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
