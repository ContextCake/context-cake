#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { parseConcept } from "./sources/okf-local.mjs";
import { commitPaths, push } from "./sources/git-core.mjs";
import { appendFileInRoot, resolveAuthor, writeFileInRoot } from "./capture.mjs";
import { slugify } from "./classify-context.mjs";

const args = parseArgs(process.argv.slice(2));

if (args["from-live"]) {
  await runFromLive(args);
  process.exit(0);
}

if (args.help || !args.personal || !args.shared || !args.file) {
  printHelp();
  process.exit(args.help ? 0 : 1);
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

function kindDest(kind) {
  return { decision: "decisions", investigation: "systems" }[kind] ?? null;
}

async function runFromLive(parsed) {
  const liveRoot = path.resolve(parsed["from-live"]);
  const curatedRoot = parsed.target ? path.resolve(parsed.target) : null;
  if (!curatedRoot) throw new Error("--target <curated-root> is required");

  if (parsed.approve) return approvePromotion(liveRoot, curatedRoot, path.resolve(parsed.approve), parsed);
  if (parsed.capture) return requestPromotion(liveRoot, curatedRoot, parsed.capture, parsed);
  throw new Error("Pass --capture <id> to request a promotion or --approve <review-file> to finalize one.");
}

function captureSlug(captureId) {
  const base = path.posix.basename(captureId);
  const sep = base.indexOf("--");
  return sep === -1 ? base : base.slice(sep + 2);
}

function requestPromotion(liveRoot, curatedRoot, captureId, parsed) {
  const sourcePath = safeJoin(liveRoot, `${captureId}.md`);
  if (!fs.existsSync(sourcePath)) throw new Error(`Capture not found in live layer: ${captureId}`);
  const raw = fs.readFileSync(sourcePath, "utf8");
  const { frontmatter } = parseConcept(raw);

  let dest = parsed.dest ?? null;
  if (!dest) {
    const prefix = kindDest(frontmatter.kind);
    if (!prefix) throw new Error(`Kind "${frontmatter.kind}" has no default destination — pass --dest <concept-id>.`);
    dest = `${prefix}/${captureSlug(captureId)}`;
  }

  const reviewRel = `_review/promotions/${slugify(path.posix.basename(dest))}.md`;
  const staged = raw.replace(/^---\n/, `---\npromoteTo: ${dest}\npromotedFrom: ${captureId}\n`);
  writeFileInRoot(curatedRoot, reviewRel, staged);
  console.log(`Staged promotion request: ${reviewRel} -> ${dest}`);
}

async function approvePromotion(liveRoot, curatedRoot, reviewPath, parsed) {
  if (!fs.existsSync(reviewPath)) throw new Error(`Review file not found: ${reviewPath}`);
  const { frontmatter, sections } = parseConcept(fs.readFileSync(reviewPath, "utf8"));
  const dest = frontmatter.promoteTo;
  const captureId = frontmatter.promotedFrom;
  if (!dest || !captureId) throw new Error("Review file is missing promoteTo/promotedFrom frontmatter.");

  const destRel = `${dest}.md`;
  const destPath = safeJoin(curatedRoot, destRel);

  // Idempotent re-approve: a valid existing curated concept means the write
  // already happened — do cleanup only, never duplicate.
  const alreadyDurable = fs.existsSync(destPath) && isDurable(destPath);
  if (!alreadyDurable) {
    writeFileInRoot(curatedRoot, destRel, renderCurated(frontmatter, sections, dest));
    if (!isDurable(destPath)) throw new Error(`Curated write failed verification: ${destRel}`);
  }

  // Only after the curated write is durable: remove review entry + live capture.
  fs.rmSync(reviewPath, { force: true });
  const livePath = safeJoin(liveRoot, `${captureId}.md`);
  if (fs.existsSync(livePath)) {
    const telemetryPath = parsed.telemetry
      ? await emitPromoteEvent(liveRoot, captureId, frontmatter, dest)
      : null;
    fs.rmSync(livePath);
    await commitPaths(
      liveRoot,
      [`${captureId}.md`, ...(telemetryPath ? [telemetryPath] : [])],
      `chore: promote ${captureId} -> ${dest}`,
    );
    const pushed = await push(liveRoot);
    if (pushed.queued) console.error("promote: live cleanup committed locally; push queued (run sync to retry)");
  }
  console.log(`Promoted ${captureId} -> ${dest}`);
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
    lines.push(section.heading, "", section.lines.join("\n").trim(), "");
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
    } else if (arg === "--dry-run" || arg === "--print-git" || arg === "--telemetry") {
      parsed[arg.slice(2)] = true;
    } else if (arg.startsWith("--")) {
      parsed[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node promote.mjs --personal <dir> --shared <dir> --file <concept-or-path> [--dry-run] [--print-git]

Copies a markdown concept from the personal OKF bundle into the shared bundle and rebuilds shared index.md.
`);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
