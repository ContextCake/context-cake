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
import { createGithubSource, DEFAULT_API_BASE as DEFAULT_GITHUB_API_BASE } from "./github.mjs";
import { createMcpSource } from "./mcp.mjs";
import { withCache } from "./cache.mjs";
import { withGitSync } from "./git-sync.mjs";
import { resolveSettings, walkLimitsFrom } from "../settings.mjs";
import { sourceConfigFingerprint, isLoopbackHost } from "../manifest.mjs";

const DEFAULT_GITHUB_API_HOST = new URL(DEFAULT_GITHUB_API_BASE).host.toLowerCase();

export function buildSources(manifest, manifestDir, { tokens = {}, profileId = null } = {}) {
  // Indexing limits are user settings, so they must reach the adapters that
  // enforce them — changing the limit in the app and reloading has to matter.
  const limits = walkLimitsFrom(resolveSettings(manifest));
  return (manifest.layers ?? []).map((layer) => buildSource(layer, manifestDir, { tokens, profileId, limits }));
}

/**
 * buildSources, but one layer's failure costs only that layer. A layer whose
 * adapter throws is replaced by an inert error source — it never becomes a
 * half-built adapter — so the rest of the cascade stays readable and the broken
 * layer surfaces as an error row instead of a 500 on every route.
 *
 * The long-lived engine service uses this; callers that should refuse to run at
 * all against a bad manifest (mcp-server, the CLIs) keep using buildSources.
 */
export function buildSourcesQuarantined(manifest, manifestDir, { tokens = {}, profileId = null } = {}) {
  const limits = walkLimitsFrom(resolveSettings(manifest));
  return (manifest.layers ?? []).map((layer) => {
    try {
      return buildSource(layer, manifestDir, { tokens, profileId, limits });
    } catch (error) {
      return createErrorSource({ name: layer?.name, level: layer?.level, error: error.message });
    }
  });
}

/**
 * The stand-in for a layer that could not be built or did not validate.
 *
 * Deliberately not a working source: it lists nothing and resolves nothing, so
 * quarantining a layer can only ever subtract. Listing throws because the
 * background index is what reads it — that throw is how the layer reaches the
 * user as an error row — while loadConcept answers null so one broken layer
 * cannot fail a resolve the healthy layers can still answer.
 *
 * `quarantined` separates the two cases, because the app can only act on one of
 * them: a layer lifted out by the manifest reader is a config defect the user
 * fixes by removing the entry, while a layer that validated and then failed to
 * construct is a real source having a bad day — renaming, syncing and removing
 * all still work on it as usual.
 */
export function createErrorSource({ name, level, kind = null, error, quarantined = false }) {
  return {
    name: typeof name === "string" && name.trim() ? name : "unnamed source",
    level: Number.isFinite(Number(level)) ? Number(level) : 0,
    // Reported instead of the manifest's kind, which a quarantined layer has no
    // entry in. Null for a layer that validated and then failed to construct —
    // there the manifest still knows what it was.
    quarantinedKind: kind,
    quarantined,
    async loadConcept() { return null; },
    async listConceptIds() { throw new Error(error); },
    close() {},
  };
}

function buildSource(layer, manifestDir, { tokens, profileId, limits }) {
  const kind = layer.source ?? "okf-local";
  const base = { name: layer.name, level: Number(layer.level) };
  // Existing flat-manifest callers omit profileId and retain their exact
  // cache layout. Profile-aware callers opt into the isolated fingerprint
  // namespace after selecting one stack.
  const fingerprint = profileId === null ? null : sourceConfigFingerprint(profileId, layer, manifestDir);
  let source;
  if (kind === "okf-local") {
    source = createOkfLocalSource({ ...base, root: path.resolve(manifestDir, layer.path), limits });
  } else if (kind === "files") {
    source = createFilesSource({ ...base, root: path.resolve(manifestDir, layer.path), limits });
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
      namespace: fingerprint,
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
}

// Where a layer's credential would actually be sent. Only a remote kind has a
// target at all — a local bundle has nothing to bind against. Parsing through
// URL is what makes the comparison safe: it punycodes an IDNA homograph and
// strips any userinfo, so "evil.example" cannot masquerade as the bound host.
export function authTargetHost(layer) {
  const kind = layer.source ?? "okf-local";
  if (kind !== "github") return null;
  try {
    return new URL(layer.apiBase ?? DEFAULT_GITHUB_API_BASE).host.toLowerCase();
  } catch {
    return null;
  }
}

// Headless runs have no keychain to carry a binding, so a tokenEnv secret is
// bound to github.com by default: an untrusted manifest that names an env var
// and points apiBase at a host of its choosing gets nothing. Operators who
// genuinely run against GitHub Enterprise name their hosts here.
function envAllowedHosts() {
  const raw = process.env.CONTEXTCAKE_API_HOSTS;
  const hosts = new Set([DEFAULT_GITHUB_API_HOST]);
  if (raw) for (const h of raw.split(",")) { const v = h.trim().toLowerCase(); if (v) hosts.add(v); }
  return hosts;
}

// A tokens map value is either a bare secret (legacy/test callers, unbound —
// the caller is asserting the binding itself) or {secret, host}, which is what
// the desktop broker injects. The bound form is the one that survives a
// hostile manifest.
function normalizeTokenEntry(entry) {
  if (entry == null) return { secret: null, boundHost: null };
  if (typeof entry === "string") return { secret: entry || null, boundHost: null };
  if (typeof entry === "object" && typeof entry.secret === "string") {
    return {
      secret: entry.secret || null,
      boundHost: typeof entry.host === "string" && entry.host ? entry.host.toLowerCase() : null,
    };
  }
  return { secret: null, boundHost: null };
}

// Credential indirection: a manifest may only NAME a credential. The two legal
// forms are "keychain:<alias>", resolved from the injected `tokens` map (the app
// owns the keychain; the engine never opens it), and {"tokenEnv": "NAME"} for
// headless runs. Every other shape is rejected, which is what structurally keeps
// a raw token out of a manifest instead of relying on anyone to notice one.
//
// Naming a credential is not the same as being allowed to send it. Every
// resolution is host-bound: a secret minted for one host is withheld from a
// layer pointing anywhere else, so `apiBase` cannot be used to redirect a real
// token at an attacker. The withheld case is reported, not silently swallowed —
// see resolveTokenState's `state`, surfaced as authState in /api/graph.
//
// An alias with no injected secret resolves to null rather than throwing: the
// layer then reads anonymously, so a public repo still works and a private one
// degrades to the adapter's warn-and-continue path.
export function resolveTokenState(layer, tokens = {}, { host } = {}) {
  const target = host === undefined ? authTargetHost(layer) : host;
  const auth = layer.auth;
  if (auth == null) return { secret: null, state: "anonymous", alias: null };
  if (typeof auth === "string") {
    if (!auth.startsWith("keychain:") || auth.length === "keychain:".length) {
      throw new Error(
        `Layer "${layer.name}": "auth" must be "keychain:<alias>" or {"tokenEnv":"NAME"} — a manifest never holds a credential`,
      );
    }
    const alias = auth.slice("keychain:".length);
    const { secret, boundHost } = normalizeTokenEntry(tokens[alias]);
    if (!secret) return { secret: null, state: "missing-token", alias };
    if (boundHost && target && boundHost !== target) return { secret: null, state: "host-mismatch", alias };
    return { secret, state: "ok", alias };
  }
  if (
    typeof auth === "object" &&
    !Array.isArray(auth) &&
    Object.keys(auth).length === 1 &&
    Object.hasOwn(auth, "tokenEnv") &&
    typeof auth.tokenEnv === "string" &&
    auth.tokenEnv
  ) {
    const alias = `env:${auth.tokenEnv}`;
    const secret = process.env[auth.tokenEnv] || null;
    if (!secret) return { secret: null, state: "missing-token", alias };
    if (target && !envAllowedHosts().has(target) && !isLoopbackHost(target)) {
      return { secret: null, state: "host-mismatch", alias };
    }
    return { secret, state: "ok", alias };
  }
  throw new Error(
    `Layer "${layer.name}": unrecognized "auth" form — use "keychain:<alias>" or {"tokenEnv":"NAME"}`,
  );
}

export function resolveToken(layer, tokens = {}, options = {}) {
  return resolveTokenState(layer, tokens, options).secret;
}
