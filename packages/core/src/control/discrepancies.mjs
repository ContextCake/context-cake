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
import { stageSectionTransaction, stageFrontmatterTransaction } from "../layer-files.mjs";
import {
  buildDiscrepancies, compactDiscrepancy, filterDiscrepancies, summarizeDiscrepancies,
} from "../discrepancies.mjs";
import { parseRuleDocument, serializeRuleDocument, suggestDiscrepancyRules } from "../discrepancy-rules.mjs";
import { resolveLiveLayer } from "../sources/git-sync.mjs";
import { withManifestLockAsync } from "../manifest.mjs";
import { ControlError } from "./errors.mjs";

const TEAM_RULES_RELATIVE = ".contextcake/discrepancy-rules.json";
const ACTIONS = new Set(["choose_contribution", "compose", "acknowledge"]);
// target_missing is broken-link-shaped: acknowledging why a link target will
// never resolve (the concept was retired, renamed elsewhere, etc.) needs a
// reason distinct from a genuine scoped disagreement.
const ACKNOWLEDGE_REASONS = new Set(["different_scopes", "temporary_migration", "source_specific_authority", "target_missing", "other"]);
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

  // What the projection reads from a source row: name, status, error — the
  // three fields healthSummary keeps and coverageComplete tests. Progress
  // fields (loaded/total/phase) deliberately stay out, or an index in flight
  // would miss the memo on every poll.
  function sourceHealthSig(sources) {
    return JSON.stringify(sources.map((source) => [source.name, source.status, source.error ?? null]));
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
    const key = `${c.corpusKey}|${sourceHealthSig(c.status.sources)}|${await sidecarRevision()}`;
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
      )).catch((error) => {
        recovery = null;
        throw error;
      });
    }
    return recovery;
  }

  // ---- decisions ------------------------------------------------------------------

  // The locked entry point: parse-level validation, then re-project against a
  // settled generation and check the caller's revision before applying.
  function decide(body, { methodOverride = null, reasonOverride = null } = {}) {
    return withManifestLock(() => decideUnlocked(body, { methodOverride, reasonOverride }));
  }

  async function decideUnlocked(body, { methodOverride = null, reasonOverride = null } = {}) {
    await ensureRecovery();
    const { discrepancyId, action, ruleId } = body;
    if (ruleId !== undefined && methodOverride !== "automatic") {
      throw new ControlError("RULE_AUTHORITY", "Rule authority is reserved for approved background actions", { status: 400 });
    }
    if (typeof discrepancyId !== "string" || !discrepancyId) throw new ControlError("DISCREPANCY_ID_REQUIRED", "Provide discrepancyId", { status: 400 });
    if (!ACTIONS.has(action)) throw new ControlError("ACTION_INVALID", "Unsupported discrepancy action", { status: 400 });
    // A file watcher may have invalidated the index between the review GET and
    // this mutation. Decisions must re-resolve against a settled generation;
    // treating an in-flight empty snapshot as "no longer open" is both
    // misleading and can make a valid current-revision decision impossible.
    const payload = await project(15_000);
    if (!payload.coverageComplete || payload.indexing) {
      throw new ControlError("COVERAGE_INCOMPLETE", "Sources are still indexing. Wait for settled coverage before deciding.", { status: 409 });
    }
    const discrepancy = payload.byId.get(discrepancyId);
    if (!discrepancy) throw new ControlError("NOT_OPEN", "This discrepancy is no longer open. Reload before deciding it.", { status: 409 });
    if (body.revision !== undefined && body.revision !== discrepancy.revision) {
      throw new ControlError("STALE", "This discrepancy changed after you opened it. Reload before deciding it.", { status: 409 });
    }
    return applyDecision(discrepancy, body, { methodOverride, reasonOverride });
  }

  // Apply one decision to a discrepancy the caller already projected. The
  // caller holds the manifest lock; this never takes it.
  async function applyDecision(discrepancy, body, { methodOverride = null, reasonOverride = null } = {}) {
    await ensureRecovery();
    const { action, selectedSource, content, reasonCode, note, ruleId } = body;
    if (ruleId !== undefined && methodOverride !== "automatic") {
      throw new ControlError("RULE_AUTHORITY", "Rule authority is reserved for approved background actions", { status: 400 });
    }
    if (!discrepancy || body.revision !== discrepancy.revision) {
      throw new ControlError("STALE", "This discrepancy changed after you opened it. Reload before deciding it.", { status: 409 });
    }
    if (action === "acknowledge" && !ACKNOWLEDGE_REASONS.has(reasonCode)) throw new ControlError("REASON_REQUIRED", "Choose why this scoped difference should remain", { status: 400 });
    const chosen = action === "choose_contribution"
      ? discrepancy.contributions.find((item) => item.source === selectedSource)
      : null;
    if (action === "choose_contribution" && !chosen) throw new ControlError("SOURCE_INVALID", "Choose one of this discrepancy's contributing sources", { status: 400 });
    if (action === "compose" && typeof content !== "string") throw new ControlError("CONTENT_REQUIRED", "Provide reconciled content", { status: 400 });

    const transactionId = randomUUID();
    const now = new Date().toISOString();
    const originalKind = discrepancy.originalKind ?? discrepancy.kind;
    const previousDecision = discrepancy.history?.at(-1) ?? null;
    const decision = {
      schemaVersion: 2,
      id: randomUUID(), discrepancyId: discrepancy.id,
      ...(discrepancy.legacyId ? { conflictId: discrepancy.legacyId } : {}),
      conceptId: discrepancy.conceptId, title: discrepancy.conceptTitle,
      discrepancyKind: originalKind, sectionKey: originalKind === "section_content" ? discrepancy.key : undefined,
      sectionHeading: discrepancy.label, fieldKey: originalKind === "frontmatter_value" ? discrepancy.key : undefined,
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
      decision.transactionState = "not_required";
      decision.writtenTargets = [];
      const saved = await resolutionLog.append(decision);
      noteWrite();
      return { ok: true, decision: saved, written: [] };
    }
    if (originalKind === "broken_link") throw new ControlError("BROKEN_LINK_NOT_WRITABLE", "Open the source file to repair this link, or acknowledge the scoped difference.", { status: 409 });
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

    const value = action === "compose" ? content : chosen.value;
    const roots = fileRoots();
    const writableSources = discrepancy.contributions.map((item) => item.source).filter((source) => roots.has(source));
    if (writableSources.length === 0) throw new ControlError("SOURCE_NOT_WRITABLE", "None of this discrepancy's contributors is locally writable. Open the source files to resolve it.", { status: 409 });
    let staged;
    if (originalKind === "frontmatter_value") {
      staged = await stageFrontmatterTransaction(JSON.stringify({
        conceptId: discrepancy.conceptId, key: discrepancy.key,
        layers: writableSources, value,
        expectedValues: Object.fromEntries(discrepancy.contributions.map((item) => [item.source, item.value])),
      }), roots, transactionId);
    } else {
      staged = await stageSectionTransaction(JSON.stringify({
        conceptId: discrepancy.conceptId, sectionKey: discrepancy.key,
        layers: writableSources, content: value,
        expectedContent: Object.fromEntries(discrepancy.contributions.map((item) => [item.source, item.value])), requireAll: true,
      }), roots, transactionId);
    }
    const journalTargets = staged.targets.map((target) => ({ path: target.path, staged: target.staged, backup: target.backup }));
    await transactionJournal.append({ id: transactionId, state: "prepared", preparedAt: now, targets: journalTargets });
    try {
      const written = await staged.commit();
      decision.transactionState = "committed";
      decision.writtenTargets = staged.targets.map((target) => ({ layer: target.layer, path: target.path }));
      const saved = await resolutionLog.append(decision);
      noteWrite();
      await transactionJournal.append({ id: transactionId, state: "committed", committedAt: new Date().toISOString() });
      await staged.cleanup();
      onWritten();
      return { ok: true, decision: saved, written };
    } catch (error) {
      if (error.code !== "RecoveryRequired") {
        try {
          await staged.rollback();
          await transactionJournal.append({ id: transactionId, state: "rolled_back", rolledBackAt: new Date().toISOString(), error: error.message });
          await staged.cleanup();
          throw new ControlError("ROLLED_BACK", `Nothing was changed. ${error.message}`, { status: 409 });
        } catch (rollbackError) {
          if (rollbackError.status === 409) throw rollbackError;
          await transactionJournal.append({ id: transactionId, state: "recovery_required", failedAt: new Date().toISOString(), error: `${error.message}; rollback failed: ${rollbackError.message}` });
          throw new ControlError("RECOVERY_REQUIRED", `A write could not be rolled back automatically. Recovery is required: ${rollbackError.message}`, { status: 500 });
        }
      }
      await transactionJournal.append({ id: transactionId, state: "recovery_required", failedAt: new Date().toISOString(), error: error.message });
      throw new ControlError("RECOVERY_REQUIRED", `A write could not be rolled back automatically. Recovery is required: ${error.message}`, { status: 500 });
    }
  }

  // ---- automatic rules -----------------------------------------------------------

  // Applies the first auto_ready discrepancy whose single automatic rule still
  // holds under the manifest lock. One apply per call: the write invalidates
  // the index, the host re-runs this after the next pass, and the queue
  // converges. The host decides WHEN to call it (after a settled index pass).
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
    for (const discrepancy of payload.discrepancies) {
      if (discrepancy.status !== "auto_ready") continue;
      const matches = discrepancy.matchingRules.filter((rule) => rule.mode === "automatic");
      if (matches.length !== 1) continue;
      const rule = matches[0];
      if (decisions.some((row) => row.discrepancyId === discrepancy.id && row.revision === discrepancy.revision
        && row.method === "automatic" && ["committed", "blocked", "not_required"].includes(row.transactionState))) continue;
      const sourceHealthy = discrepancy.sourceHealth.every((health) => health && health.status === "ok");
      const allWritable = discrepancy.contributions.every((item) => fileRoots().has(item.source));
      if (!sourceHealthy || (rule.action.type === "prefer_source" && !allWritable)) continue;
      const request = rule.action.type === "prefer_source"
        ? { discrepancyId: discrepancy.id, revision: discrepancy.revision, action: "choose_contribution", selectedSource: rule.action.source, ruleId: rule.id }
        : { discrepancyId: discrepancy.id, revision: discrepancy.revision, action: "acknowledge", reasonCode: rule.action.reasonCode, ruleId: rule.id };
      await withManifestLock(async () => {
        // Rule state can change while this job waits for the manifest lock.
        // Re-read everything under the lock so disabling a rule, introducing
        // an ambiguity, or changing a source generation always wins over a
        // previously scheduled action.
        const currentPayload = await project(15_000);
        if (!currentPayload.coverageComplete || currentPayload.indexing) return;
        const current = currentPayload.byId.get(discrepancy.id);
        if (!current || current.revision !== discrepancy.revision || current.status !== "auto_ready" || current.ruleConflict) return;
        const currentMatches = current.matchingRules.filter((item) => item.mode === "automatic");
        if (currentMatches.length !== 1 || currentMatches[0].id !== rule.id
          || JSON.stringify(currentMatches[0].action) !== JSON.stringify(rule.action)) return;
        if (!current.sourceHealth.every((health) => health && health.status === "ok")) return;
        if (rule.action.type === "prefer_source" && !current.contributions.every((item) => fileRoots().has(item.source))) return;
        try {
          await applyDecision(current, request, { methodOverride: "automatic" });
        } catch (error) {
          // The failure record participates in the same serialization boundary
          // as successful decisions. Otherwise a manual decision can commit
          // after this lock is released but before `blocked` is appended,
          // leaving the failed automatic attempt as the misleading latest
          // disposition for this revision.
          await resolutionLog.append({
            schemaVersion: 2, id: randomUUID(), discrepancyId: discrepancy.id,
            discrepancyKind: discrepancy.originalKind ?? discrepancy.kind, revision: discrepancy.revision,
            action: request.action, method: "automatic", actor: "local-user", ruleId: rule.id,
            transactionState: "blocked", reason: error.message, decidedAt: new Date().toISOString(),
            contributorFingerprints: discrepancy.contributions.map((item) => ({ source: item.source, fingerprint: item.fingerprint })),
            contributions: discrepancy.contributions.map((item) => ({ layer: item.source, level: item.level, content: item.value, updated: item.updated })),
          });
          noteWrite();
        }
      });
      return;
    }
  }

  return {
    // projection reads
    project, list, query, detail, summary,
    // rules
    effectiveRules, rulesView, liveRuleFile,
    // decisions
    decide, applyDecision, ensureRecovery, runAutomaticRules,
    // rules + priorities
    approveSuggestion, patchRule, promoteRule, setPriority,
    // hosts that append a decision outside these operations tell the memo
    noteWrite,
    close,
    // capabilities the host may want back (PR 3 write actions)
    readLiveSection,
  };
}
