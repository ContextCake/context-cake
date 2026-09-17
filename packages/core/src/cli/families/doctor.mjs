// `contextcake doctor` (control-plane spec §5.2 exit 8, §5.11, §5.12). A shim
// over control/doctor.mjs. Healthy answers ok with the report as data; a
// failed check answers UNHEALTHY_DIAGNOSTICS (exit 8) with the same report in
// error.details, since a failure envelope carries no data. Doctor runs with
// no manifest at all: saying so, and suggesting init, is part of its job.
//
// The Mac app's CLI passes a wrapSpawn hook. Doctor spawns ../doctor.mjs
// through it, so the app's launcher can add the device-local observability
// check; the npm CLI has no hook and reports that nothing was checked.

import { execFile } from "node:child_process";
import path from "node:path";
import { ControlError } from "../../control/errors.mjs";
import { runDoctor } from "../../control/doctor.mjs";
import { ENGINE_SRC } from "../spawn.mjs";
import { defineFamily } from "../table.mjs";

const OBSERVABILITY_TIMEOUT_MS = 5000;

async function probeObservability(ctx) {
  const wrap = ctx.hooks.wrapSpawn;
  if (!wrap) return null;
  try {
    const wrapped = wrap({ command: "doctor", entry: path.join(ENGINE_SRC, "doctor.mjs"), args: [], env: ctx.env, paths: ctx.paths });
    const stdout = await new Promise((resolve, reject) => {
      execFile(process.execPath, wrapped.args, { env: wrapped.env, timeout: OBSERVABILITY_TIMEOUT_MS, windowsHide: true }, (error, out) => {
        if (error) reject(error);
        else resolve(out);
      });
    });
    const observability = JSON.parse(String(stdout).trim().split(/\r?\n/).at(-1));
    if (!observability || typeof observability.state !== "string") throw new Error("no state in the answer");
    return observability;
  } catch (error) {
    return { state: "unavailable", note: `The observability check did not answer: ${error.message}` };
  }
}

const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL" };

function reportText(report) {
  const lines = [
    `ContextCake doctor: ${report.healthy ? "checks completed" : "needs attention"} (${report.checkedAt})`,
    `CLI version: ${report.cli.version ?? "unknown"}`,
    ...(report.profile ? [`Profile: ${report.profile.label} (${report.profile.id}), ${report.profile.reason}`] : []),
    ...report.checks.map((row) => `${MARK[row.status]}  ${row.message}`),
  ];
  if (report.settings) lines.push(`Effective limits: ${Object.entries(report.settings).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  if (report.executables.length > 1) {
    lines.push("contextcake on PATH:", ...report.executables.map((row) => `  ${row.path}  ${row.version}`));
  }
  lines.push(`Local observability: ${report.observability.state}`);
  lines.push("Folder checks are capped at 100 sources and 15 seconds. MCP sources are not started. No running-app history is read.");
  return lines.join("\n");
}

export default defineFamily({
  name: "doctor",
  stability: "experimental",
  summary: "check the manifest, profile, sources, folders, and installs on PATH",
  commands: [
    {
      summary: "run fresh, bounded diagnostics; exit 8 when a check fails",
      mutation: "read",
      manifest: "optional",
      profile: true,
      coverage: true,
      errors: ["UNHEALTHY_DIAGNOSTICS"],
      output: {
        type: "object",
        required: ["scope", "checkedAt", "healthy", "cli", "manifest", "profile", "settings", "sources", "directories", "executables", "observability", "checks"],
        properties: {
          scope: { const: "fresh-configuration-check" },
          checkedAt: { type: "string" },
          healthy: { type: "boolean" },
          cli: { type: "object", required: ["version"] },
          manifest: { type: "object", required: ["path", "status", "quarantined"], properties: { status: { enum: ["valid", "quarantined", "invalid", "missing"] } } },
          profile: { type: ["object", "null"], properties: { id: { type: "string" }, label: { type: "string" }, reason: { type: "string" }, mode: { type: "string" } } },
          settings: { type: ["object", "null"] },
          sources: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "kind", "status"],
              properties: { status: { enum: ["present", "reachable", "not-directory", "unavailable", "not-probed"] }, reason: { type: "string" } },
            },
          },
          directories: { type: "array", items: { type: "object", required: ["name", "path", "exists", "writable"] } },
          executables: {
            type: "array",
            items: { type: "object", required: ["path", "realpath", "version"], properties: { version: { type: "string", description: "Read from the install's files, never by running it; \"unknown\" when unreadable." }, current: { type: "boolean" } } },
          },
          observability: { type: "object", required: ["state"] },
          checks: {
            type: "array",
            items: { type: "object", required: ["id", "status", "message"], properties: { status: { enum: ["ok", "warn", "fail"] } } },
          },
        },
      },
      async run(ctx) {
        const observability = await probeObservability(ctx);
        const { report, manifestRevision, warnings, suggestions, coverage } = await runDoctor({
          manifestPath: ctx.manifestPath,
          requestedProfile: ctx.flags.profile ?? null,
          cwd: ctx.flags.cwd ? ctx.resolvePath(ctx.flags.cwd) : ctx.cwd,
          env: ctx.env,
          paths: ctx.paths,
          version: ctx.hooks.version ?? null,
          entry: process.argv[1] ?? null,
          observability,
          signal: ctx.signal,
        });
        ctx.setContext({
          manifestRevision,
          profileId: report.profile?.id ?? null,
          profileReason: report.profile?.reason ?? null,
        });
        for (const warning of warnings) ctx.warn(warning.code, warning.message, warning.details);
        for (const row of [...coverage.notProbed, ...coverage.degraded.filter((entry) => entry.status === "not-probed")]) {
          ctx.warn("SOURCE_NOT_PROBED", `${row.source} was not probed: ${row.reason}`, { source: row.source });
        }
        for (const suggestion of suggestions) ctx.suggest(suggestion.command, suggestion.run, suggestion.description);
        const text = reportText(report);
        if (!report.healthy) {
          const failed = report.checks.filter((row) => row.status === "fail");
          const error = new ControlError("UNHEALTHY_DIAGNOSTICS", `${failed.length} check(s) failed: ${failed.map((row) => row.message).join(" ")}`, {
            status: 503,
            detail: { ...report, coverage },
            retryable: true,
            exit: "unhealthy",
          });
          // Human mode prints the whole report, not just the summary line.
          error.text = text;
          throw error;
        }
        return { data: report, coverage, text };
      },
    },
  ],
});
