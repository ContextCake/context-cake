// Builds source adapters from a manifest. Each layer declares a `source`
// ("okf-local" default, "files", "github", or "mcp"). Paths/commands resolve
// relative to the manifest's own directory. An optional per-layer `cache` block
// ({"ttlSeconds": N, "dir": "..."}) wraps the adapter with withCache. An
// optional `git` block wraps it again with withGitSync — outermost, so reads
// hit the pull gate before the cache and a real pull invalidates it.
//
// Remote layers name a credential; they never carry one. `tokens` is the map of
// alias -> secret injected by the caller that owns the OS keychain (the desktop
// app); headless callers use {"tokenEnv": "NAME"} instead.

import path from "node:path";
import { createOkfLocalSource } from "./okf-local.mjs";
import { createFilesSource } from "./files.mjs";
import { createGithubSource } from "./github.mjs";
import { createMcpSource } from "./mcp.mjs";
import { withCache } from "./cache.mjs";
import { withGitSync } from "./git-sync.mjs";

export function buildSources(manifest, manifestDir, { tokens = {} } = {}) {
  return (manifest.layers ?? []).map((layer) => {
    const kind = layer.source ?? "okf-local";
    const base = { name: layer.name, level: Number(layer.level) };
    let source;
    if (kind === "okf-local") {
      source = createOkfLocalSource({ ...base, root: path.resolve(manifestDir, layer.path) });
    } else if (kind === "files") {
      source = createFilesSource({ ...base, root: path.resolve(manifestDir, layer.path) });
    } else if (kind === "github") {
      source = createGithubSource({
        ...base,
        repo: layer.repo,
        ref: layer.ref ?? null,
        ...(Array.isArray(layer.paths) && layer.paths.length ? { paths: layer.paths } : {}),
        ...(layer.apiBase ? { apiBase: layer.apiBase } : {}),
        token: resolveToken(layer, tokens),
      });
    } else if (kind === "mcp") {
      source = createMcpSource({
        ...base,
        command: layer.command,
        args: (layer.args ?? []).map((a) => (a.startsWith("./") || a.startsWith("../") ? path.resolve(manifestDir, a) : a)),
      });
    } else {
      throw new Error(`Unknown source kind "${kind}" for layer "${layer.name}"`);
    }
    if (layer.cache) {
      source = withCache(source, {
        ...(layer.cache.ttlSeconds != null ? { ttlMs: Number(layer.cache.ttlSeconds) * 1000 } : {}),
        cacheDir: layer.cache.dir ? path.resolve(manifestDir, layer.cache.dir) : null,
      });
    }
    if (layer.git) {
      source = withGitSync(source, {
        root: path.resolve(manifestDir, layer.path),
        pullTtlMs: (Number(layer.git.pullTtlSeconds ?? 90)) * 1000,
        retentionDays: Number(layer.git.retentionDays ?? 14),
      });
    }
    return source;
  });
}

// Credential indirection: a manifest may only NAME a credential. The two legal
// forms are "keychain:<alias>", resolved from the injected `tokens` map (the app
// owns the keychain; the engine never opens it), and {"tokenEnv": "NAME"} for
// headless runs. Every other shape is rejected, which is what structurally keeps
// a raw token out of a manifest instead of relying on anyone to notice one.
//
// An alias with no injected secret resolves to null rather than throwing: the
// layer then reads anonymously, so a public repo still works and a private one
// degrades to the adapter's warn-and-continue path.
export function resolveToken(layer, tokens = {}) {
  const auth = layer.auth;
  if (auth == null) return null;
  if (typeof auth === "string") {
    if (!auth.startsWith("keychain:") || auth.length === "keychain:".length) {
      throw new Error(
        `Layer "${layer.name}": "auth" must be "keychain:<alias>" or {"tokenEnv":"NAME"} — a manifest never holds a credential`,
      );
    }
    return tokens[auth.slice("keychain:".length)] ?? null;
  }
  if (typeof auth === "object" && typeof auth.tokenEnv === "string" && auth.tokenEnv) {
    return process.env[auth.tokenEnv] ?? null;
  }
  throw new Error(
    `Layer "${layer.name}": unrecognized "auth" form — use "keychain:<alias>" or {"tokenEnv":"NAME"}`,
  );
}
