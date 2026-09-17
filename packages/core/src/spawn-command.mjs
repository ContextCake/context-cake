// How the engine launches a foreign MCP server's command. One policy for the
// app and every CLI (specs/contextcake-control-plane/spec.md §5.6).
//
// POSIX: the command and arguments go to spawn() untouched, as an argv vector.
//
// Windows: `npx`, `pnpm`, and `yarn` are `.cmd` batch shims, and Node refuses
// to spawn a batch file without a shell (CVE-2024-27980). Node's own PATH
// lookup also only tries `.com` and `.exe`. So when the command resolves to a
// `.cmd` or `.bat`, it runs as `cmd.exe /d /v:off /s /c "<line>"`, with the
// line built here rather than by `shell: true`, which does no escaping at all.
// Anything else (an `.exe`, or nothing found) is left to Node exactly as before.
//
// Pure: pass {platform, env, isFile} to test another OS from this one.

import fs from "node:fs";
import path from "node:path";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

// Every character cmd.exe gives meaning to outside quotes, plus the ones it
// treats as argument separators. Escaping a harmless one costs nothing.
const CMD_META = /[()[\]%!^"`<>&|;, *?]/g;

export function resolveSpawnCommand(command, args, { platform = process.platform, env = process.env, isFile = defaultIsFile } = {}) {
  if (platform !== "win32") return { command, args, options: {} };

  const batch = findBatchFile(command, env, isFile);
  if (!batch) return { command, args, options: {} };

  for (const arg of args) {
    // cmd.exe ends the command at a line break, so there is no way to pass one.
    if (/[\r\n]/.test(arg)) throw new Error("MCP command arguments cannot contain a line break on Windows when the command is a .cmd or .bat file");
  }

  // cmd.exe parses the line once to run the batch file. The batch file then
  // expands %* into its own command line, and cmd.exe parses that text again.
  // So each argument is quoted for the program at the end (MSVCRT rules), then
  // caret-escaped twice: the first parse eats one layer, the %* re-parse eats
  // the second. Every quote is escaped too, so neither parse ever enters a
  // quoted region where a caret would stop working. A % always sits behind a
  // caret, so `%NAME%` never matches a variable. The path is parsed only once,
  // so it is escaped once.
  //
  // This holds for batch files that forward arguments with %*, which is what
  // the npm, pnpm, and yarn shims do. A batch file that wraps %1 in its own
  // quotes re-parses arguments differently, and no outside escaping fixes that.
  const line = [escapeCmd(batch), ...args.map((arg) => escapeCmd(escapeCmd(quoteArgument(arg))))].join(" ");
  return {
    command: readEnv(env, "ComSpec") || "cmd.exe",
    // /d skips AutoRun commands from the registry. /v:off keeps ! literal even
    // where delayed expansion is on by default. /s strips exactly the outer
    // quotes, so the line keeps its own escaping.
    args: ["/d", "/v:off", "/s", "/c", `"${line}"`],
    // Node would otherwise re-quote the line for CreateProcess and break it.
    options: { windowsVerbatimArguments: true },
  };
}

// Search like cmd.exe does: each PATH directory in order, and inside it each
// PATHEXT extension in order. The first hit decides. The current directory is
// not searched, so a repository cannot plant an `npx.cmd` that shadows the real
// one. Returns the batch file's path, or null to leave the command to Node.
function findBatchFile(command, env, isFile) {
  const exts = (readEnv(env, "PATHEXT") || DEFAULT_PATHEXT)
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const ownExt = path.win32.extname(command).toLowerCase();
  const names = exts.includes(ownExt) ? [command] : exts.map((ext) => command + ext);

  const hasDir = /[\\/]/.test(command) || /^[a-z]:/i.test(command);
  const dirs = hasDir
    ? [""]
    : (readEnv(env, "PATH") || "")
        .split(";")
        .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
        .filter(Boolean);

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir ? path.win32.join(dir, name) : name;
      if (!isFile(candidate)) continue;
      const ext = path.win32.extname(candidate).toLowerCase();
      return ext === ".cmd" || ext === ".bat" ? candidate : null;
    }
  }
  return null;
}

// Quote one argument so CommandLineToArgvW (and Node's own parser) reads it
// back unchanged: backslashes are literal except before a quote, where they
// double, and the quote itself gets one more.
function quoteArgument(arg) {
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes += 1;
      continue;
    }
    out += ch === '"' ? `${"\\".repeat(slashes * 2 + 1)}"` : `${"\\".repeat(slashes)}${ch}`;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

function escapeCmd(text) {
  return text.replace(CMD_META, "^$&");
}

// Windows environment names are case-insensitive, and the real PATH is often
// spelled `Path`. process.env handles that itself; a plain object does not.
function readEnv(env, name) {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function defaultIsFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
