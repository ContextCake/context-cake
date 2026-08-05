#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

function requireHttpsUrl(value, label) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} is not a valid URL`)
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`)
  return url
}

async function readResponse(fetchImpl, url, label) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`)
  return response
}

export async function verifyReleaseSurfaces({
  webDemoUrl,
  siteUrl,
  expectedTag,
  expectedCommit,
  expectedVersion,
  fetchImpl = globalThis.fetch,
}) {
  if (!/^app-v\d+\.\d+\.\d+$/.test(expectedTag)) throw new Error('Expected tag must be app-v semantic version')
  if (expectedTag !== `app-v${expectedVersion}`) throw new Error('Expected tag and version do not match')
  if (!/^[a-f0-9]{40}$/.test(expectedCommit)) throw new Error('Expected commit must be a full Git SHA')

  const demoBase = requireHttpsUrl(webDemoUrl, 'Web Demo deployment URL')
  const siteBase = requireHttpsUrl(siteUrl, 'Site deployment URL')

  const provenanceResponse = await readResponse(fetchImpl, new URL('/release.json', demoBase), 'Web Demo provenance')
  const provenance = await provenanceResponse.json()
  if (provenance?.tag !== expectedTag || provenance?.commit !== expectedCommit) {
    throw new Error(`Web Demo provenance mismatch: expected ${expectedTag} at ${expectedCommit}`)
  }

  const installResponse = await readResponse(fetchImpl, new URL('/install/', siteBase), 'Site install page')
  const installHtml = await installResponse.text()
  if (!installHtml.includes(`ContextCake-${expectedVersion}-arm64.dmg`)) {
    throw new Error(`Site install page does not target ContextCake ${expectedVersion}`)
  }

  const demoResponse = await readResponse(fetchImpl, new URL('/demo/', siteBase), 'Site demo page')
  const demoHtml = await demoResponse.text()
  if (!demoHtml.includes('https://contextcake-console.pages.dev/')) {
    throw new Error('Site demo page does not embed the canonical Web Demo')
  }
}

async function main() {
  await verifyReleaseSurfaces({
    webDemoUrl: process.env.WEB_DEMO_DEPLOYMENT_URL,
    siteUrl: process.env.SITE_DEPLOYMENT_URL,
    expectedTag: process.env.EXPECTED_TAG,
    expectedCommit: process.env.EXPECTED_COMMIT,
    expectedVersion: process.env.EXPECTED_VERSION,
  })
  console.log(`release surfaces verified (${process.env.EXPECTED_TAG} at ${process.env.EXPECTED_COMMIT})`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message ?? error)
    process.exitCode = 1
  })
}
