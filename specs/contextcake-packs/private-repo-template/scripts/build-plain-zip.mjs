#!/usr/bin/env node

import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const contentRoot = path.resolve(repoRoot, "packs/data-analytics-team/skills/data-analytics-team-pack");
const dist = path.resolve(repoRoot, "dist");
const version = readYamlScalar(fs.readFileSync(path.join(contentRoot, "PACK.yaml"), "utf8"), "version") ?? "0.0.0";
if (!isSemver(version)) throw new Error(`PACK.yaml version must be semver, got ${version}`);
const zipName = `data-analytics-team-pack-v${version}.zip`;
const zipPath = path.join(dist, zipName);

const allowlist = [
  "START-HERE.md",
  "SKILL.md",
  "PACK.yaml",
  "overview",
  "glossary",
  "workflows",
  "templates",
  "examples",
  "prompt-guides",
  "policies-and-rules",
  "tool-guides",
  "local-overlay",
  "updates",
];

fs.mkdirSync(dist, { recursive: true });
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "contextcake-pack-"));
try {
  const stage = path.join(tmpdir, "data-analytics-team-pack");
  fs.mkdirSync(stage);
  for (const item of allowlist) {
    const source = path.join(contentRoot, item);
    if (!fs.existsSync(source)) throw new Error(`Missing allowlisted path: ${item}`);
    fs.cpSync(source, path.join(stage, item), { recursive: true });
  }
  const contentChecksum = canonicalContentChecksum(stage);
  const stagedManifestPath = path.join(stage, "PACK.yaml");
  const stagedManifest = fs.readFileSync(stagedManifestPath, "utf8").replace(
    /(^\s*checksum:\s*).+$/m,
    `$1"${contentChecksum}"`,
  );
  fs.writeFileSync(stagedManifestPath, stagedManifest, "utf8");
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  childProcess.execFileSync("zip", ["-qr", zipPath, "data-analytics-team-pack"], { cwd: tmpdir, stdio: "inherit" });
  const archiveChecksum = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
  fs.writeFileSync(`${zipPath}.sha256`, `${archiveChecksum}  ${zipName}\n`, "utf8");
  console.log(`Built ${path.relative(repoRoot, zipPath)}`);
  console.log(`Content checksum ${contentChecksum}`);
  console.log(`Archive checksum sha256:${archiveChecksum}`);
} finally {
  fs.rmSync(tmpdir, { recursive: true, force: true });
}

function readYamlScalar(content, key) {
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^${key}:\\s*(.*)$`));
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, "");
  }
  return null;
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function canonicalContentChecksum(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of fs.readdirSync(current).sort()) {
      const fullPath = path.join(current, name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed in Pack artifacts: ${path.relative(root, fullPath)}`);
      if (stat.isDirectory()) stack.push(fullPath);
      else if (stat.isFile()) files.push(fullPath);
    }
  }
  const hash = crypto.createHash("sha256");
  for (const filePath of files.sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b)))) {
    const relative = path.relative(root, filePath).split(path.sep).join("/");
    hash.update(relative);
    hash.update("\0");
    let content = fs.readFileSync(filePath);
    if (relative === "PACK.yaml") {
      content = Buffer.from(content.toString("utf8").replace(/(^\s*checksum:\s*).+$/m, '$1"pending-release"'));
    }
    hash.update(content);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
