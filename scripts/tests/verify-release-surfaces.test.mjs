import assert from 'node:assert/strict'
import { test } from 'node:test'
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

function redirect(location) {
  return {
    ok: false,
    status: 302,
    headers: new Headers({ location }),
  }
}

test('accepts matching Web Demo provenance and site release links', async () => {
  const seen = []
  await verifyReleaseSurfaces({
    ...release,
    fetchImpl: async (url) => {
      seen.push(url.href)
      if (url.pathname === '/release.json') return response({ tag: release.expectedTag, commit: release.expectedCommit })
      if (url.pathname === '/install/') return response('app-v1.2.3 href="/download/mac"')
      if (url.pathname === '/download/mac') return redirect('https://github.com/ContextCake/context-cake/releases/download/app-v1.2.3/ContextCake-1.2.3-arm64.dmg')
      if (url.pathname === '/demo/') return response('<iframe src="https://contextcake-console.pages.dev/"></iframe>')
      throw new Error(`unexpected URL ${url}`)
    },
  })
  assert.deepEqual(seen, [
    'https://demo-deploy.pages.dev/release.json',
    'https://site-deploy.pages.dev/install/',
    'https://site-deploy.pages.dev/download/mac',
    'https://site-deploy.pages.dev/demo/',
  ])
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
        if (url.pathname === '/install/') return response('app-v1.2.3 href="/download/mac"')
        if (url.pathname === '/download/mac') return redirect('https://github.com/ContextCake/context-cake/releases/download/app-v1.2.3/ContextCake-1.2.3-arm64.dmg')
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
  await assert.rejects(
    verifyReleaseSurfaces({
      ...release,
      fetchImpl: async (url) => {
        if (url.pathname === '/release.json') return response({ tag: release.expectedTag, commit: release.expectedCommit })
        if (url.pathname === '/install/') return response('app-v1.2.3 href="/download/mac"')
        if (url.pathname === '/download/mac') return redirect('https://github.com/ContextCake/context-cake/releases/download/app-v1.2.2/ContextCake-1.2.2-arm64.dmg')
        throw new Error(`unexpected URL ${url}`)
      },
    }),
    /does not target app-v1\.2\.3/,
  )
})
