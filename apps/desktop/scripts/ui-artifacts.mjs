import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSmoke } from './smoke.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
runSmoke({ mode: 'ui', artifactDir: process.env.CC_SMOKE_ARTIFACT_DIR || path.join(repoRoot, 'docs', 'review-assets', 'mac-first-final') })
