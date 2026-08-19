// Discrepancy control operations — the shared decision, rule, priority, and
// recovery machinery behind /api/discrepancies, /api/discrepancy-decisions,
// /api/discrepancy-rules and the CLI's `discrepancy` family
// (specs/contextcake-control-plane/spec.md §5.8, specs/contextcake-discrepancy-
// center/spec.md). The HTTP service is a parsing shim over these; every guard,
// refusal message, and journal transition lives here exactly once.
//
// Capabilities are injected, never reached for: the corpus comes from the host's
// background index (`corpus`), file roots and the selected layer stack come from
// the host's manifest view, git mutations against the live team layer arrive as
// `git: { commitPathsWithMutation, push }` (git-core.mjs), and source-content
// writes tell the host through `onWritten` so its index can re-read.
//
// The projection — buildDiscrepancies over the corpus plus this profile's
// decisions, rules, and priorities — is memoized HERE, in one place, keyed on
// what it reads: `corpusKey | sourceHealthSig | sidecarRevision`. Every reader
// (the list, compact, summary, and detail routes; the decision guard; the
// automatic-rules job) answers from the same memo, so a Discrepancy Center at
// 1,500 rows costs one build per change instead of one per request. See
// docs/architecture/notes/discrepancy-projection.md.

import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  stageSectionTransaction, stageFrontmatterTransaction, stageFileCreationTransaction, resolveLayerFile,
} from "../layer-files.mjs";
import {
  buildDiscrepancies, compactDiscrepancy, filterDiscrepancies, summarizeDiscrepancies,
  rewriteLinkTarget, removeLink,
} from "../discrepancies.mjs";
import { parseRuleDocument, serializeRuleDocument, suggestDiscrepancyRules } from "../discrepancy-rules.mjs";
import { normalizeConceptId } from "../sources/okf-local.mjs";
import { resolveLiveLayer } from "../sources/git-sync.mjs";
import { withManifestLockAsync } from "../manifest.mjs";
import { realpathLenient } from "../http-util.mjs";
import { ControlError } from "./errors.mjs";

const TEAM_RULES_RELATIVE = ".contextcake/discrepancy-rules.json";
// The three link actions apply to broken links only; the other three never
// apply to them (a broken link has one contribution — nothing to choose or
// compose). applyDecision enforces both directions.
const LINK_ACTIONS = new Set(["rewrite_link", "unlink", "create_stub"]);
const ACTIONS = new Set(["choose_contribution", "compose", "acknowledge", ...LINK_ACTIONS]);
// target_missing is broken-link-shaped: acknowledging why a link target will
// never resolve (the concept was retired, renamed elsewhere, etc.) needs a
// reason distinct from a genuine scoped disagreement.
const ACKNOWLEDGE_REASONS = new Set(["different_scopes", "temporary_migration", "source_specific_authority", "target_missing", "other"]);
// One batch request: enough for "rewrite all 412 links to X" in one click,
// bounded so one HTTP request cannot hold the manifest lock across an
// unbounded run of git commits. The automatic-rules job applies at most this
// many per pass for the same reason; the host re-runs it after the pass the
// writes trigger, and the queue converges.
const BATCH_LIMIT = 500;
// How long one batch may keep applying while it holds the manifest lock —
// under MANIFEST_LOCK_TIMEOUT_MS (15s) with room for a waiter that arrived
// just before the batch took the lock. Items past it come back
// BATCH_TIME_BUDGET (not attempted) for the caller to resubmit.
const BATCH_TIME_BUDGET_MS = 10_000;
const STUB_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/i;
const STUB_TITLE_MAX = 200;
// The compact route's paging ceiling. A client wanting more than this pages;
// nothing else here bounds a full-fields request, which stays what it was.
const QUERY_LIMIT_MAX = 5000;
const PREVIEW_CHARS = 240;
const SUMMARY_TOP_N = 25;
// Idle eviction for the projection memo — it holds every record's contribution
// bodies (corpus-scale strings), so like the service's corpus memo it lives
// only while someone is reading it. Staleness is impossible by construction:
// the key is re-derived from live state on every access.
const PROJECTION_MEMO_TTL_MS = 30_000;

export function createDiscrepancyOperations({
  manifestPath,        // required: the manifest whose lock serializes decisions
  fileRoots,           // () => Map<layerName, { root, kind }> — locally writable layers
  selectedLayers,      // () => layer[] — the profile view of the manifest
  resolutionLog,       // createConflictResolutionLog(...)
  transactionJournal,  // createDiscrepancyTransactionJournal(...)
  ruleStore,           // createDiscrepancyRuleStore(...)
  priorityStore,       // createDiscrepancyPriorityStore(...)
  corpus,              // async (waitMs) => { corpusKey, status: { generation, indexing, indexingSources, sources }, resolved: () => Promise<{ concepts, errors }> }
  readLiveSection = null, // async ({ layer, conceptId, sectionKey }) => { content, text } | null
  onWritten = () => {},   // called after source content changed on disk
  git = null,          // { commitPathsWithMutation, push } from sources/git-core.mjs
  memoTtlMs = PROJECTION_MEMO_TTL_MS,
  batchTimeBudgetMs = BATCH_TIME_BUDGET_MS, // how long one batch may keep applying under the lock
} = {}) {
  if (!manifestPath) throw new Error("createDiscrepancyOperations: manifestPath is required");
  if (typeof corpus !== "function") throw new Error("createDiscrepancyOperations: corpus capability is required");
  const MANIFEST = path.resolve(manifestPath);
  const MANIFEST_DIR = path.dirname(MANIFEST);
  let recovery = null;
  // Decisions, rule approvals, and priority edits serialize on the manifest
  // lock — the same lock the source CRUD takes — so a decision can never
  // interleave with a manifest rewrite or with another decision's re-projection.
  const withManifestLock = (fn) => withManifestLockAsync(MANIFEST, fn);

  // ---- projection memo ---------------------------------------------------------

  let memo = null; // { key, promise, evictTimer }
  // Every write this module performs bumps this counter, and it is part of the
  // memo key beside the sidecar files' size:mtimeMs — so an in-process rewrite
  // that lands the same size in the same millisecond still misses the memo.
  // Cross-process writers (the CLI's second engine) are covered by the stat.
  let writes = 0;
  const noteWrite = () => { writes += 1; };

  async function sidecarRevision() {
    const files = [resolutionLog.file, ruleStore.file, priorityStore.file, liveRuleFile()?.file].filter(Boolean);
    const stamps = await Promise.all(files.map((file) => fsp.stat(file).then((st) => `${st.size}:${st.mtimeMs}`, () => "0")));
    return `${stamps.join(",")}#${writes}`;
  }

  // What the projection reads from the status: the aggregate `indexing` flag
  // (coverageComplete tests it) and, per source row, name, status, error —
  // the three fields healthSummary keeps and coverageComplete tests. Progress
  // fields (loaded/total/phase) deliberately stay out, or an index in flight
  // would miss the memo on every poll. In the service `indexing` is derived
  // from the source statuses, so naming it here costs no extra miss; a host
  // whose flag can move on its own still gets a fresh coverage answer.
  function sourceHealthSig(status) {
    return JSON.stringify([status.indexing === true, status.sources.map((source) => [source.name, source.status, source.error ?? null])]);
  }

  async function buildProjection(c, key) {
    const [{ concepts, errors }, decisions, rules, priorities] = await Promise.all([
      c.resolved(), resolutionLog.list(), effectiveRules(), priorityStore.list(),
    ]);
    const coverageComplete = !c.status.indexing
      && c.status.sources.every((source) => source.status !== "error" && source.status !== "degraded" && source.status !== "indexing");
    const built = buildDiscrepancies(concepts, {
      decisions, rules, priorities, coverageComplete, sourceHealth: c.status.sources,
    });
    let summary = null;
    return {
      discrepancies: built.discrepancies,
      byId: new Map(built.discrepancies.map((item) => [item.id, item])),
      conceptIds: new Set(concepts.map((concept) => concept.id)),
      coverageComplete: built.coverageComplete,
      indexing: c.status.indexing,
      indexingSources: c.status.indexingSources,
      errors,
      // Names this exact projection: two responses carrying the same value
      // were answered from the same build. A hash, not the key itself — the
      // key embeds source names and file stamps.
      revision: createHash("sha256").update(key).digest("hex").slice(0, 16),
      summary: () => (summary ??= summarizeDiscrepancies(built.discrepancies, { topN: SUMMARY_TOP_N })),
    };
  }

  /**
   * The memoized projection. `waitMs` is forwarded to the corpus provider
   * (the service's `?wait=`); `generation` is read live so a memo hit still
   * names the status generation the caller would see on /api/status.
   */
  async function project(waitMs = 0) {
    const c = await corpus(waitMs);
    const key = `${c.corpusKey}|${sourceHealthSig(c.status)}|${await sidecarRevision()}`;
    if (!memo || memo.key !== key) {
      if (memo) clearTimeout(memo.evictTimer);
      let promise;
      promise = buildProjection(c, key).catch((error) => {
        if (memo?.promise === promise) { clearTimeout(memo.evictTimer); memo = null; }
        throw error;
      });
      memo = { key, promise, evictTimer: null };
    }
    clearTimeout(memo.evictTimer);
    memo.evictTimer = setTimeout(() => { memo = null; }, memoTtlMs);
    memo.evictTimer.unref?.();
    const value = await memo.promise;
    return { ...value, generation: c.status.generation };
  }

  // The bare GET /api/discrepancies envelope — key order and every field
  // exactly what it was before the memo existed.
  async function list(waitMs = 0) {
    const p = await project(waitMs);
    return {
      discrepancies: p.discrepancies, coverageComplete: p.coverageComplete,
      indexing: p.indexing, indexingSources: p.indexingSources, errors: p.errors, generation: p.generation,
    };
  }

  function parseCount(raw, name, { max = null } = {}) {
    if (raw === undefined || raw === null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new ControlError(`${name.toUpperCase()}_INVALID`, `${name} must be a non-negative integer`, { status: 400 });
    return max === null ? n : Math.min(n, max);
  }

  // The filtered / paged / compact list, with the summary in the same round
  // trip so a client never needs the full list to draw its header.
  async function query(waitMs = 0, params = {}) {
    const fields = params.fields ?? "full";
    if (fields !== "full" && fields !== "compact") throw new ControlError("FIELDS_INVALID", "fields must be full or compact", { status: 400 });
    const limit = parseCount(params.limit, "limit", { max: QUERY_LIMIT_MAX });
    const offset = parseCount(params.offset, "offset") ?? 0;
    const p = await project(waitMs);
    const filtered = filterDiscrepancies(p.discrepancies, {
      status: params.status, kind: params.kind, conceptId: params.conceptId, target: params.target,
      source: params.source, owner: params.owner, conceptType: params.conceptType,
    });
    const page = filtered.slice(offset, limit === null ? undefined : offset + limit);
    return {
      discrepancies: fields === "compact" ? page.map((item) => compactDiscrepancy(item, { previewChars: PREVIEW_CHARS })) : page,
      coverageComplete: p.coverageComplete, indexing: p.indexing, indexingSources: p.indexingSources, errors: p.errors, generation: p.generation,
      summary: p.summary(), total: p.discrepancies.length, filtered: filtered.length, offset, limit, projectionRevision: p.revision,
    };
  }

  async function detail(waitMs = 0, id) {
    const p = await project(waitMs);
    return { discrepancy: p.byId.get(id) ?? null, generation: p.generation, projectionRevision: p.revision };
  }

  async function summary(waitMs = 0) {
    const p = await project(waitMs);
    return {
      summary: p.summary(), coverageComplete: p.coverageComplete, indexing: p.indexing, indexingSources: p.indexingSources,
      generation: p.generation, projectionRevision: p.revision,
    };
  }

  function close() {
    if (memo) clearTimeout(memo.evictTimer);
    memo = null;
  }

  // ---- live team layer -------------------------------------------------------

  function liveLayer() {
    return resolveLiveLayer(selectedLayers(), MANIFEST_DIR);
  }

  function liveRuleFile() {
    const live = liveLayer();
    return live ? { ...live, relative: TEAM_RULES_RELATIVE, file: path.join(live.root, TEAM_RULES_RELATIVE) } : null;
  }

  // ---- rules -------------------------------------------------------------------

  async function teamRules() {
    const live = liveRuleFile();
    if (!live) return [];
    try { return parseRuleDocument(await fsp.readFile(live.file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return [];
      throw new ControlError("TEAM_RULES_UNREADABLE", `Team discrepancy rules are unreadable: ${error.message}`, { status: 409 });
    }
  }

  async function effectiveRules() {
    const [local, team] = await Promise.all([ruleStore.list(), teamRules()]);
    const localById = new Map(local.map((rule) => [rule.id, rule]));
    return [
      ...team.map((rule) => localById.get(rule.id) ?? rule),
      ...local.filter((rule) => !team.some((shared) => shared.id === rule.id)),
    ];
  }

  async function rulesView() {
    const rules = await effectiveRules();
    const decisions = await resolutionLog.list();
    return { rules, suggestions: suggestDiscrepancyRules(decisions, rules) };
  }

  // Approve a suggestion into a local rule. Evidence is re-evaluated inside the
  // same lock decisions use so a reversal cannot race approval after the
  // preview was shown.
  function approveSuggestion(suggestionId) {
    return withManifestLock(async () => {
      const available = await rulesView();
      const suggestion = available.suggestions.find((item) => item.id === suggestionId);
      if (!suggestion) throw new ControlError("SUGGESTION_UNSUPPORTED", "That rule suggestion is no longer supported by three consistent decisions", { status: 409 });
      const rule = await ruleStore.create(suggestion);
      noteWrite();
      return rule;
    });
  }

  function patchRule(id, changes) {
    return withManifestLock(async () => {
      try {
        try { return await ruleStore.patch(id, changes); }
        catch (error) {
          if (error.status !== 404) throw new ControlError("RULE_INVALID", error.message, { status: error.status ?? 400 });
          const team = (await teamRules()).find((rule) => rule.id === id);
          if (!team) throw new ControlError("RULE_NOT_FOUND", error.message, { status: 404 });
          // Enabling a promoted rule automatically is deliberately a per-profile,
          // local decision. The shared file itself remains recommendation-only.
          return await ruleStore.setLocalOverride(team, changes);
        }
      } finally { noteWrite(); }
    });
  }

  async function promoteRule(body) {
    const rule = (await ruleStore.list()).find((item) => item.id === body.id);
    if (!rule) throw new ControlError("RULE_NOT_FOUND", "Local discrepancy rule not found", { status: 404 });
    const live = liveRuleFile();
    if (!live) throw new ControlError("NO_LIVE_LAYER", "This profile has no writable live team layer", { status: 409 });
    if (!git) throw new ControlError("GIT_UNAVAILABLE", "This host cannot commit into the live team layer.", { status: 500 });
    const preview = {
      id: rule.id, scope: "team", mode: "recommend", enabled: true,
      match: rule.match, action: rule.action, evidenceDecisionIds: rule.evidenceDecisionIds,
      createdAt: rule.createdAt, promotedAt: new Date().toISOString(),
    };
    if (body.confirm !== true) return { requiresConfirmation: true, preview, target: `${live.name}/${live.relative}` };
    let previous = null;
    try { previous = await fsp.readFile(live.file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const current = previous ? parseRuleDocument(previous.toString("utf8")) : [];
    const next = [...current.filter((item) => item.id !== preview.id), preview];
    const nextText = serializeRuleDocument(next);
    await git.commitPathsWithMutation(live.root, [live.relative], `chore: promote discrepancy rule ${rule.id}`, {
      mutate: async () => {
        await fsp.mkdir(path.dirname(live.file), { recursive: true });
        await fsp.writeFile(live.file, nextText, { encoding: "utf8", mode: 0o600 });
      },
      rollback: async () => {
        if (previous) await fsp.writeFile(live.file, previous);
        else await fsp.unlink(live.file).catch(() => {});
      },
      author: live.profileName,
    });
    noteWrite();
    const pushed = await git.push(live.root);
    return { promoted: true, rule: preview, pushed: pushed.pushed === true, queued: pushed.queued === true };
  }

  // ---- priorities ---------------------------------------------------------------

  async function setPriority(id, priority) {
    try { return await withManifestLock(() => priorityStore.set(id, priority)); }
    catch (error) { throw new ControlError("PRIORITY_INVALID", error.message, { status: 400 }); }
    finally { noteWrite(); }
  }

  // ---- recovery -----------------------------------------------------------------

  // Recovery runs once per process, before the first decision, and is retried
  // if it failed. A journal transaction left `prepared` by a crash is restored
  // from its backups unless the decision log proves it committed.
  function ensureRecovery() {
    if (!recovery) {
      const roots = [...fileRoots().values()].map((entry) => entry.root);
      recovery = resolutionLog.list().then((decisions) => transactionJournal.recover(
        roots,
        decisions.filter((row) => row.transactionState === "committed").map((row) => row.transactionId).filter(Boolean),
        { onRestored: commitRestoredLivePaths },
      )).catch((error) => {
        recovery = null;
        throw error;
      });
    }
    return recovery;
  }

  // ---- decisions ------------------------------------------------------------------

  // Parse-level checks shared by the single route and every batch item: the
  // shape of the request, before any projection is consulted.
  function validateRequestShape(body, methodOverride) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ControlError("ACTION_INVALID", "Each decision must be an object", { status: 400 });
    const { discrepancyId, action, ruleId } = body;
    if (ruleId !== undefined && methodOverride !== "automatic") {
      throw new ControlError("RULE_AUTHORITY", "Rule authority is reserved for approved background actions", { status: 400 });
    }
    if (typeof discrepancyId !== "string" || !discrepancyId) throw new ControlError("DISCREPANCY_ID_REQUIRED", "Provide discrepancyId", { status: 400 });
    if (!ACTIONS.has(action)) throw new ControlError("ACTION_INVALID", "Unsupported discrepancy action", { status: 400 });
  }

  // Look one request up in a settled projection and check its revision. A
  // `resolved` row is the audit trail of a past decision (rebuilt from the
  // log, no live section behind it), not something to decide again — its
  // revision is the one the decision recorded, so it would otherwise pass
  // the STALE check and reach a write path with no effective source.
  function locateInProjection(payload, body) {
    const discrepancy = payload.byId.get(body.discrepancyId);
    if (!discrepancy || discrepancy.status === "resolved") {
      throw new ControlError("NOT_OPEN", "This discrepancy is no longer open. Reload before deciding it.", { status: 409 });
    }
    if (body.revision !== discrepancy.revision) {
      throw new ControlError("STALE", "This discrepancy changed after you opened it. Reload before deciding it.", { status: 409 });
    }
    return discrepancy;
  }

  // A file watcher may have invalidated the index between the review GET and
  // this mutation. Decisions must re-resolve against a settled generation;
  // treating an in-flight empty snapshot as "no longer open" is both
  // misleading and can make a valid current-revision decision impossible.
  async function settledProjection() {
    const payload = await project(15_000);
    if (!payload.coverageComplete || payload.indexing) {
      throw new ControlError("COVERAGE_INCOMPLETE", "Sources are still indexing. Wait for settled coverage before deciding.", { status: 409 });
    }
    return payload;
  }

  // The locked entry point: parse-level validation, then re-project against a
  // settled generation and check the caller's revision before applying.
  function decide(body, { methodOverride = null, reasonOverride = null } = {}) {
    return withManifestLock(() => decideUnlocked(body, { methodOverride, reasonOverride }));
  }

  async function decideUnlocked(body, { methodOverride = null, reasonOverride = null } = {}) {
    await ensureRecovery();
    validateRequestShape(body, methodOverride);
    const payload = await settledProjection();
    const discrepancy = locateInProjection(payload, body);
    return applyDecision(discrepancy, body, { methodOverride, reasonOverride, projection: payload });
  }

  /**
   * Apply one decision to a discrepancy the caller already projected. The
   * caller holds the manifest lock; this never takes it.
   *
   * - `push: false` lets a caller applying several decisions (a batch, the
   *   automatic-rules job) push the live layer once at the end.
   * - `notify: false` likewise defers `onWritten()` to the caller.
   * - `dryRun: true` runs every check a real apply would — writability, the
   *   live read, the rewrite target's existence, a stub's collision, the
   *   staged transaction's own preconditions — and answers `{ ok, dryRun,
   *   wouldWrite: [{ layer, path }] }` without touching a file or the log.
   * - `projection` is the settled projection the discrepancy came from; the
   *   link actions read `conceptIds` from it (a rewrite may only point at a
   *   concept that exists).
   */
  /**
   * Every check on a decision that needs only the request, the projected
   * record, and the roots — no disk read, no lock. Shared by applyDecision
   * (which runs it again, cheaply) and by the batch's first phase, so a
   * malformed item — wrong kind for the action, missing reason, unknown
   * source, a rewrite to a concept that does not exist, a stub with no layer —
   * is reported before any sibling is applied. What stays in the apply path is
   * what genuinely needs the disk: the live section read (LINK_GONE), a stub's
   * collision (TARGET_EXISTS), and the staged transaction's own preconditions.
   * Returns the derived values the apply path reuses.
   */
  function validateDecisionParams(discrepancy, body, { projection = null } = {}) {
    const { action, selectedSource, content, reasonCode } = body;
    const originalKind = discrepancy.originalKind ?? discrepancy.kind;
    // The kind gate, both ways: a broken link has exactly one contribution (the
    // effective section that links out), so there is no alternative answer to
    // choose or compose; and only a broken link has a link to rewrite, remove,
    // or a missing concept to create.
    if (originalKind === "broken_link" && (action === "choose_contribution" || action === "compose")) {
      throw new ControlError("BROKEN_LINK_NOT_WRITABLE", "A broken link has no alternative answer to choose or compose. Rewrite the link, remove it, create the missing concept, or acknowledge.", { status: 409 });
    }
    if (originalKind !== "broken_link" && LINK_ACTIONS.has(action)) {
      throw new ControlError("ACTION_INVALID", `${action} applies only to a broken link`, { status: 400 });
    }
    if (action === "acknowledge" && !ACKNOWLEDGE_REASONS.has(reasonCode)) throw new ControlError("REASON_REQUIRED", "Choose why this scoped difference should remain", { status: 400 });
    const chosen = action === "choose_contribution"
      ? discrepancy.contributions.find((item) => item.source === selectedSource)
      : null;
    if (action === "choose_contribution" && !chosen) throw new ControlError("SOURCE_INVALID", "Choose one of this discrepancy's contributing sources", { status: 400 });
    if (action === "compose" && typeof content !== "string") throw new ControlError("CONTENT_REQUIRED", "Provide reconciled content", { status: 400 });
    // renderScalar's scalar branch would rewrite a YAML list OR map as a
    // quoted string (a plain object stringifies to "[object Object]" through
    // the same String(value) call an array would otherwise skip) — silently
    // downgrading the field's type in every writable layer. Compose only ever
    // produces a string, so a structured-value field has no safe reconciled
    // answer to write.
    if (originalKind === "frontmatter_value" && action === "compose"
      && discrepancy.contributions.some((item) => typeof item.value === "object" && item.value !== null)) {
      throw new ControlError("COMPOSE_STRUCTURED", "This field holds a structured value (list or map); compose isn't available for it — use \"Use this answer everywhere\" or edit the file directly.", { status: 400 });
    }
    const roots = fileRoots();
    const out = { originalKind, chosen, roots, writableSources: [], newTarget: null, stub: null };
    if (action === "choose_contribution" || action === "compose") {
      out.writableSources = discrepancy.contributions.map((item) => item.source).filter((source) => roots.has(source));
      if (out.writableSources.length === 0) throw new ControlError("SOURCE_NOT_WRITABLE", "None of this discrepancy's contributors is locally writable. Open the source files to resolve it.", { status: 409 });
    }
    if (action === "rewrite_link") {
      if (typeof body.newTarget !== "string" || !body.newTarget.trim()) throw new ControlError("NEW_TARGET_REQUIRED", "Provide newTarget: the concept id the link should point at", { status: 400 });
      try { out.newTarget = normalizeConceptId(body.newTarget.trim()); }
      catch { throw new ControlError("NEW_TARGET_INVALID", `"${body.newTarget}" is not a valid concept id`, { status: 400 }); }
      if (!projection?.conceptIds?.has(out.newTarget)) {
        throw new ControlError("LINK_TARGET_MISSING", `${out.newTarget} does not exist in the selected sources. Point the link at a concept that exists, or create it first.`, { status: 409 });
      }
    }
    if (action === "rewrite_link" || action === "unlink") {
      if (!roots.has(discrepancy.effectiveSource)) {
        throw new ControlError("SOURCE_NOT_WRITABLE", `The section that carries this link (${discrepancy.effectiveSource}) is not locally writable. Open the source file to repair it, or acknowledge.`, { status: 409 });
      }
    }
    if (action === "create_stub") {
      const layer = body.layer;
      if (typeof layer !== "string" || !layer) throw new ControlError("LAYER_REQUIRED", "Provide layer: the writable layer to create the missing concept in", { status: 400 });
      if (!roots.has(layer)) throw new ControlError("SOURCE_NOT_WRITABLE", `${layer} is not a locally writable layer (only okf-local bundles and files folders are). Choose another layer.`, { status: 409 });
      const target = discrepancy.target;
      let stubId = null;
      try { stubId = normalizeConceptId(target); } catch { stubId = null; }
      // A stub has to be a file the indexer will read back, or the link stays
      // broken while the decision says resolved: no empty or dot-prefixed
      // segment (a trailing `/`, a hidden file), no node_modules — the walk
      // skips those.
      if (!stubId || stubId.split("/").some((segment) => !segment || segment.startsWith(".") || segment === "node_modules")) {
        throw new ControlError("TARGET_INVALID", `"${target}" cannot name a concept file in ${layer}.`, { status: 400 });
      }
      const rel = `${stubId}.md`;
      let file;
      try { file = resolveLayerFile(`${layer}/${rel}`, roots); }
      catch (error) { throw new ControlError("TARGET_INVALID", `"${target}" cannot name a concept file in ${layer}: ${error.message}`, { status: 400 }); }
      out.stub = { layer, stubId, rel, abs: file.abs, title: stubTitle(body.title, stubId), type: stubType(body.type) };
    }
    return out;
  }

  async function applyDecision(discrepancy, body, {
    methodOverride = null, reasonOverride = null, push: pushNow = true, notify = true, dryRun = false, projection = null,
  } = {}) {
    await ensureRecovery();
    const { action, selectedSource, content, reasonCode, note, ruleId } = body;
    if (ruleId !== undefined && methodOverride !== "automatic") {
      throw new ControlError("RULE_AUTHORITY", "Rule authority is reserved for approved background actions", { status: 400 });
    }
    if (!discrepancy || body.revision !== discrepancy.revision) {
      throw new ControlError("STALE", "This discrepancy changed after you opened it. Reload before deciding it.", { status: 409 });
    }
    const params = validateDecisionParams(discrepancy, body, { projection });
    const { originalKind, chosen } = params;

    const transactionId = randomUUID();
    const now = new Date().toISOString();
    const previousDecision = discrepancy.history?.at(-1) ?? null;
    const decision = {
      schemaVersion: 2,
      id: randomUUID(), discrepancyId: discrepancy.id,
      ...(discrepancy.legacyId ? { conflictId: discrepancy.legacyId } : {}),
      conceptId: discrepancy.conceptId, title: discrepancy.conceptTitle,
      discrepancyKind: originalKind,
      // A broken link's key IS its section key; recording it (and the target)
      // is what lets the resolved-history row and the compact list keep naming
      // where the link was and what it pointed at after the record is gone.
      sectionKey: originalKind === "section_content" || originalKind === "broken_link" ? discrepancy.key : undefined,
      sectionHeading: discrepancy.label, fieldKey: originalKind === "frontmatter_value" ? discrepancy.key : undefined,
      ...(originalKind === "broken_link" ? { linkTarget: discrepancy.target } : {}),
      revision: discrepancy.revision, action,
      conceptType: discrepancy.conceptType, owner: discrepancy.owner, priority: discrepancy.priority,
      contributions: discrepancy.contributions.map((item) => ({ layer: item.source, level: item.level, content: item.value, updated: item.updated })),
      contributorFingerprints: discrepancy.contributions.map((item) => ({ source: item.source, fingerprint: item.fingerprint })),
      chosen: chosen ? { layer: chosen.source, level: chosen.level, content: chosen.value, updated: chosen.updated } : null,
      method: methodOverride ?? "manual", actor: "local-user", decidedAt: now,
      reason: reasonOverride ?? (action === "acknowledge" ? reasonCode : action === "compose" ? "You wrote a reconciled answer." : `You chose the ${selectedSource} answer.`),
      ...(reasonCode ? { reasonCode } : {}), ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}),
      ...(ruleId ? { ruleId } : {}), transactionId,
      ...(previousDecision ? { supersedes: previousDecision.id, supersededDecisionId: previousDecision.id } : {}),
      ...(action === "compose" ? { reconciledContent: content } : {}),
      learningPattern: {
        kind: originalKind, conceptType: discrepancy.conceptType, key: discrepancy.key,
        sources: discrepancy.contributions.map((item) => item.source).sort(),
        // A broken link's identity IS the missing target — unlike section_content/
        // frontmatter_value, where the same key across many concepts of a type is a
        // meaningful pattern, generalizing a broken-link rule across targets would
        // auto-acknowledge a future, unrelated dangling link (e.g. a typo) that was
        // never reviewed. Scope broken_link evidence to the exact target.
        ...(originalKind === "broken_link" ? { target: discrepancy.target } : {}),
      },
      ruleAction: action === "choose_contribution"
        ? { type: "prefer_source", source: selectedSource }
        : action === "acknowledge" ? { type: "acknowledge", reasonCode } : null,
    };

    if (action === "acknowledge") {
      if (dryRun) return { ok: true, dryRun: true, wouldWrite: [] };
      decision.transactionState = "not_required";
      decision.writtenTargets = [];
      const saved = await resolutionLog.append(decision);
      noteWrite();
      return { ok: true, decision: saved, written: [] };
    }
    if (originalKind === "broken_link") {
      return applyLinkDecision(discrepancy, body, decision, params, { transactionId, pushNow, notify, dryRun, reasonOverride });
    }

    const value = action === "compose" ? content : chosen.value;
    const { roots, writableSources } = params;
    const stage = (txId, options) => originalKind === "frontmatter_value"
      ? stageFrontmatterTransaction(JSON.stringify({
        conceptId: discrepancy.conceptId, key: discrepancy.key,
        layers: writableSources, value,
        expectedValues: Object.fromEntries(discrepancy.contributions.map((item) => [item.source, item.value])),
      }), roots, txId, options)
      : stageSectionTransaction(JSON.stringify({
        conceptId: discrepancy.conceptId, sectionKey: discrepancy.key,
        layers: writableSources, content: value,
        expectedContent: Object.fromEntries(discrepancy.contributions.map((item) => [item.source, item.value])), requireAll: true,
      }), roots, txId, options);
    if (dryRun) return probeWrite(stage);
    const { saved, written, git: gitResult } = await commitDecisionWrite({
      transactionId, conceptId: discrepancy.conceptId, layers: writableSources, stage, decision, pushNow, notify,
      message: `chore(contextcake): resolve ${originalKind} ${discrepancy.conceptId}#${discrepancy.key} (${action})`,
    });
    return { ok: true, decision: saved, written, ...(gitResult ? { git: gitResult } : {}) };
  }

  // A dry run's answer for a content-changing action: run the stage with
  // `probe: true` (every precondition, no bytes) and report the targets.
  async function probeWrite(stage) {
    const probed = await stage("dry-run", { probe: true });
    return { ok: true, dryRun: true, wouldWrite: probed.targets.map((target) => ({ layer: target.layer, path: target.path, ...(target.created ? { created: true } : {}) })) };
  }

  /**
   * The three broken-link actions. `rewrite_link` and `unlink` edit exactly
   * one section: the effective contributor's — the section the record shows,
   * the only contribution a broken_link record has. A dissenting copy of the
   * section in a lower layer is not a discrepancy today (the resolver's
   * dissent is section-level, and the link there is not effective); if
   * precedence later flips, the copy surfaces as its own broken_link with the
   * same candidates. The section is read LIVE, not from the projection: two
   * rewrites into one section in one batch must both see the previous one.
   * `create_stub` writes a new concept file into a writable layer through the
   * create-mode transaction; every link to that target then resolves, and the
   * created concept is the audit trail for the ones this decision did not
   * itself record.
   */
  async function applyLinkDecision(discrepancy, body, decision, params, { transactionId, pushNow, notify, dryRun, reasonOverride }) {
    const { action } = body;
    const { roots, newTarget, stub } = params;
    const conceptId = discrepancy.conceptId;
    const sectionKey = discrepancy.key;
    const target = discrepancy.target;
    const effectiveSource = discrepancy.effectiveSource;

    if (action === "create_stub") {
      const { layer, stubId, rel, abs, title, type } = stub;
      let exists = true;
      try { await fsp.lstat(abs); } catch (error) { if (error.code === "ENOENT") exists = false; else throw error; }
      if (exists) throw new ControlError("TARGET_EXISTS", `${layer}/${rel} already exists. Reload — this link may already resolve.`, { status: 409 });
      const text = renderStub({ title, type, conceptId });
      const stage = (txId, options) => stageFileCreationTransaction({ layer, rel, text }, roots, txId, options);
      if (dryRun) return probeWrite(stage);
      decision.createdTargets = [{ layer, conceptId: stubId, path: rel }];
      decision.reason = reasonOverride ?? `You created ${stubId} in ${layer}.`;
      decision.ruleAction = null; // deliberately not learnable: creating concepts is never a policy
      const { saved, written, git: gitResult } = await commitDecisionWrite({
        // The concept whose file this transaction writes is the created one.
        transactionId, conceptId: stubId, layers: [layer], stage, decision, pushNow, notify,
        message: `chore(contextcake): create ${stubId} for ${conceptId}#${sectionKey}`,
      });
      return { ok: true, decision: saved, written, ...(gitResult ? { git: gitResult } : {}) };
    }

    if (typeof readLiveSection !== "function") throw new ControlError("LIVE_READ_UNAVAILABLE", "This host cannot read a section live, so it cannot rewrite or remove links.", { status: 500 });
    const live = await readLiveSection({ layer: effectiveSource, conceptId, sectionKey });
    if (!live || typeof live.content !== "string") {
      throw new ControlError("LINK_GONE", `The section that carried this link (${conceptId}#${sectionKey} in ${effectiveSource}) no longer exists. Reload before deciding it.`, { status: 409 });
    }
    const edit = action === "rewrite_link" ? rewriteLinkTarget(live.content, target, newTarget) : removeLink(live.content, target);
    if (edit.replaced === 0) {
      throw new ControlError("LINK_GONE", `The link to ${target} is no longer in ${conceptId}#${sectionKey}. Reload before deciding it.`, { status: 409 });
    }
    const stage = (txId, options) => stageSectionTransaction(JSON.stringify({
      conceptId, sectionKey, layers: [effectiveSource], content: edit.text,
      expectedContent: { [effectiveSource]: live.content }, requireAll: true,
    }), roots, txId, options);
    if (dryRun) return probeWrite(stage);
    if (action === "rewrite_link") {
      decision.newTarget = newTarget;
      decision.reason = reasonOverride ?? `You pointed the link at ${newTarget}.`;
      decision.ruleAction = { type: "rewrite_link", newTarget };
    } else {
      decision.reason = reasonOverride ?? `You removed the link to ${target}.`;
      decision.ruleAction = null; // deliberately not learnable: removing links is never a policy
    }
    const { saved, written, git: gitResult } = await commitDecisionWrite({
      transactionId, conceptId, layers: [effectiveSource], stage, decision, pushNow, notify,
      message: `chore(contextcake): resolve broken_link ${conceptId}#${sectionKey} (${action})`,
    });
    return { ok: true, decision: saved, written, ...(gitResult ? { git: gitResult } : {}) };
  }

  function stubTitle(raw, stubId) {
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== "string") throw new ControlError("STUB_TITLE_INVALID", "title must be a string", { status: 400 });
      const title = raw.replace(/[\r\n]+/g, " ").trim();
      if (!title || title.length > STUB_TITLE_MAX) throw new ControlError("STUB_TITLE_INVALID", `title must be 1–${STUB_TITLE_MAX} characters`, { status: 400 });
      return title;
    }
    // Humanized basename: "deploy-guide" → "Deploy Guide".
    return path.posix.basename(stubId).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim()
      .replace(/(^|\s)(\p{L})/gu, (m, lead, letter) => `${lead}${letter.toUpperCase()}`) || stubId;
  }

  function stubType(raw) {
    if (raw === undefined || raw === null) return "note";
    if (typeof raw !== "string" || !STUB_TYPE_PATTERN.test(raw)) throw new ControlError("STUB_TYPE_INVALID", "type must be a short identifier (letters, digits, - and _)", { status: 400 });
    return raw;
  }

  // The minimal OKF document a stub is: frontmatter the parsers read (type,
  // title, updated), the H1, and a one-line note saying why it exists.
  function renderStub({ title, type, conceptId }) {
    const today = new Date().toISOString().slice(0, 10);
    return `---\ntype: ${type}\ntitle: ${title}\nupdated: ${today}\n---\n\n# ${title}\n\nCreated from ContextCake to satisfy a link from ${conceptId}.\n`;
  }

  /**
   * The shared tail of every decision that changes source content — the
   * discrepancy actions above (including the link actions and a stub's
   * creation) and the legacy "change a past decision" route: stage + journal
   * `prepared`, rename, append the decision, journal `committed`, clean up,
   * tell the host, push. Fills `transactionState`, `writtenTargets`, and
   * `liveLayerCommit` on `decision` before appending it. `conceptId` names the
   * concept whose file the transaction writes — for a stub, the created one.
   *
   * F30: when one of `layers` is the live team layer — a git working tree
   * shared with every teammate's agent — staging AND the rename run inside
   * git-core's repo lock as one pathspec commit; never a bare rename that
   * leaves the clone dirty and the change unpushed. Staging is inside the lock
   * deliberately: the read that backs a target up must not race another
   * process's pull of the same file.
   *
   * `notify: false` and `pushNow: false` defer `onWritten()` and the push to
   * a caller applying several decisions in one request.
   */
  async function commitDecisionWrite({ transactionId, conceptId, layers, message, stage, decision, pushNow = true, notify = true }) {
    const now = new Date().toISOString();
    const live = liveLayer();
    const liveTouched = live !== null && layers.includes(live.name);
    if (liveTouched && !git) throw new ControlError("GIT_UNAVAILABLE", "This host cannot commit into the live team layer.", { status: 500 });
    const liveRel = liveTouched ? [`${conceptId}.md`] : [];
    let staged = null;
    const stageAndJournal = async () => {
      staged = await stage(transactionId);
      await transactionJournal.append({
        id: transactionId, state: "prepared", preparedAt: now,
        targets: staged.targets.map((target) => ({
          path: target.path, staged: target.staged, backup: target.backup, ...(target.created ? { created: true } : {}),
        })),
      });
    };
    let written = null;
    let gitOutcome = null; // { layer, paths, committed }
    let rolledBackUnderLock = false;
    let saved = null;
    try {
      if (liveTouched) {
        const result = await git.commitPathsWithMutation(live.root, liveRel, message, {
          mutate: async () => {
            await stageAndJournal();
            const actual = relativeToLive(live, staged.targets.filter((target) => target.layer === live.name).map((target) => target.path));
            if (actual.length !== 1 || actual[0] !== liveRel[0]) {
              throw new Error(`live layer target resolved to ${JSON.stringify(actual)}, expected ${liveRel[0]}`);
            }
            written = await staged.commit();
          },
          rollback: async () => {
            if (!staged) return;
            await staged.rollback();
            rolledBackUnderLock = true;
          },
          author: live.profileName,
          skipIfClean: true,
        });
        gitOutcome = { layer: live.name, paths: liveRel, committed: result.committed === true };
      } else {
        await stageAndJournal();
        written = await staged.commit();
      }
      decision.transactionState = "committed";
      decision.writtenTargets = staged.targets.map((target) => ({ layer: target.layer, path: target.path, ...(target.created ? { created: true } : {}) }));
      if (gitOutcome?.committed) decision.liveLayerCommit = { layer: gitOutcome.layer, paths: gitOutcome.paths };
      saved = await resolutionLog.append(decision);
      noteWrite();
    } catch (error) {
      // The live layer's lock is held by another ContextCake process: staging
      // runs inside that lock, so nothing was read, backed up, journaled, or
      // renamed — the decision simply did not happen yet.
      if (error.code === "LockBusy") {
        throw new ControlError("LIVE_LAYER_BUSY", "Nothing was changed. The team layer is busy — another ContextCake process holds its lock. Try again in a moment.", { status: 409 });
      }
      // Staging itself refused (a stale expectedContent, a missing file, a
      // too-large document): nothing was journaled or renamed, so the
      // refusal is the answer as it always was.
      if (!staged) throw error;
      if (error.code === "RecoveryRequired" || error.code === "RollbackFailed") {
        await transactionJournal.append({ id: transactionId, state: "recovery_required", failedAt: new Date().toISOString(), error: error.message });
        throw new ControlError("RECOVERY_REQUIRED", `A write could not be rolled back automatically. Recovery is required: ${error.message}`, { status: 500 });
      }
      try {
        if (gitOutcome?.committed) {
          // The git commit landed but the decision never became durable (the
          // log append failed). Restoring the bytes with a bare copy would
          // leave HEAD holding a write the log says never happened, riding
          // the next push — so the restore is itself a commit, under the
          // same lock, exactly as startup recovery would record it.
          await git.commitPathsWithMutation(live.root, liveRel, `chore(contextcake): roll back uncommitted discrepancy transaction ${transactionId}`, {
            mutate: () => staged.rollback(), rollback: async () => {}, author: live.profileName, skipIfClean: true,
          });
        } else if (!rolledBackUnderLock) {
          // git-core already ran the rollback under its lock when the commit
          // failed; anything else (a rename failure) is restored here.
          await staged.rollback();
        }
        await transactionJournal.append({ id: transactionId, state: "rolled_back", rolledBackAt: new Date().toISOString(), error: error.message });
        await staged.cleanup();
      } catch (rollbackError) {
        await transactionJournal.append({ id: transactionId, state: "recovery_required", failedAt: new Date().toISOString(), error: `${error.message}; rollback failed: ${rollbackError.message}` });
        throw new ControlError("RECOVERY_REQUIRED", `A write could not be rolled back automatically. Recovery is required: ${rollbackError.message}`, { status: 500 });
      }
      throw new ControlError("ROLLED_BACK", `Nothing was changed. ${error.message}`, { status: 409 });
    }
    // From here the decision is durable and the files are what the log says
    // they are, so nothing below may roll anything back. A journal or cleanup
    // failure is reported, not fatal: startup recovery reconciles a `prepared`
    // transaction against the committed decision ("decision log confirmed
    // commit") and removes the leftovers.
    try {
      await transactionJournal.append({ id: transactionId, state: "committed", committedAt: new Date().toISOString() });
      await staged.cleanup();
    } catch (error) {
      console.error(`contextcake: decision ${saved.id} committed but its journal could not be finalized (${error.message}); startup recovery will reconcile it`);
    }
    if (notify) onWritten();
    let gitResult = null;
    if (gitOutcome) {
      // Push after the decision is durable, so a slow or offline remote can
      // never leave the journal `prepared`. Never thrown: offline is a queued
      // commit that POST /api/sources/sync lands later.
      gitResult = { ...gitOutcome, ...(gitOutcome.committed && pushNow ? await pushLive(live.root) : { pushed: false, queued: false }) };
    }
    return { saved, written, git: gitResult };
  }

  // Which of `absPaths` sit inside the live layer's root, as the relative
  // paths git wants. Both sides are realpath'd: staged targets already are
  // (assertInsideRoot), and a manifest path through a symlink — every macOS
  // temp dir — would otherwise never match its own files. A created target
  // does not exist yet when this runs; realpathLenient resolves it through
  // its deepest existing ancestor.
  function relativeToLive(live, absPaths) {
    const root = realpathLenient(live.root);
    const out = [];
    for (const abs of absPaths) {
      const rel = path.relative(root, realpathLenient(abs));
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) out.push(rel.split(path.sep).join("/"));
    }
    return out;
  }

  async function pushLive(root) {
    try {
      const result = await git.push(root);
      return { pushed: result.pushed === true, queued: result.queued === true };
    } catch (error) {
      // A push that cannot even take the lock is a queued push, not a failed
      // decision: the commit is local and sync() lands it.
      return { pushed: false, queued: true, error: error.message };
    }
  }

  // The recovery edge of F30: a crash between the git commit and the decision
  // append leaves HEAD holding a write the log never recorded. Startup
  // recovery restores the backups; this commits the restore from inside the
  // journal's restore step so git and the log agree, and a failure here keeps
  // the transaction pending (retried before the next decision) rather than
  // half-recorded.
  async function commitRestoredLivePaths(tx, paths) {
    if (!git) return;
    const live = liveLayer();
    if (!live) return;
    const rel = relativeToLive(live, paths);
    if (rel.length === 0) return;
    await git.commitPathsWithMutation(live.root, rel, `chore(contextcake): roll back uncommitted discrepancy transaction ${tx.id}`, {
      mutate: async () => {}, rollback: async () => {}, author: live.profileName, skipIfClean: true,
    });
  }

  // ---- batch ------------------------------------------------------------------------

  /**
   * Several decisions in one request: one manifest lock, one settled
   * projection, per-item transactions. Every item is validated against that
   * projection first (shape, NOT_OPEN, STALE, duplicates) — nothing is applied
   * until all of them have been looked at — then the valid ones apply in
   * order, each its own journal transaction with its own commit or rollback,
   * continuing past a failure unless `stopOnError`. `dryRun` runs each item's
   * pre-checks and answers `wouldWrite` without touching a file or the log.
   * The host is told once (`onWritten`), the live layer is pushed once, and
   * the response carries the rule suggestions the new decisions support.
   *
   * Why not one transaction for the batch: users expect "37 fixed, 3 need
   * attention", not one stale file vetoing 40 unrelated fixes; the decision
   * log stays 1:1 with the files that changed; and recovery never has to
   * reason about a partial batch. See notes/discrepancy-projection.md.
   */
  async function decideBatch(body, { methodOverride = null } = {}) {
    if (!body || typeof body !== "object" || !Array.isArray(body.decisions)) {
      throw new ControlError("DECISIONS_REQUIRED", "Provide decisions: an array of decision requests", { status: 400 });
    }
    if (body.decisions.length === 0) throw new ControlError("DECISIONS_REQUIRED", "Provide at least one decision", { status: 400 });
    if (body.decisions.length > BATCH_LIMIT) {
      throw new ControlError("BATCH_TOO_LARGE", `A batch may carry at most ${BATCH_LIMIT} decisions (got ${body.decisions.length})`, { status: 413, detail: { limit: BATCH_LIMIT } });
    }
    return withManifestLock(() => decideBatchUnlocked(body.decisions, {
      methodOverride, stopOnError: body.stopOnError === true, dryRun: body.dryRun === true,
    }));
  }

  // The batch body, for callers that already hold the lock (the automatic
  // rules job). `guard(discrepancy, request)` re-checks an item against the
  // locked projection before it applies (false → skipped silently, never
  // recorded); `onApplyError(discrepancy, request, error)` runs for an apply
  // failure before the item is reported (the automatic job appends `blocked`).
  //
  // The lock is held for the whole batch, and the manifest lock has waiters:
  // a concurrent decision, rule edit, or source add gives up after
  // MANIFEST_LOCK_TIMEOUT_MS. So the apply loop has a wall-clock budget
  // (BATCH_TIME_BUDGET_MS, under that timeout): items not reached in time
  // come back `BATCH_TIME_BUDGET` — not failed, not attempted — and the caller
  // resubmits them (the console's "continue"; the automatic job simply picks
  // them up on its next pass). 500 acknowledgements or local rewrites fit
  // comfortably; 500 commits into the live layer do not, and should not hold
  // every other writer off for a minute.
  async function decideBatchUnlocked(requests, {
    methodOverride = null, stopOnError = false, dryRun = false, guard = null, onApplyError = null,
  } = {}) {
    const startedAt = Date.now();
    await ensureRecovery();
    const payload = await settledProjection();
    const failureOf = (discrepancyId, error) => ({
      discrepancyId, ok: false, status: error.status ?? 500,
      code: typeof error.code === "string" ? error.code : "ERROR", error: error.message,
    });

    // Phase 1 — validate everything against the one projection: shape,
    // NOT_OPEN, STALE, and every parameter check that needs no disk read
    // (validateDecisionParams), so a malformed item is reported before any
    // sibling is applied. An id that appears twice is decided once: the first
    // occurrence keeps it (however it fares), every later one is a DUPLICATE.
    const seen = new Set();
    const items = requests.map((raw) => {
      const discrepancyId = raw && typeof raw === "object" && typeof raw.discrepancyId === "string" ? raw.discrepancyId : null;
      // Set once the item is located and past the guard: a parameter failure
      // after that point is the decision's own answer (the automatic job
      // records it as `blocked`, exactly as if the apply had thrown), while a
      // shape/NOT_OPEN/STALE failure before it is not.
      let located = null;
      try {
        if (discrepancyId !== null) {
          if (seen.has(discrepancyId)) throw new ControlError("DUPLICATE", "This discrepancy appears more than once in the batch; decide it once.", { status: 400 });
          seen.add(discrepancyId);
        }
        validateRequestShape(raw, methodOverride);
        const discrepancy = locateInProjection(payload, raw);
        if (guard && !guard(discrepancy, raw)) return { discrepancyId, raw, discrepancy: null, error: null, skipped: true };
        located = discrepancy;
        validateDecisionParams(discrepancy, raw, { projection: payload });
        return { discrepancyId, raw, discrepancy, error: null, skipped: false };
      } catch (error) {
        return { discrepancyId, raw, discrepancy: located, error, skipped: false };
      }
    });

    // Phase 2 — apply in order, each item its own transaction.
    const results = [];
    let applied = 0;
    let failed = 0;
    let notAttempted = 0;
    let attempted = 0; // items that reached applyDecision
    let stopped = null; // { code, reason } once the rest is no longer attempted
    let anyWritten = false;
    let liveCommits = 0;
    for (const item of items) {
      if (item.skipped) continue; // an automatic item its guard declined: silently, as before
      // The budget never stops a batch before its first attempt: a run whose
      // projection alone outlasted it must still make progress, or a queue of
      // automatic work could never converge.
      if (!stopped && !dryRun && attempted > 0 && Date.now() - startedAt > batchTimeBudgetMs) {
        stopped = { code: "BATCH_TIME_BUDGET", reason: "Not attempted: this batch used its time budget. Resubmit the remaining decisions." };
      }
      if (stopped) {
        results.push({ discrepancyId: item.discrepancyId, ok: false, status: 409, code: stopped.code, error: stopped.reason });
        notAttempted += 1;
        continue;
      }
      if (item.error) {
        if (item.discrepancy && onApplyError) await onApplyError(item.discrepancy, item.raw, item.error);
        results.push(failureOf(item.discrepancyId, item.error));
        failed += 1;
        if (stopOnError) stopped = { code: "SKIPPED", reason: "Skipped: an earlier decision in this batch failed and stopOnError was set." };
        continue;
      }
      try {
        attempted += 1;
        const out = await applyDecision(item.discrepancy, item.raw, {
          methodOverride, push: false, notify: false, dryRun, projection: payload,
        });
        results.push({
          discrepancyId: item.discrepancyId, ok: true,
          ...(dryRun ? { wouldWrite: out.wouldWrite } : { decision: out.decision, written: out.written, ...(out.git ? { git: out.git } : {}) }),
        });
        applied += 1;
        if (!dryRun) {
          if (out.written?.length) anyWritten = true;
          if (out.git?.committed) liveCommits += 1;
        }
      } catch (error) {
        // A typed refusal (ControlError, an httpError from the writers) is the
        // item's answer; anything else is a bug that must not hide inside a
        // 200 per-item result.
        if (error.status === undefined) console.error(`contextcake: batch decision ${item.discrepancyId} failed unexpectedly: ${error.stack ?? error.message}`);
        if (onApplyError) await onApplyError(item.discrepancy, item.raw, error);
        results.push(failureOf(item.discrepancyId, error));
        failed += 1;
        // A write that could not be rolled back needs a person before anything
        // else is applied — regardless of stopOnError.
        if (error.code === "RECOVERY_REQUIRED") stopped = { code: "SKIPPED", reason: "Skipped: an earlier write in this batch requires recovery." };
        else if (stopOnError) stopped = { code: "SKIPPED", reason: "Skipped: an earlier decision in this batch failed and stopOnError was set." };
      }
    }

    if (!dryRun && anyWritten) onWritten();
    let gitSummary = null;
    if (!dryRun && liveCommits > 0) {
      const live = liveLayer();
      gitSummary = { layer: live.name, commits: liveCommits, ...(await pushLive(live.root)) };
    }
    const [decisions, rules] = await Promise.all([resolutionLog.list(), effectiveRules()]);
    return {
      ok: failed === 0 && notAttempted === 0, applied, failed, notAttempted, dryRun, results,
      ...(gitSummary ? { git: gitSummary } : {}),
      suggestions: suggestDiscrepancyRules(decisions, rules),
    };
  }

  // ---- automatic rules -----------------------------------------------------------

  // Applies every auto_ready discrepancy whose single automatic rule still
  // holds, as ONE batch under ONE manifest lock: the eligible list is built
  // from one projection, each item is re-checked against the locked
  // projection before it applies (rule state can change while this job waits
  // for the lock — disabling a rule, an ambiguity, a source generation change
  // always wins over a previously scheduled action), and a failed apply is
  // recorded as `blocked` for that revision so it is not retried forever.
  // Bounded at BATCH_LIMIT per pass; the writes invalidate the index, the
  // host re-runs this after the next pass, and the queue converges. The host
  // decides WHEN to call it (after a settled index pass).
  async function runAutomaticRules() {
    // This job runs after EVERY index pass, and project() below is a
    // full-corpus resolve whenever the pass changed anything (which it just
    // did). With no enabled automatic rule there is nothing it could ever
    // apply, so answer that from the rule stores (two small file reads)
    // before paying for the corpus — the common case, since automatic rules
    // are opt-in. Same `enabled !== false` reading as rule matching
    // (discrepancies.mjs).
    const rules = await effectiveRules();
    if (!rules.some((rule) => rule.enabled !== false && rule.mode === "automatic")) return;
    const payload = await project(0);
    if (!payload.coverageComplete) return;
    const decisions = await resolutionLog.list();
    const planned = new Map(); // discrepancyId -> { rule, request }
    for (const discrepancy of payload.discrepancies) {
      if (planned.size >= BATCH_LIMIT) break;
      if (discrepancy.status !== "auto_ready") continue;
      const matches = discrepancy.matchingRules.filter((rule) => rule.mode === "automatic");
      if (matches.length !== 1) continue;
      const rule = matches[0];
      if (decisions.some((row) => row.discrepancyId === discrepancy.id && row.revision === discrepancy.revision
        && row.method === "automatic" && ["committed", "blocked", "not_required"].includes(row.transactionState))) continue;
      if (!automaticallyApplicable(discrepancy, rule)) continue;
      planned.set(discrepancy.id, { rule, request: automaticRequest(discrepancy, rule) });
    }
    if (planned.size === 0) return;
    // The batch refuses an unsettled projection with COVERAGE_INCOMPLETE. For
    // this job that is a normal condition (a pass landed while it waited for
    // the lock), and the answer is the same as the old loop's silent return:
    // the next pass re-runs it.
    await withManifestLock(() => decideBatchUnlocked([...planned.values()].map((entry) => entry.request), {
      methodOverride: "automatic",
      guard: (current, request) => {
        const { rule } = planned.get(request.discrepancyId);
        if (current.status !== "auto_ready" || current.ruleConflict) return false;
        const currentMatches = current.matchingRules.filter((item) => item.mode === "automatic");
        if (currentMatches.length !== 1 || currentMatches[0].id !== rule.id
          || JSON.stringify(currentMatches[0].action) !== JSON.stringify(rule.action)) return false;
        return automaticallyApplicable(current, rule);
      },
      // The failure record participates in the same serialization boundary as
      // successful decisions. Otherwise a manual decision can commit after
      // this lock is released but before `blocked` is appended, leaving the
      // failed automatic attempt as the misleading latest disposition for
      // this revision.
      onApplyError: async (discrepancy, request, error) => {
        await resolutionLog.append({
          schemaVersion: 2, id: randomUUID(), discrepancyId: discrepancy.id,
          discrepancyKind: discrepancy.originalKind ?? discrepancy.kind, revision: discrepancy.revision,
          action: request.action, method: "automatic", actor: "local-user", ruleId: request.ruleId,
          transactionState: "blocked", reason: error.message, decidedAt: new Date().toISOString(),
          contributorFingerprints: discrepancy.contributions.map((item) => ({ source: item.source, fingerprint: item.fingerprint })),
          contributions: discrepancy.contributions.map((item) => ({ layer: item.source, level: item.level, content: item.value, updated: item.updated })),
        });
        noteWrite();
      },
    })).catch((error) => {
      if (error.code === "COVERAGE_INCOMPLETE") return;
      throw error;
    });
  }

  // The health and writability guards an automatic action needs, evaluated
  // against whichever projection the caller holds. Every source must be
  // healthy; a content write (prefer_source) needs every contributor
  // writable; a link rewrite needs the effective section's layer writable. An
  // acknowledgement writes nothing. A rewrite whose destination no longer
  // exists is deliberately NOT filtered here: it applies, fails with
  // LINK_TARGET_MISSING, and is recorded as `blocked` — never acknowledged
  // silently, never retried without a trace.
  function automaticallyApplicable(discrepancy, rule) {
    if (!discrepancy.sourceHealth.every((health) => health && health.status === "ok")) return false;
    const roots = fileRoots();
    if (rule.action.type === "prefer_source") return discrepancy.contributions.every((item) => roots.has(item.source));
    if (rule.action.type === "rewrite_link") return roots.has(discrepancy.effectiveSource);
    return true;
  }

  function automaticRequest(discrepancy, rule) {
    const base = { discrepancyId: discrepancy.id, revision: discrepancy.revision, ruleId: rule.id };
    if (rule.action.type === "prefer_source") return { ...base, action: "choose_contribution", selectedSource: rule.action.source };
    if (rule.action.type === "rewrite_link") return { ...base, action: "rewrite_link", newTarget: rule.action.newTarget };
    return { ...base, action: "acknowledge", reasonCode: rule.action.reasonCode };
  }

  return {
    // projection reads
    project, list, query, detail, summary,
    // rules
    effectiveRules, rulesView, liveRuleFile,
    // decisions
    decide, decideBatch, applyDecision, commitDecisionWrite, ensureRecovery, runAutomaticRules,
    // rules + priorities
    approveSuggestion, patchRule, promoteRule, setPriority,
    // hosts that append a decision outside these operations tell the memo
    noteWrite,
    close,
    // the live section read the link actions depend on, for hosts that want it back
    readLiveSection,
  };
}

export { BATCH_LIMIT, BATCH_TIME_BUDGET_MS };
