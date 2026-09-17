// Read-half knowledge operations (control-plane spec §5.7): list, search,
// read, and links over concepts, and list/read over layer files. The CLI's
// `concept` and `file` families are shims over these.
//
// Every operation takes an immutable scope { manifestPath, profileId } and
// optionally the `manifest` (and its `quarantined` layers) the caller already
// read, plus an AbortSignal that stops a timed-out or interrupted read. It answers
// through the engine's own read paths: resolver.mjs for resolution,
// retained-search.mjs (the search store MCP and the service use) for ranking,
// concept-queries.mjs for the shapes MCP and /api/resolve return, and
// layer-files.mjs for files. Nothing here ranks or merges on its own.
//
// Reads read around a bad layer, never fail on it: the manifest is read the
// way the service reads it (quarantined), and a source that cannot answer is
// left out of the query and named in `coverage` (spec §5.2).

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  assembleMarkdown, decorateResolvedDispositions, effectiveDiscrepancyRules, getLinks, listConcepts,
} from "../concept-queries.mjs";
import { createConflictResolutionLog } from "../conflict-resolutions.mjs";
import { applyContextResolutions, contextManifestFingerprint, createContextResolutionStore } from "../context-resolutions.mjs";
import { blockedContextResolutionKeys } from "../discrepancies.mjs";
import { createDiscrepancyRuleStore } from "../discrepancy-rules.mjs";
import { layerIdentity } from "../index-keys.mjs";
import { layerRootMap, listFilesApi, readFileApi } from "../layer-files.mjs";
import { manifestRevision, readContextManifestQuarantined, selectManifestProfile } from "../manifest.mjs";
import { normalizeId } from "../markdown-links.mjs";
import { resolveConcept } from "../resolver.mjs";
import { createRetainedSearch } from "../retained-search.mjs";
import { tokenizeQuery } from "../search.mjs";
import { resolveSettings, walkLimitsFrom } from "../settings.mjs";
import { buildSourcesQuarantined } from "../sources/index.mjs";
import { resolveLiveLayer } from "../sources/git-sync.mjs";
import { ControlError, manifestControlError } from "./errors.mjs";

export const SEARCH_LIMIT_MAX = 50;
const LOCAL_KINDS = new Set(["okf-local", "files"]);

/**
 * The selected profile as the read path sees it. Same shape as
 * profile-runtime.mjs's loadProfileRuntime, plus `quarantined`: the layers of
 * this profile the manifest reader lifted out. The profile is re-selected by
 * id, so the caller's selection (and its reason) stays authoritative. A caller
 * that already read the manifest passes it (already quarantined) and its
 * `quarantined` list; otherwise it is read here.
 */
export function loadReadRuntime({ manifestPath, profileId, manifest = null, quarantined = [] }) {
  const resolvedPath = path.resolve(manifestPath);
  let selection;
  try {
    if (!manifest) ({ manifest, quarantined } = readContextManifestQuarantined(resolvedPath, { allowMissing: false, validatePacks: false }));
    selection = selectManifestProfile(manifest, { requestedProfile: profileId });
  } catch (error) {
    throw manifestControlError(error);
  }
  return {
    manifestPath: resolvedPath,
    manifestDir: path.dirname(resolvedPath),
    selection,
    revision: manifestRevision(manifest),
    runtimeManifest: { layers: selection.layers, ...(manifest.settings ? { settings: manifest.settings } : {}) },
    quarantined: quarantined.filter((entry) => entry.profileId === selection.profileId),
  };
}

/**
 * One selected-profile session: adapters for that profile only (spec §5.4:
 * every source and child process is closed). The close runs when `fn`
 * settles, when `scope.signal` aborts, and through `scope.onClose` (the CLI's
 * ctx.onClose), whichever comes first: a timed-out read is abandoned before
 * its own `finally` can run, and its MCP children must not outlive the
 * process. tokenEnv credentials resolve from the environment, as they do for
 * `contextcake mcp`.
 */
export async function withReadSession(scope, fn) {
  const runtime = loadReadRuntime(scope);
  const sources = buildSourcesQuarantined(runtime.runtimeManifest, runtime.manifestDir, { profileId: runtime.selection.profileId });
  let closing = null;
  const close = () => {
    closing ??= Promise.allSettled(sources.map(async (source) => source.close?.()));
    return closing;
  };
  scope.onClose?.(close);
  const signal = scope.signal ?? null;
  signal?.addEventListener("abort", close, { once: true });
  let liveLayer = null;
  try {
    liveLayer = resolveLiveLayer(runtime.selection.layers, runtime.manifestDir);
  } catch {
    // A misdeclared live layer blocks capture, not reading.
  }
  const session = {
    runtime,
    signal,
    sources,
    liveLayer,
    profileId: runtime.selection.profileId,
    settings: resolveSettings(runtime.runtimeManifest),
    kinds: new Map(runtime.selection.layers.map((layer) => [layer.name, layer.source ?? "okf-local"])),
  };
  try {
    signal?.throwIfAborted();
    return await fn(session);
  } finally {
    signal?.removeEventListener("abort", close);
    await close();
  }
}

function quarantinedRows(runtime) {
  return runtime.quarantined.map((entry) => ({
    name: entry.name,
    kind: null,
    status: "unavailable",
    reason: `Invalid layer configuration: ${entry.error}`,
  }));
}

// The per-source time budget, cut short when the command is stopped.
function budgetSignal(session) {
  const budget = AbortSignal.timeout(session.settings.sourceBudgetMs);
  return session.signal ? AbortSignal.any([budget, session.signal]) : budget;
}

function healthFailure(source) {
  const health = source.health?.();
  return health && health.ok === false && health.lastError ? String(health.lastError) : null;
}

// A source whose listing is already known. Everything else delegates to the
// adapter, so reads stay live; only the listing is not asked for again.
function listedView(source, ids, entries) {
  const view = Object.create(source);
  view.listConceptIds = async () => ids;
  if (entries) view.listEntries = async () => entries;
  return view;
}

/**
 * Lists every source once, with walk notes, bounded by the sourceBudgetMs
 * setting and the command's signal. Returns the coverage rows and `layers`:
 * views of the sources that answered, which the query then reads, so coverage
 * describes the very listing the data came from.
 *
 * status: "ok"; "partial" when the walk skipped or capped documents (the
 * source still answers); "unavailable" when it could not be listed at all.
 */
export async function listSources(session) {
  const listed = await Promise.all(session.sources.map(async (source) => {
    const kind = session.kinds.get(source.name) ?? source.quarantinedKind ?? null;
    const notes = { skipped: [], unreadable: [], hidden: 0 };
    let ids;
    let entries = null;
    try {
      const options = { signal: budgetSignal(session), notes };
      if (typeof source.listEntries === "function") {
        entries = await source.listEntries(options);
        ids = entries.map((entry) => entry.id);
      } else {
        ids = await source.listConceptIds(options);
      }
    } catch (error) {
      // The command was stopped, not the source: do not blame the source.
      session.signal?.throwIfAborted();
      return { row: { name: source.name, kind, status: "unavailable", reason: error?.message ?? String(error) } };
    }
    const failure = healthFailure(source);
    if (failure) return { row: { name: source.name, kind, status: "unavailable", reason: failure } };
    const reasons = [];
    if (notes.truncated) reasons.push(`indexed only the first ${notes.truncated.cap} documents`);
    if (notes.skipped.length) reasons.push(`${notes.skipped.length} document(s) over the size cap were skipped`);
    if (notes.unreadable.length) reasons.push(`${notes.unreadable.length} folder(s) could not be read`);
    const row = reasons.length
      ? { name: source.name, kind, status: "partial", reason: reasons.join("; ") }
      : { name: source.name, kind, status: "ok" };
    return { row, view: listedView(source, ids, entries) };
  }));
  session.signal?.throwIfAborted();
  return {
    rows: [...listed.map((item) => item.row), ...quarantinedRows(session.runtime)],
    layers: listed.filter((item) => item.view).map((item) => item.view),
  };
}

// A document read can fail after its source listed fine (a remote file, an
// MCP child that died). Adapters record that in health(); downgrade the row
// so coverage never says "ok" over a read that failed.
function afterReads(session, rows) {
  const byName = new Map(session.sources.map((source) => [source.name, source]));
  return rows.map((row) => {
    if (row.status === "unavailable") return row;
    const failure = byName.has(row.name) ? healthFailure(byName.get(row.name)) : null;
    return failure ? { ...row, status: "partial", reason: [row.reason, `a read failed: ${failure}`].filter(Boolean).join("; ") } : row;
  });
}

// A single-concept read touches one file per layer, so it does not walk: a
// local layer only has to exist, and a remote layer reports a failure through
// health() after the read.
async function probeSourcesByReach(session) {
  const rows = await Promise.all(session.sources.map(async (source) => {
    const kind = session.kinds.get(source.name) ?? source.quarantinedKind ?? null;
    const layer = session.runtime.selection.layers.find((candidate) => candidate.name === source.name);
    if (!layer) return { name: source.name, kind, status: "unavailable", reason: "The layer could not be built." };
    if (LOCAL_KINDS.has(kind)) {
      const root = path.resolve(session.runtime.manifestDir, layer.path);
      try {
        if (!(await fsp.stat(root)).isDirectory()) return { name: source.name, kind, status: "unavailable", reason: `Not a folder: ${root}` };
      } catch {
        return { name: source.name, kind, status: "unavailable", reason: `Layer folder no longer exists: ${root}` };
      }
    }
    const failure = healthFailure(source);
    return failure ? { name: source.name, kind, status: "unavailable", reason: failure } : { name: source.name, kind, status: "ok" };
  }));
  return [...rows, ...quarantinedRows(session.runtime)];
}

export function coverageFrom(rows) {
  const degraded = rows.filter((row) => row.status !== "ok");
  return {
    complete: degraded.length === 0,
    sources: rows,
    degraded: degraded.map((row) => ({ source: row.name, kind: row.kind, status: row.status, reason: row.reason })),
  };
}

function notFound(id) {
  return new ControlError("NOT_FOUND", `Concept not found in any source: ${id}`, { status: 404, detail: { conceptId: id } });
}

// Recorded context resolutions and their rule blocks, applied the way
// /api/resolve applies them. coverageComplete gates whether a recorded
// choice may apply at all, so it must describe every source.
async function applyRecorded(session, resolved, { coverageComplete }) {
  const { manifestPath } = session.runtime;
  const state = await createContextResolutionStore(manifestPath, { profileId: session.profileId }).read();
  const rules = await effectiveDiscrepancyRules(
    createDiscrepancyRuleStore(manifestPath, { profileId: session.profileId }),
    session.liveLayer?.root ?? null,
  );
  return applyContextResolutions(resolved, state, {
    profileId: session.profileId,
    manifestFingerprint: contextManifestFingerprint(session.runtime.runtimeManifest),
    coverageComplete,
    blockedKeys: blockedContextResolutionKeys([resolved], rules),
  });
}

async function hasRecordedResolutions(session) {
  const state = await createContextResolutionStore(session.runtime.manifestPath, { profileId: session.profileId }).read();
  return state.decisions.length > 0;
}

export async function listConceptsOperation({ type = null, ...scope }) {
  return withReadSession(scope, async (session) => {
    const { rows, layers } = await listSources(session);
    const concepts = await listConcepts(layers, { type: type ?? undefined });
    session.signal?.throwIfAborted();
    return { data: concepts, coverage: coverageFrom(afterReads(session, rows)) };
  });
}

// The answer /api/search gives: same store, same scorer, same filters. A
// query with no searchable token finds nothing rather than failing, as the
// HTTP route does.
export async function searchConceptsOperation({ query, limit = 10, source = null, type = null, ...scope }) {
  if (typeof query !== "string" || !query.trim()) throw new ControlError("INVALID_INPUT", "Provide a search query.", { status: 400 });
  if (!Number.isInteger(limit) || limit <= 0) throw new ControlError("INVALID_INPUT", "--limit must be a positive integer.", { status: 400 });
  const cappedLimit = Math.min(limit, SEARCH_LIMIT_MAX);
  return withReadSession(scope, async (session) => {
    const { rows, layers } = await listSources(session);
    if (tokenizeQuery(query).length === 0) return { data: { hits: [] }, coverage: coverageFrom(rows) };
    // The same on-disk store MCP and the service keep beside the manifest,
    // so a second search reads nothing it already analyzed.
    const dir = path.join(session.runtime.manifestDir, ".cache", "index");
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the store falls back to memory */ }
    const retrieval = createRetainedSearch(layers, {
      file: path.join(dir, `search.v1.${session.profileId}.sqlite`),
      sourceBudgetMs: session.settings.sourceBudgetMs,
      identities: new Map(session.runtime.selection.layers.map((layer) => [layer.name, layerIdentity(layer)])),
    });
    const stop = () => retrieval.close();
    session.signal?.addEventListener("abort", stop, { once: true });
    try {
      const { hits } = await retrieval.search({ query, limit: cappedLimit, source: source ?? undefined, type: type ?? undefined });
      session.signal?.throwIfAborted();
      return { data: { hits }, coverage: coverageFrom(afterReads(session, rows)) };
    } finally {
      session.signal?.removeEventListener("abort", stop);
      retrieval.close();
    }
  });
}

// The answer /api/resolve gives, plus the markdown `read_file` renders.
export async function readConceptOperation({ conceptId, ...scope }) {
  const id = normalizeId(conceptId);
  if (!id) throw new ControlError("INVALID_INPUT", "Provide a concept id.", { status: 400 });
  return withReadSession(scope, async (session) => {
    const resolved = await resolveConcept(id, session.sources);
    session.signal?.throwIfAborted();
    // Reach first, then health: a remote failure surfaces during the read.
    let rows = await probeSourcesByReach(session);
    if (!resolved) throw notFound(id);
    decorateResolvedDispositions(resolved, await createConflictResolutionLog(session.runtime.manifestPath, { profileId: session.profileId }).list());
    // A recorded choice may apply only when every document was seen, which
    // needs the walk. Without recorded choices the cheap probe is enough.
    if (await hasRecordedResolutions(session)) rows = (await listSources(session)).rows;
    const coverage = coverageFrom(rows);
    const data = await applyRecorded(session, resolved, { coverageComplete: coverage.complete });
    return { data, coverage, markdown: assembleMarkdown(data, { retentionDays: session.liveLayer?.retentionDays ?? 14 }) };
  });
}

// The answer MCP `get_links` gives.
export async function conceptLinksOperation({ conceptId, ...scope }) {
  const id = normalizeId(conceptId);
  if (!id) throw new ControlError("INVALID_INPUT", "Provide a concept id.", { status: 400 });
  return withReadSession(scope, async (session) => {
    const { rows, layers } = await listSources(session);
    const resolved = await resolveConcept(id, layers);
    if (!resolved) throw notFound(id);
    const applied = await applyRecorded(session, resolved, { coverageComplete: coverageFrom(rows).complete });
    const data = await getLinks(layers, id, { resolve: async () => applied });
    session.signal?.throwIfAborted();
    return { data, coverage: coverageFrom(afterReads(session, rows)) };
  });
}

function layerFilesError(error) {
  if (error instanceof ControlError || !error?.status) return error;
  if (error.status === 403) return new ControlError("PATH_OUTSIDE_LAYER", error.message, { status: 403 });
  if (error.status === 404) return new ControlError("NOT_FOUND", error.message, { status: 404 });
  if (error.status >= 400 && error.status < 500) return new ControlError("INVALID_INPUT", error.message, { status: error.status });
  return error;
}

function fileRoots(runtime) {
  return layerRootMap(runtime.runtimeManifest, runtime.manifestDir);
}

// The answer /api/files gives. Config-only: no adapter opens.
export async function listFilesOperation(scope) {
  const runtime = loadReadRuntime(scope);
  const data = await listFilesApi(fileRoots(runtime), walkLimitsFrom(resolveSettings(runtime.runtimeManifest)));
  const rows = data.layers.map((layer) => {
    if (layer.error) return { name: layer.layer, kind: layer.kind, status: "unavailable", reason: layer.error };
    if (layer.truncated) return { name: layer.layer, kind: layer.kind, status: "partial", reason: `listed only the first ${layer.fileCount} files` };
    return { name: layer.layer, kind: layer.kind, status: "ok" };
  });
  return { data, coverage: coverageFrom([...rows, ...quarantinedRows(runtime)]) };
}

// The answer /api/file gives, inside the same layer-root sandbox.
export async function readFileOperation({ filePath, ...scope }) {
  // "<layer>//x" would resolve as an absolute path and read as a sandbox
  // escape; it is a malformed path, so say that instead.
  if (typeof filePath !== "string" || /(^|\/)(\/|$)/.test(filePath.replace(/\\/g, "/"))) {
    throw new ControlError("INVALID_INPUT", `Give the path as <layer>/<relative path> with no empty segments: ${filePath}`, { status: 400 });
  }
  const runtime = loadReadRuntime(scope);
  try {
    return { data: await readFileApi(filePath, fileRoots(runtime)) };
  } catch (error) {
    throw layerFilesError(error);
  }
}
