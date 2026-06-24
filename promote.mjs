#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));

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
    } else if (arg === "--dry-run" || arg === "--print-git") {
      parsed[arg.slice(2)] = true;
    } else if (arg.startsWith("--")) {
      parsed[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node tools/team-knowledge/promote.mjs --personal <dir> --shared <dir> --file <concept-or-path> [--dry-run] [--print-git]

Copies a markdown concept from the personal OKF bundle into the shared bundle and rebuilds shared index.md.
`);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
