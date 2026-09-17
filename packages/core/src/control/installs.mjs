// Every `contextcake` install on PATH, for `contextcake doctor` (control-plane
// spec §5.11): a harness running a bare `contextcake` may start a different
// engine than the one the user just ran.
//
// Nothing found is executed. Running each hit's `--version` would hand it the
// user's environment (tokenEnv secrets included), could hang past any timeout
// (a child that ignores SIGTERM keeps its pipes open), and on a PATH with a
// relative entry would run whatever `./contextcake` a repository planted. The
// version is read from the install's own files instead:
//
//   npm (POSIX): bin/contextcake -> lib/node_modules/contextcake/bin/contextcake.mjs,
//     so the realpath's package.json one folder up.
//   npm (win32): <prefix>/contextcake.cmd beside <prefix>/node_modules/contextcake.
//   Mac app: Contents/Resources/bin/contextcake. Resources/app.asar/package.json
//     is what the app's own CLI reads (apps/desktop/src/cli/version.mjs), but
//     plain Node cannot open an asar archive, so Contents/Info.plist's
//     CFBundleShortVersionString is read too.
//
// Anything else reports version "unknown".

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const MAX_PATH_ENTRIES = 64;
export const MAX_INSTALLS = 16;
const PACKAGE_NAMES = new Set(["contextcake", "contextcake-desktop"]);
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

const nodeIo = {
  stat: (file) => fsp.stat(file),
  realpath: (file) => fsp.realpath(file),
  readFile: (file) => fsp.readFile(file, "utf8"),
  executable: async (file) => {
    try {
      await fsp.access(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

async function readJson(io, file) {
  try {
    return JSON.parse(await io.readFile(file));
  } catch {
    return null;
  }
}

async function versionFromPackage(io, file) {
  const pkg = await readJson(io, file);
  return pkg && PACKAGE_NAMES.has(pkg.name) && typeof pkg.version === "string" && pkg.version ? pkg.version : null;
}

async function versionFromPlist(io, file) {
  try {
    const text = await io.readFile(file);
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]{1,64})<\/string>/.exec(text);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

async function installVersion(io, p, hit, realpath) {
  const dir = p.dirname(realpath);
  const candidates = [
    () => versionFromPackage(io, p.join(dir, "..", "package.json")),
    () => versionFromPackage(io, p.join(p.dirname(hit), "node_modules", "contextcake", "package.json")),
    () => versionFromPackage(io, p.join(dir, "..", "app.asar", "package.json")),
    () => versionFromPlist(io, p.join(dir, "..", "..", "Info.plist")),
  ];
  for (const candidate of candidates) {
    const version = await candidate();
    if (version) return version;
  }
  return "unknown";
}

/**
 * options: env (PATH, PATHEXT), platform, current (the running CLI's script,
 *   compared by realpath), io (stat/realpath/readFile/executable; tests inject
 *   a fake filesystem).
 * Returns [{ path, realpath, version, current? }] in PATH order: one entry per
 * directory, relative PATH entries skipped, a realpath listed once.
 */
export async function findInstalls({ env, platform = process.platform, current = null, io = nodeIo }) {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  const pathValue = win ? (env.PATH ?? env.Path ?? "") : (env.PATH ?? "");
  const dirs = String(pathValue).split(win ? ";" : ":").filter(Boolean).slice(0, MAX_PATH_ENTRIES);
  // On Windows only PATHEXT names run from a shell. npm writes a sh script
  // named `contextcake` beside `contextcake.cmd`; that one is not a Windows
  // executable and must not count as a second install.
  const names = win
    ? String(env.PATHEXT || DEFAULT_PATHEXT).split(";").filter(Boolean).map((ext) => `contextcake${ext.toLowerCase()}`)
    : ["contextcake"];

  const installs = [];
  const seen = new Set();
  for (const dir of dirs) {
    if (installs.length >= MAX_INSTALLS) break;
    if (!p.isAbsolute(dir)) continue;
    for (const name of names) {
      const file = p.join(dir, name);
      let stat;
      try {
        stat = await io.stat(file);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (!win && !(await io.executable(file))) continue;
      let realpath = file;
      try { realpath = await io.realpath(file); } catch { /* keep the PATH form */ }
      if (!seen.has(realpath)) {
        seen.add(realpath);
        installs.push({ path: file, realpath, version: await installVersion(io, p, file, realpath) });
      }
      break; // the first runnable name in a directory is what a shell would run
    }
  }
  if (current) {
    let currentReal = current;
    try { currentReal = await io.realpath(current); } catch { /* compare as given */ }
    for (const install of installs) install.current = install.realpath === currentReal;
  }
  return installs;
}
