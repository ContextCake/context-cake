// Where ContextCake keeps its files on each OS — the one answer the app, the
// app-bundled CLI, the npm CLI, and the engine share
// (specs/contextcake-control-plane/spec.md §5.12).
//
// - config: manifest and settings. On macOS this is the Electron app's
//   userData folder, so the app and the CLI read one manifest. The Linux app
//   pins its userData here for the same reason.
// - data: durable machine-local state (clones, journals, pending captures and
//   promotions). Never cache.
// - cache: regenerable.
//
// Pure: pass {platform, env, homedir} to test another OS from this one.

import os from "node:os";
import path from "node:path";

export function resolvePaths({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const defaults = platformDefaults(platform, env, homedir, join);
  const config = env.CONTEXTCAKE_CONFIG_DIR || defaults.config;
  return {
    config,
    data: env.CONTEXTCAKE_DATA_DIR || defaults.data,
    cache: env.CONTEXTCAKE_CACHE_DIR || defaults.cache,
    manifest: env.CONTEXTCAKE_MANIFEST || join(config, "manifest.json"),
  };
}

function platformDefaults(platform, env, homedir, join) {
  if (platform === "darwin") {
    const support = join(homedir, "Library", "Application Support", "ContextCake");
    return { config: support, data: support, cache: join(homedir, "Library", "Caches", "ContextCake") };
  }
  if (platform === "win32") {
    const roaming = env.APPDATA || join(homedir, "AppData", "Roaming");
    const local = env.LOCALAPPDATA || join(homedir, "AppData", "Local");
    return {
      config: join(roaming, "ContextCake"),
      data: join(local, "ContextCake", "Data"),
      cache: join(local, "ContextCake", "Cache"),
    };
  }
  // XDG: a relative value is invalid and must be ignored.
  const xdg = (name, fallback) => (env[name] && path.posix.isAbsolute(env[name]) ? env[name] : join(homedir, ...fallback));
  return {
    config: join(xdg("XDG_CONFIG_HOME", [".config"]), "contextcake"),
    data: join(xdg("XDG_DATA_HOME", [".local", "share"]), "contextcake"),
    cache: join(xdg("XDG_CACHE_HOME", [".cache"]), "contextcake"),
  };
}
