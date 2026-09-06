// Source-preserving decisions. A policy grants authority for one exact section;
// it never grants a model permission to write files or choose its own scope.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { stableJson, withManifestLockAsync } from './manifest.mjs';
import { sidecarDir } from './sidecar-state.mjs';
import { isNewerDay } from './conflict-policy.mjs';

const hash = value => createHash('sha256').update(stableJson(value)).digest('hex');
export const contextManifestFingerprint = manifest => hash({ layers: manifest.layers ?? [], settings: manifest.settings ?? {} });
export function sectionEvidence(resolved, key) {
  const section = resolved?.sections?.find(row => row.key === key);
  if (!section || section.suppressed || !section.conflicts?.length) return null;
  const levels = new Map(resolved.contributors.map(row => [row.layer, row.level]));
  const contributions = [
    { source: section.sourceLayer, content: section.content, updated: section.sourceUpdated ?? null },
    ...section.conflicts.map(row => ({ source: row.layer, content: row.content, updated: row.updated ?? null })),
  ].map(row => ({ ...row, level: levels.get(row.source) ?? null })).sort((a, b) => a.source.localeCompare(b.source));
  return { conceptId: resolved.id, key, contributions, fingerprint: hash({ key, contributions }) };
}

// Store reads return immutable snapshots to their callers. Cache only by that
// snapshot's identity, so one resolve-all prepares history once and a later
// sidecar read never inherits stale policy lookups.
const preparedStates = new WeakMap();
function prepareContextResolutions(state) {
  let prepared = preparedStates.get(state);
  if (!prepared) {
    const latest = new Map();
    for (const row of state.decisions) latest.set(JSON.stringify([row.conceptId, row.key]), row);
    prepared = { latest, policies: new Map(state.policies.map(row => [row.id, row])) };
    preparedStates.set(state, prepared);
  }
  return prepared;
}

export function applyContextResolutions(resolved, state, { profileId = 'default', manifestFingerprint, coverageComplete = true, blockedKeys = new Set() }) {
  if (!resolved) return resolved;
  const result = structuredClone(resolved);
  const prepared = prepareContextResolutions(state);
  for (const section of result.sections) {
    const decision = prepared.latest.get(JSON.stringify([result.id, section.key]));
    if (!decision) continue;
    const policy = prepared.policies.get(decision.policyId);
    const evidence = sectionEvidence(resolved, section.key);
    const active = coverageComplete && !blockedKeys.has(`${result.id}::${section.key}`) && !decision.undoneAt && policy?.enabled === true
      && policy.version === decision.policyVersion && decision.profileId === profileId
      && policy.conceptId === decision.conceptId && policy.key === decision.key && policy.selectedSource === decision.selectedSource
      && decision.manifestFingerprint === manifestFingerprint && policy.manifestFingerprint === manifestFingerprint
      && evidence?.fingerprint === decision.evidenceFingerprint;
    section.contextResolution = { decisionId: decision.id, policyId: decision.policyId,
      status: decision.undoneAt ? 'undone' : active ? 'applied' : 'stale', selectedSource: decision.selectedSource };
    if (!active) continue;
    const selected = evidence.contributions.find(row => row.source === decision.selectedSource);
    if (!selected) { section.contextResolution.status = 'stale'; continue; }
    section.content = selected.content;
    section.sourceLayer = selected.source;
    section.sourceUpdated = selected.updated;
    section.conflicts = evidence.contributions.filter(row => row.source !== selected.source)
      .map(row => ({ layer: row.source, content: row.content, updated: row.updated }));
    section.fresherDissent = section.conflicts.some(row => isNewerDay(row.updated, selected.updated));
  }
  return result;
}

export function createContextResolutionStore(manifestPath, { profileId = 'default' } = {}) {
  const filename = path.join(sidecarDir(manifestPath, profileId), 'context-resolutions.json');
  async function read() {
    let state;
    try { state = JSON.parse(await fsp.readFile(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, revision: 0, policies: [], decisions: [] }; throw error; }
    validateState(state, profileId);
    return state;
  }
  // The caller's validation runs INSIDE the shared manifest lock, against the
  // latest state. A crash before rename keeps the old state; after rename the
  // complete decision and its policy are durable together. No source is edited.
  async function update(mutate) {
    return withManifestLockAsync(manifestPath, async () => {
      const state = await read();
      const result = await mutate(state);
      if (result?.unchanged) return result;
      state.revision++;
      await fsp.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const temp = `${filename}.${randomUUID()}.tmp`;
      try {
        const file = await fsp.open(temp, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(state) + '\n'); await file.sync(); } finally { await file.close(); }
        await fsp.rename(temp, filename);
      } finally { await fsp.rm(temp, { force: true }); }
      return result;
    });
  }
  return { filename, read, update, profileId };
}


function validateState(state, profileId) {
  const invalid = () => { throw new Error('Invalid context resolution state; automatic resolution is stopped.'); };
  const string = value => typeof value === 'string' && value.length > 0 && value.length < 2000;
  const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const integer = value => Number.isSafeInteger(value) && value > 0;
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Array.isArray(state.policies) || !Array.isArray(state.decisions)
    || state.policies.length > 500 || state.decisions.length > 10000) invalid();
  const policies = new Map();
  const scopes = new Set();
  for (const policy of state.policies) {
    if (!policy || ![policy.id, policy.conceptId, policy.key, policy.selectedSource].every(string)
      || typeof policy.enabled !== 'boolean' || !integer(policy.version) || !fingerprint(policy.manifestFingerprint)) invalid();
    const scope = JSON.stringify([policy.conceptId, policy.key]);
    if (policies.has(policy.id) || scopes.has(scope)) invalid();
    policies.set(policy.id, policy); scopes.add(scope);
  }
  const ids = new Set();
  for (const decision of state.decisions) {
    if (!decision || ![decision.id, decision.policyId, decision.conceptId, decision.key, decision.selectedSource].every(string)
      || !integer(decision.policyVersion) || decision.profileId !== profileId || decision.method !== 'exact_policy'
      || !fingerprint(decision.manifestFingerprint) || !fingerprint(decision.evidenceFingerprint)
      || typeof decision.createdAt !== 'string' || !Number.isFinite(Date.parse(decision.createdAt))
      || (decision.undoneAt !== undefined && (typeof decision.undoneAt !== 'string' || !Number.isFinite(Date.parse(decision.undoneAt))))) invalid();
    const policy = policies.get(decision.policyId);
    if (ids.has(decision.id) || !policy || decision.policyVersion > policy.version
      || decision.conceptId !== policy.conceptId || decision.key !== policy.key) invalid();
    ids.add(decision.id);
  }
}
