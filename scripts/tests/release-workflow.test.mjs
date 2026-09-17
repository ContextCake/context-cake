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

// Reads the parts of a GitHub Actions workflow these tests reason about: each
// job's needs, if, environment, env, and steps (name, if, env, and the raw text
// of the step). It relies on the two-space indentation the workflows use and
// fails loudly on a job it cannot place, so a reformat breaks the test rather
// than silently passing it.
function parseWorkflowJobs(text) {
  const lines = text.split('\n')
  const start = lines.indexOf('jobs:')
  assert.notEqual(start, -1, 'workflow has a jobs: block')
  const jobs = {}
  let job = null
  let step = null
  let block = null
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    let match
    if ((match = /^ {2}([\w-]+):$/.exec(line))) {
      job = jobs[match[1]] = { needs: [], env: {}, steps: [], text: '' }
      step = null
      block = null
      continue
    }
    assert.ok(job || !line.trim(), `line outside a job: ${line}`)
    if (!job) continue
    job.text += `${line}\n`
    if ((match = /^ {4}([\w-]+):(?: (.*))?$/.exec(line))) {
      block = match[1]
      step = null
      if (match[2] !== undefined) job[block] = match[2]
      continue
    }
    if (block === 'needs' && (match = /^ {6}- ([\w-]+)$/.exec(line))) job.needs.push(match[1])
    else if (block === 'env' && (match = /^ {6}([\w-]+): (.*)$/.exec(line))) job.env[match[1]] = match[2]
    else if (block === 'steps') {
      if ((match = /^ {6}- name: (.*)$/.exec(line))) {
        step = { name: match[1], env: {}, text: `${line}\n` }
        job.steps.push(step)
      } else if (step) {
        step.text += `${line}\n`
        if ((match = /^ {8}if: (.*)$/.exec(line))) step.if = match[1]
        else if ((match = /^ {10}([\w-]+): (.*)$/.exec(line)) && /\n {8}env:\n(?: {10}.*\n)*$/.test(step.text)) step.env[match[1]] = match[2]
      }
    }
  }
  return jobs
}

const jobs = parseWorkflowJobs(appRelease)
const stepNamed = (jobName, name) => {
  const found = jobs[jobName].steps.find((step) => step.name === name)
  assert.ok(found, `${jobName} has a step named "${name}"`)
  return found
}
const SIGNING_ALLOWED = "(github.event_name == 'push' && startsWith(github.ref, 'refs/tags/app-v')) || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')"

// The signing expression, evaluated for the two events this workflow accepts.
function signingAllowed({ event, ref }) {
  return (event === 'push' && ref.startsWith('refs/tags/app-v')) || (event === 'workflow_dispatch' && ref === 'refs/heads/main')
}

test('app-v is the only production release trigger', () => {
  assert.match(appRelease, /tags:\s*\n\s*- ["']app-v\*["']/)
  assert.doesNotMatch(appRelease, /console-v\*/)
  assert.equal(existsSync(retiredConsoleDeploy), false)
})

test('the job graph runs the builds and Intel smoke, publish, then deploy', () => {
  assert.deepEqual(Object.keys(jobs), ['release-preflight', 'build-mac', 'smoke-mac-x64', 'build-linux', 'publish', 'remove-dry-run-binaries', 'remove-dry-run-deb', 'public-surfaces'])
  assert.deepEqual(jobs['build-mac'].needs, ['release-preflight'])
  assert.deepEqual(jobs['smoke-mac-x64'].needs, ['build-mac'])
  assert.deepEqual(jobs['build-linux'].needs, ['release-preflight'])
  assert.deepEqual(jobs.publish.needs, ['build-mac', 'smoke-mac-x64', 'build-linux'])
  assert.equal(jobs['build-linux']['runs-on'], 'ubuntu-24.04')
  assert.deepEqual(jobs['public-surfaces'].needs, ['publish'])
  assert.equal(jobs['public-surfaces'].if, "needs.publish.outputs.released == 'true'")
  assert.equal(jobs['build-mac']['runs-on'], 'macos-14')
  assert.equal(jobs['smoke-mac-x64']['runs-on'], 'macos-15-intel')
  assert.equal(jobs.publish['runs-on'], 'ubuntu-latest')
})

test('only an app-v tag push or a dispatch from main can sign, and only those runs enter the release environment', () => {
  const build = jobs['build-mac']
  assert.equal(build.env.SIGNING_ALLOWED, `\${{ ${SIGNING_ALLOWED} }}`)
  assert.equal(build.environment, `\${{ (${SIGNING_ALLOWED}) && 'release' || '' }}`)
  assert.equal(signingAllowed({ event: 'push', ref: 'refs/tags/app-v1.2.3' }), true)
  assert.equal(signingAllowed({ event: 'workflow_dispatch', ref: 'refs/heads/main' }), true)
  assert.equal(signingAllowed({ event: 'workflow_dispatch', ref: 'refs/heads/c/feature' }), false)
  assert.equal(signingAllowed({ event: 'workflow_dispatch', ref: 'refs/tags/app-v1.2.3' }), false)

  // Every step that can see a signing secret is gated on the signing decision,
  // and no other job reads one.
  const gates = ["env.SIGNING_ALLOWED == 'true'", "steps.creds.outputs.signed == 'true'"]
  let secretSteps = 0
  for (const [name, job] of Object.entries(jobs)) {
    for (const step of job.steps) {
      if (!/secrets\.(CSC_|APPLE_)/.test(step.text)) continue
      secretSteps += 1
      assert.equal(name, 'build-mac', `${step.name} reads signing secrets outside build-mac`)
      assert.ok(gates.includes(step.if), `${step.name} must be gated on signing (if: ${step.if})`)
    }
    if (name !== 'build-mac') assert.doesNotMatch(job.text, /secrets\.(CSC_|APPLE_)/)
  }
  assert.equal(secretSteps, 3)
  assert.equal(stepNamed('build-mac', 'Detect signing secrets').if, "env.SIGNING_ALLOWED == 'true'")

  const unsigned = stepNamed('build-mac', 'Build (unsigned — no release)')
  assert.equal(unsigned.if, "steps.creds.outputs.signed != 'true'")
  assert.equal(unsigned.env.CSC_IDENTITY_AUTO_DISCOVERY, '"false"')
})

test('a manual dispatch is a dry run that never publishes, deploys, or keeps a signed binary', () => {
  assert.match(appRelease, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*dry_run:[\s\S]*?type: boolean[\s\S]*?default: true/)
  assert.equal(stepNamed('release-preflight', 'Refuse a publishing dispatch').if, "github.event_name == 'workflow_dispatch' && inputs.dry_run != true")
  assert.equal(stepNamed('release-preflight', 'Require public-surface deployment credentials').if, "github.event_name == 'push'")
  assert.equal(stepNamed('build-mac', 'Verify tag is on main and matches package version').if, "github.event_name == 'push'")
  assert.equal(stepNamed('publish', 'Publish GitHub Release').if, "needs.build-mac.outputs.signed == 'true' && github.event_name == 'push'")
  assert.equal((appRelease.match(/gh release create/g) ?? []).length, 1)

  // The Mac artifact lives a day and a signed dry run deletes it.
  assert.match(stepNamed('build-mac', 'Upload Mac artifacts').text, /name: desktop-mac[\s\S]*retention-days: 1\n/)
  const cleanup = jobs['remove-dry-run-binaries']
  assert.deepEqual(cleanup.needs, ['build-mac', 'smoke-mac-x64', 'publish'])
  assert.equal(cleanup.if, "always() && needs.build-mac.outputs.signed == 'true' && github.event_name != 'push'")
  assert.match(cleanup.text, /select\(\.name == "desktop-mac"\)[\s\S]*gh api --method DELETE/)

  // Unsigned builds keep everything for inspection; a signed dry run keeps checksums and feeds only.
  assert.equal(stepNamed('publish', 'Upload inspection artifacts (unsigned build)').if, "needs.build-mac.outputs.signed != 'true'")
  const dryRun = stepNamed('publish', 'Upload dry-run checksums and feeds (signed dry run)')
  assert.equal(dryRun.if, "needs.build-mac.outputs.signed == 'true' && github.event_name != 'push'")
  assert.match(dryRun.text, /retention-days: 1\n/)
  assert.doesNotMatch(dryRun.text, /release-dist\n|\.dmg|\.zip|\.mcpb|\.tgz|release-dist\/\*\n/)
})

test('build digests are recorded after Gatekeeper and checked before anything is published', () => {
  const build = jobs['build-mac'].steps.map((step) => step.name)
  assert.ok(build.indexOf('Gatekeeper assessment') < build.indexOf('Record build digests'))
  assert.ok(build.indexOf('Record build digests') < build.indexOf('Upload Mac artifacts'))
  assert.match(jobs['build-mac'].text, /checksums: \$\{\{ steps\.digests\.outputs\.checksums \}\}/)
  assert.match(stepNamed('build-mac', 'Record build digests').text, /--list checksummed --version "\$VERSION" --os mac[\s\S]*shasum -a 256 \$NAMES/)

  assert.match(stepNamed('smoke-mac-x64', 'Verify the Intel files match the build digests').text, /--id mac-x64 --digests/)
  const smoke = jobs['smoke-mac-x64'].steps.map((step) => step.name)
  assert.ok(smoke.indexOf('Verify the Intel files match the build digests') < smoke.indexOf('Launch the Intel build'))
  const gatekeeper = stepNamed('smoke-mac-x64', 'Gatekeeper assessment of the Intel update zip')
  assert.equal(gatekeeper.if, "needs.build-mac.outputs.signed == 'true'")
  assert.match(gatekeeper.text, /codesign --verify --deep --strict smoke-app\/ContextCake\.app[\s\S]*spctl -a -vv -t install smoke-app\/ContextCake\.app/)
  assert.ok(smoke.indexOf('Unpack the Intel update zip') < smoke.indexOf('Gatekeeper assessment of the Intel update zip'))
  assert.match(stepNamed('smoke-mac-x64', 'Launch the Intel build').text, /CC_SMOKE=1 "\$BIN" \| tee smoke\.log\s*\n\s*grep -q "SMOKE OK" smoke\.log/)

  const publish = jobs.publish.steps.map((step) => step.name)
  const order = [
    'Verify every platform row was built and is unchanged',
    'Build verified distribution channel artifacts',
    'Checksums',
    'Verify the release is complete',
    'Publish GitHub Release',
  ]
  assert.deepEqual(order.map((name) => publish.indexOf(name)), [...order.map((name) => publish.indexOf(name))].sort((a, b) => a - b))
  assert.ok(order.every((name) => publish.includes(name)))
  assert.match(stepNamed('publish', 'Verify every platform row was built and is unchanged').text, /--stage build --digests "\$RUNNER_TEMP\/build\.sha256"/)
  assert.match(stepNamed('publish', 'Verify the release is complete').text, /--stage publish --digests "\$RUNNER_TEMP\/build\.sha256"/)
})

test('build-linux builds, hashes, installs, and smokes the .deb with the sandbox on', () => {
  const linux = jobs['build-linux']
  // The .deb is never signed, so the job gets no signing environment.
  assert.equal(linux.environment, undefined)
  assert.equal(linux.env.CC_DEB_MAINTAINER, '${{ vars.DEB_MAINTAINER }}')
  const maintainer = stepNamed('build-linux', 'Require the .deb maintainer')
  // Every run stops without a maintainer, dry runs included.
  assert.equal(maintainer.if, undefined)
  assert.match(maintainer.text, /if \[ -z "\$CC_DEB_MAINTAINER" \]; then[\s\S]*exit 1/)

  const order = [
    'Require the .deb maintainer',
    'Build the .deb',
    'Verify the Linux platform row was built',
    'Record build digests',
    'Install the .deb',
    'Launch the installed app with the sandbox on',
    'Upload Linux artifacts',
  ]
  const names = linux.steps.map((step) => step.name)
  assert.ok(order.every((name) => names.includes(name)), names.join(', '))
  assert.deepEqual(order.map((name) => names.indexOf(name)), [...order.map((name) => names.indexOf(name))].sort((a, b) => a - b))

  assert.match(stepNamed('build-linux', 'Build the .deb').text, /npm run dist:linux -- --publish never/)
  assert.match(stepNamed('build-linux', 'Verify the Linux platform row was built').text, /--stage build --os linux/)
  assert.match(linux.text, /checksums: \$\{\{ steps\.digests\.outputs\.checksums \}\}/)
  assert.match(stepNamed('build-linux', 'Record build digests').text, /--list checksummed --version "\$VERSION" --os linux[\s\S]*sha256sum \$NAMES/)
  assert.match(stepNamed('build-linux', 'Install the .deb').text, /apt-get install -y --no-install-recommends "\.\/apps\/desktop\/dist\/\$DEB"/)

  // The sandbox stays on: no switch, no env override, and the smoke must say so.
  const launch = stepNamed('build-linux', 'Launch the installed app with the sandbox on').text
  assert.match(launch, /env -u ELECTRON_DISABLE_SANDBOX CC_SMOKE=1 xvfb-run -a \/opt\/ContextCake\/contextcake-desktop/)
  assert.match(launch, /grep -q "SMOKE OK" smoke\.log\s*\n\s*grep -q "sandbox=on" smoke\.log/)
  assert.doesNotMatch(appRelease, /--no-sandbox/)

  // A day of retention, deleted after any dry run, and never in the inspection upload.
  assert.match(stepNamed('build-linux', 'Upload Linux artifacts').text, /name: desktop-linux[\s\S]*retention-days: 1\n/)
  const cleanup = jobs['remove-dry-run-deb']
  assert.deepEqual(cleanup.needs, ['build-linux', 'publish'])
  // Every outcome, pushes included: an unsigned or failed tag push must not
  // keep an installable .deb either.
  assert.equal(cleanup.if, 'always()')
  assert.match(cleanup.text, /select\(\.name == "desktop-linux"\)[\s\S]*gh api --method DELETE/)
  assert.match(stepNamed('publish', 'Upload inspection artifacts (unsigned build)').text, /!release-dist\/\*\.deb/)

  // publish takes the .deb into the release directory and checks it against
  // build-linux's digests alongside build-mac's.
  const publish = jobs.publish.steps.map((step) => step.name)
  assert.ok(publish.indexOf('Download Linux artifacts') < publish.indexOf('Verify every platform row was built and is unchanged'))
  assert.match(stepNamed('publish', 'Download Linux artifacts').text, /name: desktop-linux\s*\n\s*path: release-dist/)
  assert.equal(jobs.publish.env.LINUX_BUILD_DIGESTS, '${{ needs.build-linux.outputs.checksums }}')
  assert.match(stepNamed('publish', 'Verify every platform row was built and is unchanged').text, /printf '%s\\n' "\$BUILD_DIGESTS" "\$LINUX_BUILD_DIGESTS" > "\$RUNNER_TEMP\/build\.sha256"/)
})

test('the release is uploaded as a draft, checked against the table, then made public', () => {
  const run = stepNamed('publish', 'Publish GitHub Release').text
  const positions = [
    'node scripts/release-assets.mjs --version "$VERSION")',
    'gh release create "$GITHUB_REF_NAME"',
    '--draft',
    'gh release view "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" --json assets',
    'node scripts/release-assets.mjs --version "$VERSION" --dist release-dist --verify-uploaded',
    'gh release edit "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" --draft=false',
    'echo "released=true" >> "$GITHUB_OUTPUT"',
  ].map((needle) => {
    const index = run.indexOf(needle)
    assert.notEqual(index, -1, needle)
    return index
  })
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
  assert.match(run, /"\$\{ASSETS\[@\]\}"/)
})

test('the release splits into build-mac, an Intel smoke, and one publish job', () => {
  assert.match(appRelease, /check dist\/mac-arm64 arm64\s*\n\s*check dist\/mac x86_64/)
  assert.match(appRelease, /for DIR in dist\/mac-arm64 dist\/mac; do[\s\S]*?spctl -a -vv -t install "\$APP"[\s\S]*?xcrun stapler validate "\$APP"/)
  assert.match(appRelease, /npm run dist -- --publish never --config\.mac\.notarize=true/)
})

test('every artifact name in the release workflow comes from the platform table', () => {
  // No step spells an installer, an update file, or a per-platform ping by hand.
  assert.doesNotMatch(appRelease, /arm64\.dmg|x64\.dmg|-mac\.zip|\*\.dmg|\*\.zip|install-ping-mac|amd64\.deb|latest-linux|install-ping-linux/)
  assert.match(appRelease, /release-platforms\.mjs --check apps\/desktop\/dist --version "\$VERSION" --stage build --os mac/)
  assert.match(appRelease, /--list pings --version "\$VERSION"\); do\s*\n\s*cp apps\/desktop\/release-assets\/install-ping\.txt "release-dist\/\$NAME"/)
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

test('the site offers the npm CLI only once npm has the release, and redeploys when it does', () => {
  // Both production site builds sync the npm record after the app record.
  assert.match(appRelease, /sync-app-release\.mjs --tag "\$GITHUB_REF_NAME"[\s\S]*?- name: Sync published npm release\n\s*working-directory: apps\/site\n\s*run: node scripts\/sync-npm-release\.mjs[\s\S]*?- name: Build release site/)
  const siteJobs = parseWorkflowJobs(siteDeploy)
  const names = siteJobs.validate.steps.map((step) => step.name)
  assert.ok(names.indexOf('Sync published app release') < names.indexOf('Sync published npm release'))
  assert.ok(names.indexOf('Sync published npm release') < names.indexOf('Build'))
  // The npm sync needs no token: the registry read is public.
  assert.doesNotMatch(siteJobs.validate.steps.find((step) => step.name === 'Sync published npm release').text, /TOKEN/)

  // A successful npm publish redeploys the site; a failed one does not.
  assert.match(npmPublish, /^name: Publish ContextCake npm package$/m)
  assert.match(siteDeploy, /workflow_run:\n\s*workflows:\n\s*- Publish ContextCake npm package\n\s*types:\n\s*- completed/)
  assert.equal(siteJobs.validate.if, "github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'")
  assert.deepEqual(siteJobs.deploy.needs, ['validate'])
  // Permissions stay what a deploy already needed.
  assert.match(siteDeploy, /\npermissions:\n  contents: read\n  deployments: write\n\n/)
})

test('main-branch Web Demo deploys remain previews, not production releases', () => {
  assert.match(webDemoPreview, /^name: Web Demo Preview Deploy/m)
  assert.match(webDemoPreview, /preview-\$\{safe_branch\}/)
  assert.doesNotMatch(webDemoPreview, /--branch=main/)
})

test('each signed app release produces linked Homebrew, MCPB, and npm artifacts before publishing', () => {
  assert.match(appRelease, /Build verified distribution channel artifacts[\s\S]*?build-distribution-artifacts\.mjs/)
  assert.match(appRelease, /--list checksummed --version "\$VERSION"\) ContextCake-\$VERSION\.mcpb contextcake-\$VERSION\.tgz"/)
  assert.match(appRelease, /assertVersionAlignment/)
})

test('the site redeploys when the platform table changes', () => {
  assert.match(siteDeploy, /paths:[\s\S]*- 'scripts\/release-platforms\.mjs'/)
})

test('npm publication is a separate OIDC-only, provenance-backed gate', () => {
  assert.match(npmPublish, /workflow_dispatch/)
  assert.match(npmPublish, /id-token: write/)
  assert.match(npmPublish, /environment: npm-publish/)
  assert.match(npmPublish, /npm publish --provenance --access public/)
  assert.doesNotMatch(npmPublish, /NODE_AUTH_TOKEN|NPM_TOKEN/)
  assert.match(npmPublish, /npm pack --dry-run/)
})
