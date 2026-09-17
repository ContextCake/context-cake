#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const PACKAGE_NAME = 'contextcake'
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`
const DATA_URL = new URL('../src/data/npm-release.json', import.meta.url)
const APP_RELEASE_URL = new URL('../src/data/app-release.json', import.meta.url)
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/

export const UNPUBLISHED = Object.freeze({ published: false })

// The site offers `npm install -g contextcake@<version>` only when npm has the
// same version as the app release the site links. A registry document without
// that version, a deprecated version, or an integrity string we cannot show is
// recorded as unpublished, and the pages keep the source route copy.
export function buildNpmReleaseRecord(registryDocument, appVersion) {
  if (!VERSION_PATTERN.test(appVersion ?? '')) throw new Error('App release version must use X.Y.Z')
  const entry = registryDocument?.versions?.[appVersion]
  if (!entry || entry.name !== PACKAGE_NAME || entry.version !== appVersion) return { ...UNPUBLISHED }
  if (entry.deprecated) return { ...UNPUBLISHED }
  const integrity = entry.dist?.integrity
  if (typeof integrity !== 'string' || !INTEGRITY_PATTERN.test(integrity)) return { ...UNPUBLISHED }
  return { published: true, version: appVersion, tarballIntegrity: integrity }
}

const retryableStatus = (status) => status === 429 || status >= 500

// Unlike the app sync, a registry failure never fails the build. The app
// record decides which downloads exist, so a stale one is wrong; the npm
// record only adds a route, so falling back to the source route is safe. The
// caller gets the reason so the workflow log shows why the route is absent.
export async function fetchNpmReleaseRecord({ appVersion, fetchImpl = globalThis.fetch, retryDelayMs = 250 } = {}) {
  let lastProblem
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(REGISTRY_URL, {
        signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'application/json', 'User-Agent': 'ContextCake npm-site sync' },
      })
      if (response.status === 404) {
        return { record: { ...UNPUBLISHED }, reason: `npm has no ${PACKAGE_NAME} package` }
      }
      if (response.ok) {
        let document
        try {
          document = await response.json()
        } catch {
          return { record: { ...UNPUBLISHED }, reason: 'npm registry answered with invalid JSON' }
        }
        const record = buildNpmReleaseRecord(document, appVersion)
        return {
          record,
          reason: record.published ? null : `npm has no usable ${PACKAGE_NAME}@${appVersion}`,
        }
      }
      lastProblem = `HTTP ${response.status}`
      if (!retryableStatus(response.status)) break
    } catch (error) {
      lastProblem = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error)
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)))
  }
  return { record: { ...UNPUBLISHED }, reason: `npm registry request failed: ${lastProblem}` }
}

export async function writeNpmReleaseRecord(record, dataUrl = DATA_URL) {
  await writeFile(dataUrl, `${JSON.stringify(record, null, 2)}\n`)
}

async function main() {
  if (process.argv.length > 2) throw new Error('Usage: node scripts/sync-npm-release.mjs')
  // Run after sync-app-release.mjs: the app record names the version to look for.
  const appRelease = JSON.parse(await readFile(APP_RELEASE_URL, 'utf8'))
  const { record, reason } = await fetchNpmReleaseRecord({ appVersion: appRelease.version })
  await writeNpmReleaseRecord(record)
  if (record.published) {
    console.log(`npm has ${PACKAGE_NAME}@${record.version}; the site shows the npm route`)
  } else {
    console.log(`No npm route for ${appRelease.tag}: ${reason}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message ?? error)
    process.exitCode = 1
  })
}
