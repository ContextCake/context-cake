// Model output is evidence for review, never authority for an automatic policy.
import { createHash } from 'node:crypto';
import { stableJson } from './manifest.mjs';
import { sectionEvidence, contextManifestFingerprint } from './context-resolutions.mjs';
import { ControlError } from './control/errors.mjs';
import { withDeadline } from './control/util.mjs';

export const ASSESSMENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['category', 'selectedSource', 'rationale', 'citations', 'missingEvidence'],
  properties: {
    category: { type: 'string', enum: ['equivalent', 'different_scope', 'superseded', 'conflicting', 'insufficient_evidence'] },
    selectedSource: { type: ['string', 'null'] },
    rationale: { type: 'string', maxLength: 2000 },
    citations: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false,
      required: ['source', 'quote'], properties: { source: { type: 'string' }, quote: { type: 'string', minLength: 1, maxLength: 2000 } } } },
    missingEvidence: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 500 } },
  },
};
const fail = (code, message, status = 409) => { throw new ControlError(code, message, { status }); };
const keysExactly = (row, keys) => row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));

export function validateAssessment(value, packet) {
  if (!keysExactly(value, ASSESSMENT_SCHEMA.required)
    || !ASSESSMENT_SCHEMA.properties.category.enum.includes(value.category)
    || !(value.selectedSource === null || typeof value.selectedSource === 'string')
    || typeof value.rationale !== 'string' || value.rationale.length > 2000
    || !Array.isArray(value.citations) || value.citations.length > 12
    || !Array.isArray(value.missingEvidence) || value.missingEvidence.length > 12
    || value.missingEvidence.some(row => typeof row !== 'string' || row.length > 500)) fail('INVALID_ASSESSMENT', 'The model returned an invalid assessment. No decision was made.', 422);
  for (const citation of value.citations) {
    if (!keysExactly(citation, ['source', 'quote']) || typeof citation.quote !== 'string' || !citation.quote.length || citation.quote.length > 2000
      || !packet.contributions.some(row => row.source === citation.source && row.content.includes(citation.quote))) fail('UNGROUNDED_CITATION', 'The model cited text outside this evidence. No decision was made.', 422);
  }
  if (value.selectedSource !== null && (!packet.contributions.some(row => row.source === value.selectedSource)
    || !value.citations.some(row => row.source === value.selectedSource))) fail('INVALID_SELECTION', 'The model did not support its suggested source with a valid citation.', 422);
  if (value.selectedSource !== null && value.missingEvidence.length) fail('INVALID_SELECTION', 'The model suggested a source while reporting missing evidence. The result was discarded.', 422);
  if (value.category !== 'insufficient_evidence' && packet.contributions.some(row => !value.citations.some(citation => citation.source === row.source))) fail('UNGROUNDED_CITATION', 'The model must cite every compared contribution or abstain.', 422);
  if (value.category === 'insufficient_evidence' && value.selectedSource !== null) fail('INVALID_SELECTION', 'An insufficient-evidence assessment must abstain.', 422);
  return { ...value, advisoryOnly: true, automaticallyApplicable: false };
}

export function createAssessmentOperations({ project, manifest, readLiveResolved, provider, profileId = 'default' }) {
  let busy = false;
  async function packetFor(id, revision) {
    const projection = await project();
    if (!projection.coverageComplete || projection.indexing || projection.errors.length) fail('COVERAGE_INCOMPLETE', 'Assessment requires complete source coverage.');
    const discrepancy = projection.byId.get(id);
    if (!discrepancy || discrepancy.revision !== revision || !id.startsWith('section_content::')) fail('STALE_EVIDENCE', 'Refresh and select a current section conflict.');
    const evidence = sectionEvidence(await readLiveResolved(discrepancy.conceptId), discrepancy.key);
    if (!evidence || evidence.contributions.length !== discrepancy.contributions.length || discrepancy.contributions.some(row =>
      !evidence.contributions.some(live => live.source === row.source && live.content === row.value && live.updated === (row.updated ?? null) && live.level === row.level))) fail('STALE_EVIDENCE', 'The source changed before assessment.');
    const packet = { version: 1, profileId, discrepancyId: id, revision,
      manifestFingerprint: contextManifestFingerprint(manifest()), ...evidence };
    // Never silently truncate a qualifier or pretend a partial context is complete.
    if (Buffer.byteLength(JSON.stringify(packet)) > 12000) fail('EVIDENCE_TOO_LARGE', 'This evidence exceeds the local assessment budget. Review it directly.', 413);
    return packet;
  }
  async function assess(body) {
    if (!provider) fail('PROVIDER_UNAVAILABLE', 'Local assessment is available in the desktop app with an installed local model.', 503);
    if (busy) fail('ASSESSMENT_BUSY', 'Another local assessment is running.', 429);
    if (!body || typeof body.discrepancyId !== 'string' || typeof body.revision !== 'string') fail('INVALID_ASSESSMENT_REQUEST', 'Select a current discrepancy.', 400);
    busy = true;
    try {
      const packet = await withDeadline(packetFor(body.discrepancyId, body.revision), 4000, 'Evidence validation timed out.');
      const started = Date.now();
      const result = await provider.assess({ packet, schema: ASSESSMENT_SCHEMA, model: body.model, digest: body.digest });
      const assessment = validateAssessment(result.value, packet);
      const after = await withDeadline(packetFor(body.discrepancyId, body.revision), 4000, 'Evidence revalidation timed out.');
      if (stableJson(packet) !== stableJson(after)) fail('STALE_EVIDENCE', 'Evidence changed during assessment. The result was discarded.');
      return { assessment, evidenceFingerprint: packet.fingerprint,
        packetHash: createHash('sha256').update(stableJson(packet)).digest('hex'),
        model: result.model, digest: result.digest, runtimeVersion: result.runtimeVersion ?? null, durationMs: Date.now() - started };
    } finally { busy = false; }
  }
  return { assess, models: () => provider ? provider.models() : Promise.resolve({ available: false, models: [] }) };
}
