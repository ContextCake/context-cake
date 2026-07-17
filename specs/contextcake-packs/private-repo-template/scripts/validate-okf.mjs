#!/usr/bin/env node
// Standalone subset of the parsing rules in context-cake's sources/okf-local.mjs,
// vendored deliberately. This repo does not depend on the engine repo. Re-sync by
// hand if the engine's OKF grammar changes.

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const defaultPackRoot = "packs/data-analytics-team/skills/data-analytics-team-pack";
const packRoot = path.resolve(repoRoot, process.argv[2] ?? defaultPackRoot);
const pluginJsonPath = path.resolve(repoRoot, "packs/data-analytics-team/.claude-plugin/plugin.json");

const excluded = new Set([
  "SKILL.md",
  "START-HERE.md",
  "updates/CHANGELOG.md",
  "updates/MERGE-GUIDE.md",
  "local-overlay/README.md",
]);

const errors = [];

if (!fs.existsSync(packRoot)) {
  errors.push(`${path.relative(repoRoot, packRoot)}: pack root does not exist`);
} else {
  validatePackTrustContract();
  for (const filePath of walkMarkdown(packRoot)) {
    const rel = toPosix(path.relative(packRoot, filePath));
    if (excluded.has(rel)) continue;
    validateMarkdown(filePath, rel);
  }
  validateVersionMatch();
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log(`OKF validation passed for ${path.relative(repoRoot, packRoot)}`);

function validateMarkdown(filePath, rel) {
  const content = fs.readFileSync(filePath, "utf8");
  const { frontmatter, body, bodyStartLine } = parseFrontmatter(content);
  if (!frontmatter.type) errors.push(`${rel}: missing frontmatter field "type"`);
  if (!frontmatter.updated) errors.push(`${rel}: missing frontmatter field "updated"`);

  const lines = body.split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) return;
    if (!/\{[^}]*#[A-Za-z0-9_-]+[^}]*\}/.test(match[2])) {
      errors.push(`${rel}:${bodyStartLine + index}: missing {#anchor} on heading "${stripAttrs(match[2])}"`);
    }
  });
}

function validateVersionMatch() {
  const packYamlPath = path.join(packRoot, "PACK.yaml");
  if (!fs.existsSync(packYamlPath) || !fs.existsSync(pluginJsonPath)) return;
  const packVersion = readYamlScalar(fs.readFileSync(packYamlPath, "utf8"), "version");
  const plugin = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
  if (packVersion && !isSemver(packVersion)) {
    errors.push(`invalid version: PACK.yaml version must be semver, got ${packVersion}`);
  }
  if (plugin.version && !isSemver(plugin.version)) {
    errors.push(`invalid version: plugin.json version must be semver, got ${plugin.version}`);
  }
  if (packVersion && plugin.version && packVersion !== plugin.version) {
    errors.push(`version mismatch: PACK.yaml has ${packVersion}, plugin.json has ${plugin.version}`);
  }
}

function validatePackTrustContract() {
  const packYamlPath = path.join(packRoot, "PACK.yaml");
  if (!fs.existsSync(packYamlPath)) {
    errors.push("PACK.yaml: required pack manifest is missing");
    return;
  }
  const manifest = fs.readFileSync(packYamlPath, "utf8");
  const requiredScalars = [
    ["id"],
    ["name"],
    ["version"],
    ["hero_workflow"],
    ["changelog"],
    ["creator", "name"],
    ["creator", "url"],
    ["license", "model"],
    ["license", "terms_url"],
    ["update_policy", "cadence"],
    ["update_policy", "base_purchase"],
    ["update_policy", "corrections"],
    ["update_policy", "editorial_updates"],
    ["rights", "attested"],
    ["rights", "disclosure"],
    ["freshness", "reviewed_at"],
    ["permissions", "content_only"],
    ["permissions", "executable_code"],
    ["permissions", "network_access"],
    ["permissions", "credentials"],
    ["compatibility", "contextcake"],
    ["compatibility", "pack_contract"],
    ["review", "status"],
    ["review", "reviewed_by"],
    ["review", "reviewed_at"],
    ["artifact", "checksum_algorithm"],
    ["artifact", "checksum_scope"],
    ["artifact", "checksum"],
  ];
  for (const yamlPath of requiredScalars) {
    if (readYamlPath(manifest, yamlPath) === null) {
      errors.push(`PACK.yaml: missing required field "${yamlPath.join(".")}"`);
    }
  }
  if (!hasYamlListItems(manifest, "supported_surfaces")) {
    errors.push('PACK.yaml: "supported_surfaces" must contain at least one item');
  }
  if (!hasYamlListItems(manifest, "source_disclosures")) {
    errors.push('PACK.yaml: "source_disclosures" must contain at least one item');
  }
  if (!hasYamlListItems(manifest, "sample_files")) {
    errors.push('PACK.yaml: "sample_files" must contain at least one item');
  }

  expectYamlValue(manifest, ["rights", "attested"], "true");
  expectYamlValue(manifest, ["permissions", "content_only"], "true");
  expectYamlValue(manifest, ["permissions", "executable_code"], "false");
  expectYamlValue(manifest, ["permissions", "network_access"], "false");
  expectYamlValue(manifest, ["permissions", "credentials"], "false");
  expectYamlValue(manifest, ["compatibility", "pack_contract"], "1");
  expectYamlValue(manifest, ["artifact", "checksum_algorithm"], "sha256");
  expectYamlValue(manifest, ["artifact", "checksum_scope"], "canonical-content-tree");

  const checksum = readYamlPath(manifest, ["artifact", "checksum"]);
  if (checksum && checksum !== "pending-release" && !/^sha256:[a-f0-9]{64}$/.test(checksum)) {
    errors.push('PACK.yaml: "artifact.checksum" must be pending-release or sha256:<64 lowercase hex characters>');
  }

  const entries = walkEntries(packRoot);
  const filePaths = new Set(entries.filter((entry) => entry.stat.isFile()).map((entry) => toPosix(path.relative(packRoot, entry.path))));
  const sampleFiles = readYamlList(manifest, "sample_files");
  for (const sample of sampleFiles) {
    if (!filePaths.has(sample)) errors.push(`PACK.yaml: sample file does not exist: ${sample}`);
  }
  const changelog = readYamlPath(manifest, ["changelog"]);
  if (changelog && !filePaths.has(changelog)) errors.push(`PACK.yaml: changelog does not exist: ${changelog}`);

  for (const entry of entries) {
    const rel = toPosix(path.relative(packRoot, entry.path));
    if (entry.stat.isSymbolicLink()) {
      errors.push(`${rel}: symlinks are not allowed in a curated Pack`);
      continue;
    }
    if (!entry.stat.isFile()) continue;
    const extension = path.extname(entry.path).toLowerCase();
    if (![".md", ".yaml", ".yml", ".json", ".txt"].includes(extension)) {
      errors.push(`${rel}: curated Packs may contain only Markdown, YAML, JSON, or text files`);
    }
  }
}

function expectYamlValue(content, yamlPath, expected) {
  const value = readYamlPath(content, yamlPath);
  if (value !== null && value !== expected) {
    errors.push(`PACK.yaml: "${yamlPath.join(".")}" must be ${expected}`);
  }
}

function readYamlPath(content, yamlPath) {
  const stack = [];
  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#") || rawLine.trimStart().startsWith("- ")) continue;
    const match = rawLine.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const depth = Math.floor(indent / 2);
    stack.length = depth;
    stack[depth] = match[2];
    const currentPath = stack.slice(0, depth + 1);
    if (currentPath.length === yamlPath.length && currentPath.every((part, index) => part === yamlPath[index])) {
      const value = match[3].trim();
      return value ? parseYamlScalar(value) : null;
    }
  }
  return null;
}

function hasYamlListItems(content, key) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start === -1) return false;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[^\s]/.test(lines[index])) break;
    if (/^\s{2}-\s+\S/.test(lines[index])) return true;
  }
  return false;
}

function readYamlList(content, key) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start === -1) return [];
  const values = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[^\s]/.test(lines[index])) break;
    const item = lines[index].match(/^\s{2}-\s+(.+)$/);
    if (item) values.push(parseYamlScalar(item[1].trim()));
  }
  return values;
}

function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) return { frontmatter: {}, body: content, bodyStartLine: 1 };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: content, bodyStartLine: 1 };
  const raw = content.slice(4, end).trim();
  const body = content.slice(end + 4).replace(/^\n/, "");
  const bodyStartLine = content.slice(0, end + 4).split(/\r?\n/).length + (content.slice(end + 4).startsWith("\n") ? 1 : 0);
  const frontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    frontmatter[match[1]] = parseYamlScalar(match[2].trim());
  }
  return { frontmatter, body, bodyStartLine };
}

function readYamlScalar(content, key) {
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^${key}:\\s*(.*)$`));
    if (match) return parseYamlScalar(match[1].trim());
  }
  return null;
}

function parseYamlScalar(value) {
  return value.replace(/^['"]|['"]$/g, "");
}

function stripAttrs(value) {
  return value.replace(/\{[^}]*\}/g, "").trim();
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
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
      else if (dirent.isFile() && dirent.name.endsWith(".md")) files.push(fullPath);
    }
  }
  return files.sort();
}

function walkEntries(root) {
  const entries = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of fs.readdirSync(current)) {
      if (name === "node_modules") continue;
      const fullPath = path.join(current, name);
      const stat = fs.lstatSync(fullPath);
      entries.push({ path: fullPath, stat });
      if (stat.isDirectory()) stack.push(fullPath);
    }
  }
  return entries;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
