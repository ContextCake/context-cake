#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeConceptId as normalizeOkfConceptId, parseConcept } from "./sources/okf-local.mjs";
import { commitPaths, commitPathsWithMutation, push, runGit } from "./sources/git-core.mjs";
import { appendFileInRoot, readFileInRoot, resolveAuthor, writeFileInRoot } from "./capture.mjs";
import { slugify } from "./classify-context.mjs";
import { sectionText } from "./sections.mjs";
import { sourceConfigFingerprint, withManifestLockAsync } from "./manifest.mjs";
import { loadProfileRuntime, resolveProfileLiveLayer } from "./profile-runtime.mjs";

const PROMOTION_KEYS = [
  "promoteTo",
  "promotedFrom",
  "promotionProfile",
  "promotionRevision",
  "promotionLiveFingerprint",
  "promotionTargetFingerprint",
  "promotionCapture",
  "promotionDestination",
  "promotionCaptureHash",
  "promotionBinding",
];

const args = parseArgs(process.argv.slice(2));

if (args.manifest) {
  await runProfilePromotion(args);
  process.exit(0);
}

if (args["legacy-paths"] && args["from-live"]) {
  await runFromLive(args);
  process.exit(0);
}

if (args.help) {
  printHelp();
  process.exit(0);
}

if (!args["legacy-paths"]) {
  throw new Error("Profile-aware promotion requires --manifest. To use raw directory roots, pass --legacy-paths explicitly.");
}

if (!args.personal || !args.shared || !args.file) {
  printHelp();
  process.exit(1);
}

const personalRoot = path.resolve(args.personal);
const sharedRoot = path.resolve(args.shared);
const sourcePath = resolveSourcePath(personalRoot, args.file);
const relativePath = toPosix(path.relative(personalRoot, sourcePath));
const destinationPath = safeJoin(sharedRoot, relativePath);
const dryRun = Boolean(args["dry-run"]);

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Source file not found: ${sourcePath}`);
}

const original = fs.readFileSync(sourcePath, "utf8");
const promoted = rewritePersonalLinks(original, relativePath);
const operations = [
  `copy ${sourcePath} -> ${destinationPath}`,
  `update ${path.join(sharedRoot, "index.md")}`,
];

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, operations, content: promoted }, null, 2));
  process.exit(0);
}

fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
fs.writeFileSync(destinationPath, promoted);
updateIndex(sharedRoot);

console.log(`Promoted ${relativePath}`);

if (args["print-git"]) {
  const branch = args.branch ?? `promote/${relativePath.replace(/\.md$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
  console.log("");
  console.log("Suggested git commands:");
  console.log(`  cd ${sharedRoot}`);
  console.log(`  git checkout -b ${branch}`);
  console.log(`  git add ${relativePath} index.md`);
  console.log(`  git commit -m "docs: promote ${relativePath.replace(/\.md$/i, "")}"`);
  console.log("  git push -u origin HEAD");
  console.log("  gh pr create --fill");
}

// ---- live → curated promotion (two-step through _review/promotions/) --------
//
// Request: --from-live <live> --capture <id> --target <curated> [--dest <id>]
//   stages a review entry; the live capture is untouched.
// Approve: --from-live <live> --target <curated> --approve <review-file>
//   writes the curated concept, verifies it is durable, and only then removes
//   the review entry and the live capture. Re-running approve is idempotent.

// The manifest lock guards selection + local mutation only (matching capture
// confirmation's boundary) — never the network push. A push can take far
// longer than the manifest lock's own timeout, and holding the lock through it
// would stall or spuriously fail every other profile-aware operation sharing
// this manifest (concurrent captures, other promotions, profile-cli edits).
async function runProfilePromotion(parsed) {
  const manifestPath = path.resolve(parsed.manifest);
  const pending = await withManifestLockAsync(manifestPath, async () => {
    const runtime = loadProfileRuntime(manifestPath, {
      requestedProfile: parsed.profile ?? null,
      cwd: process.cwd(),
    });
    const { liveLayer, binding: liveBinding } = resolveProfileLiveLayer(runtime);
    if (!liveLayer) throw new Error(`Selected profile ${runtime.selection.profileId} does not have a live layer.`);
    const targetName = parsed["target-layer"];
    if (!targetName) throw new Error("--target-layer <name> is required in profile-aware mode.");
    const targetLayer = runtime.selection.layers.find((layer) => layer.name === targetName);
    if (!targetLayer) throw new Error(`Layer ${targetName} is not in selected profile ${runtime.selection.profileId}.`);
    if (targetLayer.live === true) throw new Error("The promotion target must be a curated layer, not the live layer.");
    if ((targetLayer.source ?? "okf-local") !== "okf-local" || typeof targetLayer.path !== "string") {
      throw new Error(`Promotion target ${targetName} must be a local OKF layer.`);
    }
    const curatedRoot = path.resolve(runtime.manifestDir, targetLayer.path);
    const profileBinding = {
      profileId: runtime.selection.profileId,
      manifestRevision: runtime.revision,
      liveLayerFingerprint: liveBinding.liveLayerFingerprint,
      targetLayer: targetName,
      targetLayerFingerprint: sourceConfigFingerprint(runtime.selection.profileId, targetLayer, runtime.manifestDir),
    };
    const bound = { ...parsed, _profileBinding: profileBinding, _manifestPath: manifestPath };
    if (parsed.approve) {
      const reviewPath = resolveProfileReviewPath(curatedRoot, parsed.approve);
      const outcome = await commitPromotion(liveLayer.root, curatedRoot, reviewPath, bound);
      return { kind: "approve", liveRoot: liveLayer.root, ...outcome };
    }
    if (parsed.capture) {
      await requestPromotion(liveLayer.root, curatedRoot, parsed.capture, bound);
      return { kind: "capture" };
    }
    throw new Error("Pass --capture <id> to request a promotion or --approve <review-file> to finalize one.");
  });
  if (pending.kind === "approve") await finalizePromotion(pending);
}

function kindDest(kind) {
  return { decision: "decisions", investigation: "systems" }[kind] ?? null;
}

async function runFromLive(parsed) {
  const liveRoot = path.resolve(parsed["from-live"]);
  const curatedRoot = parsed.target ? path.resolve(parsed.target) : null;
  if (!curatedRoot) throw new Error("--target <curated-root> is required");

  if (parsed.approve) {
    const outcome = await commitPromotion(liveRoot, curatedRoot, path.resolve(parsed.approve), parsed);
    return finalizePromotion({ liveRoot, ...outcome });
  }
  if (parsed.capture) return requestPromotion(liveRoot, curatedRoot, parsed.capture, parsed);
  throw new Error("Pass --capture <id> to request a promotion or --approve <review-file> to finalize one.");
}

function captureSlug(captureId) {
  const base = path.posix.basename(captureId);
  const sep = base.indexOf("--");
  return sep === -1 ? base : base.slice(sep + 2);
}

async function requestPromotion(liveRoot, curatedRoot, captureId, parsed) {
  captureId = safePromotionConceptId(captureId, "capture");
  if (!captureId.startsWith("captures/")) throw new Error("Promotion source must be a live capture id under captures/.");
  let raw;
  try {
    raw = readFileInRoot(liveRoot, `${captureId}.md`);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Capture not found in live layer: ${captureId}`);
    throw error;
  }
  assertNoReservedPromotionKeys(raw);
  const { frontmatter } = parseConcept(raw);

  let dest = parsed.dest ?? null;
  if (!dest) {
    const prefix = kindDest(frontmatter.kind);
    if (!prefix) throw new Error(`Kind "${frontmatter.kind}" has no default destination — pass --dest <concept-id>.`);
    dest = `${prefix}/${captureSlug(captureId)}`;
  }
  dest = safePromotionConceptId(dest, "destination");

  const reviewRel = `_review/promotions/${slugify(path.posix.basename(dest))}.md`;
  if (fs.existsSync(safeJoin(curatedRoot, reviewRel))) {
    throw new Error(`Promotion review already exists: ${reviewRel}`);
  }
  const binding = parsed._profileBinding;
  const captureHash = sha256(raw);
  let liveHeadAtStage = null;
  if (binding) {
    const tracked = await runGit(liveRoot, ["ls-files", "--error-unmatch", "--", `${captureId}.md`], { allowFailure: true });
    if (!tracked.ok) throw new Error("Profile-aware promotion requires a committed live capture. Sync or confirm it before staging.");
    const head = await runGit(liveRoot, ["rev-parse", "HEAD"], { allowFailure: true });
    if (!head.ok || !/^[a-f0-9]{40,64}$/i.test(head.stdout)) throw new Error("Could not bind promotion to the live repository revision.");
    liveHeadAtStage = head.stdout;
  }
  const bindingNonce = binding
    ? createPromotionBinding(parsed._manifestPath, {
      profileId: binding.profileId,
      manifestRevision: binding.manifestRevision,
      liveLayerFingerprint: binding.liveLayerFingerprint,
      targetLayerFingerprint: binding.targetLayerFingerprint,
      captureId,
      dest,
      captureHash,
      reviewRel,
      liveHeadAtStage,
      cleanupCommitted: false,
    })
    : null;
  const bindingFrontmatter = binding
    ? [
      `promotionProfile: ${binding.profileId}`,
      `promotionRevision: ${binding.manifestRevision}`,
      `promotionLiveFingerprint: ${binding.liveLayerFingerprint}`,
      `promotionTargetFingerprint: ${binding.targetLayerFingerprint}`,
      `promotionCapture: ${captureId}`,
      `promotionDestination: ${dest}`,
      `promotionCaptureHash: ${captureHash}`,
      `promotionBinding: ${bindingNonce}`,
    ].join("\n") + "\n"
    : "";
  const staged = raw.replace(/^---\n/, `---\npromoteTo: ${dest}\npromotedFrom: ${captureId}\n${bindingFrontmatter}`);
  try {
    writeFileInRoot(curatedRoot, reviewRel, staged);
  } catch (error) {
    if (bindingNonce) deletePromotionBinding(parsed._manifestPath, bindingNonce);
    throw error;
  }
  console.log(`Staged promotion request: ${reviewRel} -> ${dest}`);
}

// Validates the review, writes the curated concept, and commits the live
// deletion — everything that must stay behind the manifest lock (in
// profile-aware mode) so a concurrent profile edit can't retarget the write.
// Returns a descriptor for finalizePromotion to push and clean up afterward,
// outside the lock.
async function commitPromotion(liveRoot, curatedRoot, reviewPath, parsed) {
  if (!fs.existsSync(reviewPath)) throw new Error(`Review file not found: ${reviewPath}`);
  const reviewRaw = parsed._profileBinding
    ? readFileInRoot(curatedRoot, path.relative(curatedRoot, reviewPath))
    : fs.readFileSync(reviewPath, "utf8");
  assertPromotionReviewKeys(reviewRaw, Boolean(parsed._profileBinding));
  const { frontmatter, sections } = parseConcept(reviewRaw);
  if (!frontmatter.promoteTo || !frontmatter.promotedFrom) {
    throw new Error("Review file is missing promoteTo/promotedFrom frontmatter.");
  }
  // A review file is editable by design, so re-apply the same concept-id
  // boundary used at request time before any read, write, delete, or log.
  const dest = safePromotionConceptId(frontmatter.promoteTo, "destination");
  const captureId = safePromotionConceptId(frontmatter.promotedFrom, "capture");
  if (!captureId.startsWith("captures/")) throw new Error("Promotion source must be a live capture id under captures/.");
  const reviewRel = toPosix(path.relative(curatedRoot, reviewPath));
  const authoritative = parsed._profileBinding
    ? loadPromotionBinding(parsed._manifestPath, frontmatter.promotionBinding)
    : null;
  if (parsed._profileBinding) {
    assertPromotionBinding(frontmatter, parsed._profileBinding, authoritative, { captureId, dest, reviewRel });
  }

  const destRel = `${dest}.md`;
  const destPath = safeJoin(curatedRoot, destRel);

  const liveRel = `${captureId}.md`;
  let liveRaw = null;
  try {
    liveRaw = readFileInRoot(liveRoot, liveRel);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (authoritative && liveRaw !== null && sha256(liveRaw) !== authoritative.captureHash) {
    throw new Error("The live capture changed after the promotion request. Stage the promotion again.");
  }
  if (authoritative && liveRaw === null && authoritative.cleanupCommitted !== true) {
    const reconciled = await reconcilePromotionCleanup(liveRoot, authoritative);
    if (!reconciled) {
      throw new Error("The bound live capture is missing without a verifiable cleanup commit. Restore it or stage the promotion again.");
    }
    authoritative.cleanupCommitted = true;
    writePromotionBinding(parsed._manifestPath, frontmatter.promotionBinding, authoritative);
  }

  // Rewriting the reviewed bytes is idempotent and prevents an unrelated
  // pre-existing file (or symlink) from being mistaken for this promotion.
  // writeFileInRoot refuses symlinked parents and final components.
  writeFileInRoot(curatedRoot, destRel, renderCurated(frontmatter, sections, dest));
  if (!isDurable(destPath)) throw new Error(`Curated write failed verification: ${destRel}`);

  // Keep the review until the live deletion is committed. The repo lock is
  // acquired before rm; if add/commit fails, restore the exact capture and
  // clear the staged deletion so approval remains resumable.
  let needsPush = false;
  if (liveRaw !== null) {
    await commitPathsWithMutation(liveRoot, [liveRel], `chore: promote ${captureId} -> ${dest}`, {
      mutate: () => fs.rmSync(safeJoin(liveRoot, liveRel)),
      rollback: async () => {
        writeFileInRoot(liveRoot, liveRel, liveRaw);
        const restored = await runGit(liveRoot, ["restore", "--staged", "--", liveRel], { allowFailure: true });
        if (!restored.ok) throw new Error(`could not restore git index: ${restored.stderr}`);
      },
    });

    if (authoritative) {
      authoritative.cleanupCommitted = true;
      writePromotionBinding(parsed._manifestPath, frontmatter.promotionBinding, authoritative);
    }

    if (parsed.telemetry) {
      const telemetryPath = await emitPromoteEvent(liveRoot, captureId, frontmatter, dest);
      if (telemetryPath) {
        try { await commitPaths(liveRoot, [telemetryPath], `chore: telemetry for promotion ${captureId}`); } catch { /* retry on next sync */ }
      }
    }
    needsPush = true;
  } else if (authoritative?.cleanupCommitted === true) {
    needsPush = true;
  }

  return {
    needsPush,
    reviewPath,
    captureId,
    dest,
    manifestPath: parsed._manifestPath ?? null,
    promotionBinding: authoritative ? frontmatter.promotionBinding : null,
  };
}

// Push (best-effort — a queued/failed push is retried later by sync()) and
// clean up the review + local binding. Runs after the manifest lock (if any)
// has been released, since nothing here touches manifest-guarded state.
async function finalizePromotion({ liveRoot, needsPush, reviewPath, captureId, dest, manifestPath, promotionBinding }) {
  if (needsPush) {
    const pushed = await push(liveRoot);
    if (pushed.queued) console.error("promote: live cleanup committed locally; push queued (run sync to retry)");
  }
  fs.rmSync(reviewPath, { force: true });
  if (manifestPath && promotionBinding) deletePromotionBinding(manifestPath, promotionBinding);
  console.log(`Promoted ${captureId} -> ${dest}`);
}

function assertPromotionBinding(frontmatter, current, authoritative, { captureId, dest, reviewRel }) {
  if (!authoritative || typeof authoritative !== "object") {
    throw new Error("Promotion review has no authoritative local binding. Stage it again.");
  }
  const currentConfig = {
    profileId: current.profileId,
    manifestRevision: current.manifestRevision,
    liveLayerFingerprint: current.liveLayerFingerprint,
    targetLayerFingerprint: current.targetLayerFingerprint,
  };
  if (Object.values(currentConfig).some((value) => typeof value !== "string" || !value)) {
    throw new Error("Promotion review is missing its Project Profile binding. Stage it again.");
  }
  if (Object.keys(currentConfig).some((key) => authoritative[key] !== currentConfig[key])) {
    throw new Error("The selected profile, manifest, live layer, or target layer changed after staging. Stage the promotion again.");
  }
  const stagedFields = {
    profileId: frontmatter.promotionProfile,
    manifestRevision: frontmatter.promotionRevision,
    liveLayerFingerprint: frontmatter.promotionLiveFingerprint,
    targetLayerFingerprint: frontmatter.promotionTargetFingerprint,
    captureId: frontmatter.promotionCapture,
    dest: frontmatter.promotionDestination,
    captureHash: frontmatter.promotionCaptureHash,
  };
  if (Object.keys(stagedFields).some((key) => stagedFields[key] !== authoritative[key])) {
    throw new Error("Promotion review metadata does not match its authoritative local binding. Stage it again.");
  }
  if (authoritative.captureId !== captureId || authoritative.dest !== dest || authoritative.reviewRel !== reviewRel) {
    throw new Error("Promotion source or destination binding does not match the review. Stage it again.");
  }
  if (typeof authoritative.captureHash !== "string" || !/^[a-f0-9]{64}$/.test(authoritative.captureHash)) {
    throw new Error("Promotion review is missing a valid live-capture hash. Stage it again.");
  }
}

function assertNoReservedPromotionKeys(content) {
  const counts = frontmatterKeyCounts(content);
  const found = PROMOTION_KEYS.filter((key) => (counts.get(key) ?? 0) > 0);
  if (found.length) throw new Error(`Live capture contains reserved promotion frontmatter: ${found.join(", ")}.`);
}

function assertPromotionReviewKeys(content, profileAware) {
  const counts = frontmatterKeyCounts(content);
  const required = profileAware ? PROMOTION_KEYS : ["promoteTo", "promotedFrom"];
  for (const key of required) {
    if ((counts.get(key) ?? 0) !== 1) throw new Error(`Promotion review must contain exactly one ${key} frontmatter field.`);
  }
  for (const key of PROMOTION_KEYS) {
    if ((counts.get(key) ?? 0) > 1) throw new Error(`Promotion review contains duplicate ${key} frontmatter.`);
  }
}

function frontmatterKeyCounts(content) {
  if (!content.startsWith("---\n")) throw new Error("Promotion content must have YAML frontmatter.");
  const end = content.indexOf("\n---", 4);
  if (end === -1) throw new Error("Promotion content has unterminated YAML frontmatter.");
  const counts = new Map();
  for (const line of content.slice(4, end).split(/\r?\n/)) {
    const key = line.match(/^([A-Za-z0-9_-]+):/)?.[1];
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function reconcilePromotionCleanup(liveRoot, authoritative) {
  if (typeof authoritative.liveHeadAtStage !== "string" || !/^[a-f0-9]{40,64}$/i.test(authoritative.liveHeadAtStage)) return false;
  const expected = `chore: promote ${authoritative.captureId} -> ${authoritative.dest}`;
  const history = await runGit(
    liveRoot,
    ["log", "--format=%s", `${authoritative.liveHeadAtStage}..HEAD`, "--", `${authoritative.captureId}.md`],
    { allowFailure: true },
  );
  return history.ok && history.stdout.split("\n").includes(expected);
}

function createPromotionBinding(manifestPath, record) {
  const nonce = crypto.randomUUID();
  writePromotionBinding(manifestPath, nonce, record, { exclusive: true });
  return nonce;
}

function loadPromotionBinding(manifestPath, nonce) {
  assertPromotionNonce(nonce);
  const root = promotionBindingDirectory(manifestPath);
  let record;
  try {
    record = JSON.parse(readFileInRoot(root, `${nonce}.json`));
  } catch (error) {
    throw new Error(`Could not load the authoritative local promotion binding: ${error.message}`);
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Authoritative local promotion binding is malformed. Stage the promotion again.");
  }
  return record;
}

function writePromotionBinding(manifestPath, nonce, record, { exclusive = false } = {}) {
  assertPromotionNonce(nonce);
  const root = promotionBindingDirectory(manifestPath);
  const filePath = path.join(root, `${nonce}.json`);
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  if (exclusive) {
    const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return;
  }
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filePath);
}

function deletePromotionBinding(manifestPath, nonce) {
  assertPromotionNonce(nonce);
  fs.rmSync(path.join(promotionBindingDirectory(manifestPath), `${nonce}.json`), { force: true });
}

function promotionBindingDirectory(manifestPath) {
  const configured = process.env.CONTEXTCAKE_LOCAL_STATE_DIR;
  let localState;
  if (configured) localState = path.resolve(configured);
  else if (process.platform === "darwin") localState = path.join(os.homedir(), "Library", "Application Support", "ContextCake", "Local State");
  else if (process.platform === "win32") localState = path.join(process.env.LOCALAPPDATA ?? os.homedir(), "ContextCake", "Local State");
  else localState = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "contextcake");
  const directory = path.join(localState, "promotion-bindings", sha256(path.resolve(manifestPath)));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Local promotion-binding store must be a regular directory.");
  return directory;
}

function assertPromotionNonce(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
    throw new Error("Promotion review has an invalid local binding id. Stage it again.");
  }
}

function safePromotionConceptId(value, label) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Promotion ${label} must be a non-empty concept id without control characters.`);
  }
  const normalized = normalizeOkfConceptId(value);
  if (normalized === "." || path.posix.isAbsolute(normalized)) throw new Error(`Invalid promotion ${label}: ${value}`);
  return normalized;
}

function resolveProfileReviewPath(curatedRoot, requested) {
  const reviewRoot = path.resolve(curatedRoot, "_review", "promotions");
  const requestedPath = path.resolve(requested);
  const relative = path.relative(reviewRoot, requestedPath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("--approve must name a review file under the selected target layer's _review/promotions directory.");
  }
  const requestedStat = fs.lstatSync(requestedPath);
  if (requestedStat.isSymbolicLink() || !requestedStat.isFile()) {
    throw new Error("Promotion review must be a regular file, not a symlink or directory.");
  }
  const realRoot = fs.realpathSync.native(reviewRoot);
  const realReview = fs.realpathSync.native(requestedPath);
  const realRelative = path.relative(realRoot, realReview);
  if (realRelative.startsWith(`..${path.sep}`) || realRelative === ".." || path.isAbsolute(realRelative)) {
    throw new Error("Promotion review path escapes the selected target layer.");
  }
  // Return the lexical path under curatedRoot after proving its canonical
  // target stays under the canonical review root. This preserves containment
  // when macOS aliases /var to /private/var.
  return requestedPath;
}

function isDurable(filePath) {
  try {
    const parsed = parseConcept(fs.readFileSync(filePath, "utf8"));
    return parsed.sections.length > 0 || Object.keys(parsed.frontmatter).length > 0;
  } catch {
    return false;
  }
}

function renderCurated(frontmatter, sections, dest) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    "---",
    `type: ${inferCuratedType(dest)}`,
    `title: ${frontmatter.title ?? path.posix.basename(dest)}`,
    `updated: ${today}`,
    "---",
    "",
    `# ${frontmatter.title ?? path.posix.basename(dest)}`,
    "",
    `> promoted from ${frontmatter.author ?? "unknown"}'s capture (${frontmatter.captured ?? "unknown date"})`,
    "",
  ];
  for (const section of sections) {
    if (!section.heading) continue;
    lines.push(section.heading, "", sectionText(section).trim(), "");
  }
  return lines.join("\n");
}

function inferCuratedType(dest) {
  if (dest.startsWith("decisions/")) return "decision";
  if (dest.startsWith("runbooks/")) return "runbook";
  if (dest.startsWith("systems/")) return "system";
  if (dest.startsWith("interfaces/")) return "interface";
  return "context";
}

async function emitPromoteEvent(liveRoot, captureId, frontmatter, dest) {
  try {
    const user = await resolveAuthor({ root: liveRoot, profileName: null });
    const relativePath = path.join("telemetry", slugify(user), `${new Date().toISOString().slice(0, 7)}.ndjson`);
    const line = JSON.stringify({
      ts: new Date().toISOString(), user, harness: "cli", event: "promote",
      concept: captureId, layer: "live", captureKind: frontmatter.kind ?? null,
    });
    appendFileInRoot(liveRoot, relativePath, `${line}\n`);
    return relativePath;
  } catch {
    // telemetry must never block a promotion
    return null;
  }
}

function rewritePersonalLinks(content, sourceRelativePath) {
  const sourceDir = path.posix.dirname(sourceRelativePath);

  return content
    .replace(/\]\((?:personal:|\/personal\/)([^)]+)\)/g, (_, target) => {
      return `](${relativeLink(sourceDir, normalizeMarkdownTarget(target))})`;
    })
    .replace(/\[\[personal:([^\]|]+)(\|[^\]]+)?]]/g, (_, target, alias = "") => {
      return `[[${normalizeConceptId(target)}${alias}]]`;
    });
}

function updateIndex(root) {
  const entries = walkMarkdown(root)
    .filter((filePath) => path.basename(filePath) !== "index.md")
    .map((filePath) => {
      const relative = toPosix(path.relative(root, filePath));
      const content = fs.readFileSync(filePath, "utf8");
      const title = extractTitle(content) ?? relative.replace(/\.md$/i, "");
      return `- [${title}](${relative})`;
    })
    .sort();

  const body = `---\ntype: index\ntitle: Shared Knowledge Index\n---\n\n# Shared Knowledge Index\n\n${entries.join("\n")}\n`;
  fs.writeFileSync(path.join(root, "index.md"), body);
}

function extractTitle(content) {
  const frontmatterTitle = content.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  if (frontmatterTitle) return frontmatterTitle.replace(/^['"]|['"]$/g, "");
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function resolveSourcePath(root, file) {
  const withExtension = file.endsWith(".md") ? file : `${file}.md`;
  return safeJoin(root, withExtension);
}

function relativeLink(sourceDir, target) {
  const targetPath = target.endsWith(".md") ? target : `${target}.md`;
  let relative = path.posix.relative(sourceDir === "." ? "" : sourceDir, targetPath);
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
}

function normalizeMarkdownTarget(value) {
  return stripDecoration(value).replace(/^\//, "");
}

function normalizeConceptId(value) {
  return stripDecoration(value).replace(/\\/g, "/").replace(/\.md$/i, "").replace(/^\//, "");
}

function stripDecoration(value) {
  return value.split("#")[0].split("?")[0].trim();
}

function walkMarkdown(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
      const fullPath = path.join(current, dirent.name);
      if (dirent.isDirectory()) stack.push(fullPath);
      if (dirent.isFile() && dirent.name.endsWith(".md")) files.push(fullPath);
    }
  }
  return files.sort();
}

function safeJoin(root, relativePath) {
  const fullPath = path.resolve(root, relativePath);
  const relative = path.relative(root, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes root: ${relativePath}`);
  }
  return fullPath;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--dry-run" || arg === "--print-git" || arg === "--telemetry" || arg === "--legacy-paths") {
      parsed[arg.slice(2)] = true;
    } else if (arg.startsWith("--")) {
      parsed[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node promote.mjs --manifest <file> [--profile <id>] --capture <id> --target-layer <name> [--dest <id>]
  node promote.mjs --manifest <file> [--profile <id>] --approve <review-file> --target-layer <name> [--telemetry]

Legacy raw-path mode (no Project Profile isolation guarantee):
  node promote.mjs --legacy-paths --from-live <root> --capture <id> --target <root>
  node promote.mjs --legacy-paths --personal <dir> --shared <dir> --file <concept-or-path> [--dry-run] [--print-git]

Profile-aware mode resolves both roots from one selected profile and binds the
review to its manifest revision and layer identities. Raw directory roots are
available only through the explicit --legacy-paths compatibility mode.
`);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
