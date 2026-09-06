import { randomUUID } from 'node:crypto';
import { sectionEvidence, contextManifestFingerprint } from '../context-resolutions.mjs';
import { ControlError } from './errors.mjs';
import { withDeadline } from './util.mjs';

const fail = (code, message, status = 409) => { throw new ControlError(code, message, { status }); };
export function createContextResolutionOperations({ store, project, manifest, readLiveResolved, validationTimeoutMs = 4000 }) {
  function current(conceptId, key, expectedRevision) {
    // Validation is read-only. If it outlives this deadline its eventual result
    // cannot reach addDecision, and the manifest lock is released promptly.
    return withDeadline(readCurrent(conceptId, key, expectedRevision), validationTimeoutMs,
      'Evidence validation timed out; no automatic decision was recorded.');
  }
  async function readCurrent(conceptId, key, expectedRevision) {
    const projection = await project();
    if (!projection.coverageComplete || projection.indexing || projection.errors.length) fail('COVERAGE_INCOMPLETE', 'Wait for all sources to finish indexing successfully.');
    const discrepancy = projection.byId.get(`section_content::${conceptId}::${key}`);
    if (!discrepancy || discrepancy.ruleConflict || discrepancy.matchingRules?.some(rule => rule.mode === 'automatic')) fail('NOT_ELIGIBLE', 'This section is no longer eligible for an automatic policy.');
    if (expectedRevision && discrepancy.revision !== expectedRevision) fail('STALE_EVIDENCE', 'The evidence changed. Refresh before enabling this policy.');
    const fingerprint = contextManifestFingerprint(manifest());
    const evidence = sectionEvidence(await readLiveResolved(conceptId), key);
    if (!evidence) fail('STALE_EVIDENCE', 'This section no longer has a conflict.');
    // Compare the live read with the projection the user reviewed. A watcher
    // delay cannot turn approval of yesterday's evidence into today's policy.
    for (const row of discrepancy.contributions) {
      const live = evidence.contributions.find(item => item.source === row.source);
      if (!live || live.content !== row.value || live.updated !== (row.updated ?? null) || live.level !== row.level) fail('STALE_EVIDENCE', 'Source content changed. Wait for indexing and refresh.');
    }
    if (evidence.contributions.length !== discrepancy.contributions.length || fingerprint !== contextManifestFingerprint(manifest())) fail('STALE_EVIDENCE', 'Sources changed during validation.');
    return { evidence, fingerprint };
  }
  function addDecision(state, policy, evidence, fingerprint) {
    const previous = state.decisions.filter(row => row.policyId === policy.id).at(-1);
    if (previous && !previous.undoneAt && previous.policyVersion === policy.version && previous.evidenceFingerprint === evidence.fingerprint && previous.manifestFingerprint === fingerprint) return { unchanged: true };
    if (state.decisions.length >= 10000) fail('HISTORY_FULL', 'Resolution history is full. Automatic resolution is paused until history is archived.');
    const decision = { id: randomUUID(), profileId: store.profileId, policyId: policy.id, policyVersion: policy.version,
      conceptId: policy.conceptId, key: policy.key, selectedSource: policy.selectedSource,
      evidenceFingerprint: evidence.fingerprint, manifestFingerprint: fingerprint, createdAt: new Date().toISOString(), method: 'exact_policy' };
    state.decisions.push(decision);
    return { decision };
  }
  async function enable(body) {
    const { conceptId, key, selectedSource, revision } = body ?? {};
    if (![conceptId, key, selectedSource, revision].every(value => typeof value === 'string' && value.length > 0 && value.length < 2000)) fail('INVALID_POLICY', 'Provide an exact concept, section, source and reviewed revision.', 400);
    return store.update(async state => {
      const { evidence, fingerprint } = await current(conceptId, key, revision);
      if (!evidence.contributions.some(row => row.source === selectedSource)) fail('INVALID_SOURCE', 'The selected source does not contribute to this section.', 400);
      let policy = state.policies.find(row => row.conceptId === conceptId && row.key === key);
      if (!policy) {
        if (state.policies.length >= 500) fail('POLICY_LIMIT', 'This profile has reached its limit of 500 exact policies.');
        policy = { id: randomUUID(), conceptId, key, version: 0 }; state.policies.push(policy);
      }
      Object.assign(policy, { selectedSource, enabled: true, version: policy.version + 1, manifestFingerprint: fingerprint });
      return { policy, ...addDecision(state, policy, evidence, fingerprint) };
    });
  }
  async function pause(policyId) {
    return store.update(state => {
      const policy = state.policies.find(row => row.id === policyId);
      if (!policy) fail('NOT_FOUND', 'Policy not found.', 404);
      policy.enabled = false; policy.version++;
      return { policy };
    });
  }
  async function undo(decisionId) {
    return store.update(state => {
      const decision = state.decisions.find(row => row.id === decisionId);
      if (!decision) fail('NOT_FOUND', 'Decision not found.', 404);
      const latest = state.decisions.filter(row => row.conceptId === decision.conceptId && row.key === decision.key).at(-1);
      if (latest.id !== decision.id) fail('NEWER_DECISION', 'A newer decision exists. Undo the latest decision instead.');
      if (decision.undoneAt) return { unchanged: true };
      decision.undoneAt = new Date().toISOString();
      const policy = state.policies.find(row => row.id === decision.policyId);
      if (policy) { policy.enabled = false; policy.version++; }
      return { decision };
    });
  }
  async function run() {
    const policies = (await store.read()).policies.filter(row => row.enabled);
    const results = [];
    for (const candidate of policies) {
      try {
        results.push(await store.update(async state => {
          const policy = state.policies.find(row => row.id === candidate.id);
          if (!policy?.enabled || policy.version !== candidate.version) return { unchanged: true };
          const { evidence, fingerprint } = await current(policy.conceptId, policy.key);
          if (fingerprint !== policy.manifestFingerprint || !evidence.contributions.some(row => row.source === policy.selectedSource)) return { unchanged: true };
          return addDecision(state, policy, evidence, fingerprint);
        }));
      } catch (error) { results.push({ policyId: candidate.id, skipped: true, code: error.code ?? 'VALIDATION_FAILED' }); }
    }
    return results;
  }
  return { enable, pause, undo, run, view: () => store.read() };
}
