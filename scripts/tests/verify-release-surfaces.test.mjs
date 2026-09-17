import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RELEASE_PLATFORMS } from '../release-platforms.mjs'
import { verifyReleaseSurfaces } from '../verify-release-surfaces.mjs'

const release = {
  webDemoUrl: 'https://demo-deploy.pages.dev',
  siteUrl: 'https://site-deploy.pages.dev',
  expectedTag: 'app-v1.2.3',
  expectedCommit: 'a'.repeat(40),
  expectedVersion: '1.2.3',
}

function response(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => String(body),
  }
}

const download = (tag, name) => `https://github.com/ContextCake/context-cake/releases/download/${tag}/${name}`
const installHtml = `app-v1.2.3 ${RELEASE_PLATFORMS.map((row) => `href="${row.downloadPath}"`).join(' ')}`

// Every route of every platform row, pointed at that row's installer.
function downloadRoutes(version = '1.2.3', { skip } = {}) {
  const routes = new Map()
  for (const row of RELEASE_PLATFORMS) {
    if (row.id === skip) continue
    for (const route of [row.downloadPath, ...row.downloadAliases]) {
      routes.set(route, download(`app-v${version}`, row.installerName(version)))
    }
  }
  return routes
}

function redirect(location) {
  return {
    ok: false,
    status: 302,
    headers: new Headers({ location }),
  }
}

test('accepts matching Web Demo provenance and a site redirect for every platform row', async () => {
  const seen = []
  const routes = downloadRoutes()
  await verifyReleaseSurfaces({
    ...release,
    fetchImpl: async (url) => {
      seen.push(url.href)
      if (url.pathname === '/release.json') return response({ tag: release.expectedTag, commit: release.expectedCommit })
      if (url.pathname === '/install/') return response(installHtml)
      if (routes.has(url.pathname)) return redirect(routes.get(url.pathname))
      if (url.pathname === '/demo/') return response('<iframe src="https://contextcake-console.pages.dev/"></iframe>')
      throw new Error(`unexpected URL ${url}`)
    },
  })
  assert.deepEqual(seen, [
    'https://demo-deploy.pages.dev/release.json',
    'https://site-deploy.pages.dev/install/',
    'https://site-deploy.pages.dev/download/mac-arm64',
    'https://site-deploy.pages.dev/download/mac',
    'https://site-deploy.pages.dev/download/mac-x64',
    'https://site-deploy.pages.dev/download/linux-x64-deb',
    'https://site-deploy.pages.dev/download/linux',
    'https://site-deploy.pages.dev/demo/',
  ])
})

test('rejects a deployed site that is missing a platform row', async () => {
  const routes = downloadRoutes('1.2.3', { skip: 'mac-x64' })
  await assert.rejects(
    verifyReleaseSurfaces({
      ...release,
      fetchImpl: async (url) => {
        if (url.pathname === '/release.json') return response({ tag: release.expectedTag, commit: release.expectedCommit })
        if (url.pathname === '/install/') return response(installHtml.replace(' href="/download/mac-x64"', ''))
        if (routes.has(url.pathname)) return redirect(routes.get(url.pathname))
        return { ok: false, status: 404 }
      },
    }),
    /does not link \/download\/mac-x64/,
  )
})

test('rejects a deployed Web Demo from another commit', async () => {
  await assert.rejects(
    verifyReleaseSurfaces({
      ...release,
      fetchImpl: async () => response({ tag: release.expectedTag, commit: 'b'.repeat(40) }),
    }),
    /provenance mismatch/,
  )
})

test('rejects inconsistent release inputs before making a request', async () => {
  let requested = false
  await assert.rejects(
    verifyReleaseSurfaces({
      ...release,
      expectedVersion: '1.2.4',
      fetchImpl: async () => { requested = true; return response('') },
    }),
    /tag and version do not match/,
  )
  assert.equal(requested, false)
})

test('rejects a lookalike Web Demo iframe host', async () => {
  await assert.rejects(
    verifyReleaseSurfaces({
      ...release,
      fetchImpl: async (url) => {
        if (url.pathname === '/release.json') return response({ tag: release.expectedTag, commit: release.expectedCommit })
        if (url.pathname === '/install/') return response(installHtml)
        if (downloadRoutes().has(url.pathname)) return redirect(downloadRoutes().get(url.pathname))
        if (url.pathname === '/demo/') {
          return response('<iframe src="https://contextcake-console.pages.dev.attacker.example/"></iframe>')
        }
        throw new Error(`unexpected URL ${url}`)
      },
    }),
    /does not embed the canonical Web Demo/,
  )
})

test('rejects a stable download redirect to another app version', async () => {
  const routes = downloadRoutes()
  routes.set('/download/mac', download('app-v1.2.2', 'ContextCake-1.2.2-arm64.dmg'))
  await assert.rejects(
    verifyReleaseSurfaces({
      ...release,
      fetchImpl: async (url) => {
        if (url.pathname === '/release.json') return response({ tag: release.expectedTag, commit: release.expectedCommit })
        if (url.pathname === '/install/') return response(installHtml)
        if (routes.has(url.pathname)) return redirect(routes.get(url.pathname))
        throw new Error(`unexpected URL ${url}`)
      },
    }),
    /\/download\/mac does not target app-v1\.2\.3/,
  )
})
