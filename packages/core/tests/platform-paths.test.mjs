// Where ContextCake keeps config, durable data, and cache on each OS
// (specs/contextcake-control-plane/spec.md §5.12).
//
// The app and every CLI copy must agree on these, or `contextcake mcp` looks
// for a manifest in a folder the app never wrote. Before this module the
// app-bundled CLI always answered the macOS path, and the npm CLI answered
// `~/.config` on Windows.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolvePaths } from "../src/platform-paths.mjs";

const mac = { platform: "darwin", homedir: "/Users/ada", env: {} };
const linux = { platform: "linux", homedir: "/home/ada", env: {} };
const windows = { platform: "win32", homedir: "C:\\Users\\ada", env: { APPDATA: "C:\\Users\\ada\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" } };

test("macOS shares the app's Application Support folder and uses Caches for cache", () => {
  assert.deepEqual(resolvePaths(mac), {
    config: "/Users/ada/Library/Application Support/ContextCake",
    data: "/Users/ada/Library/Application Support/ContextCake",
    cache: "/Users/ada/Library/Caches/ContextCake",
    manifest: "/Users/ada/Library/Application Support/ContextCake/manifest.json",
  });
});

test("Linux follows the XDG defaults", () => {
  assert.deepEqual(resolvePaths(linux), {
    config: "/home/ada/.config/contextcake",
    data: "/home/ada/.local/share/contextcake",
    cache: "/home/ada/.cache/contextcake",
    manifest: "/home/ada/.config/contextcake/manifest.json",
  });
});

test("Linux honors absolute XDG variables and ignores relative ones, as the XDG spec requires", () => {
  const paths = resolvePaths({ ...linux, env: { XDG_CONFIG_HOME: "/xdg/config", XDG_DATA_HOME: "relative/data", XDG_CACHE_HOME: "/xdg/cache" } });
  assert.equal(paths.config, "/xdg/config/contextcake");
  assert.equal(paths.data, "/home/ada/.local/share/contextcake");
  assert.equal(paths.cache, "/xdg/cache/contextcake");
});

test("Windows uses Roaming for config and Local for data and cache", () => {
  const paths = resolvePaths(windows);
  assert.equal(paths.config, path.win32.join("C:\\Users\\ada\\AppData\\Roaming", "ContextCake"));
  assert.equal(paths.data, path.win32.join("C:\\Users\\ada\\AppData\\Local", "ContextCake", "Data"));
  assert.equal(paths.cache, path.win32.join("C:\\Users\\ada\\AppData\\Local", "ContextCake", "Cache"));
  assert.equal(paths.manifest, path.win32.join(paths.config, "manifest.json"));
});

test("Windows falls back to the profile folders when APPDATA/LOCALAPPDATA are unset", () => {
  const paths = resolvePaths({ ...windows, env: {} });
  assert.equal(paths.config, "C:\\Users\\ada\\AppData\\Roaming\\ContextCake");
  assert.equal(paths.data, "C:\\Users\\ada\\AppData\\Local\\ContextCake\\Data");
});

test("CONTEXTCAKE_* overrides win on every platform, and the manifest follows the config override", () => {
  for (const base of [mac, linux]) {
    const paths = resolvePaths({ ...base, env: { CONTEXTCAKE_CONFIG_DIR: "/o/config", CONTEXTCAKE_DATA_DIR: "/o/data", CONTEXTCAKE_CACHE_DIR: "/o/cache" } });
    assert.deepEqual(paths, { config: "/o/config", data: "/o/data", cache: "/o/cache", manifest: "/o/config/manifest.json" });
  }
  assert.equal(resolvePaths({ ...linux, env: { CONTEXTCAKE_MANIFEST: "/elsewhere/m.json" } }).manifest, "/elsewhere/m.json");
});

test("defaults come from the running process", () => {
  const paths = resolvePaths();
  for (const key of ["config", "data", "cache", "manifest"]) assert.ok(path.isAbsolute(paths[key]), key);
});
