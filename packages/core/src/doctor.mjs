#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDeadline } from './control/util.mjs';
import { loadProfileRuntime } from './profile-runtime.mjs';
import { resolveSettings } from './settings.mjs';

const safeLabel = (value) =>
  String(value)
    .replace(/(?:ghp_|github_pat_|sk-|AKIA)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Authorization\s*:\s*[^\r\n]+/gi, '[redacted]');

export async function diagnose(manifestPath, profile, observability = null) {
  await withDeadline(fs.access(manifestPath), 1000);
  const runtime = loadProfileRuntime(manifestPath, {
    requestedProfile: profile,
  });
  const sources = [];
  const deadline = Date.now() + 5000;
  for (const layer of runtime.selection.layers) {
    const kind = layer.source ?? 'okf-local';
    let status = 'not-probed';
    if (
      ['files', 'okf-local'].includes(kind) &&
      Date.now() < deadline &&
      sources.length < 100
    ) {
      try {
        status = (
          await withDeadline(
            fs.stat(path.resolve(runtime.manifestDir, layer.path)),
            Math.min(1000, Math.max(1, deadline - Date.now())),
          )
        ).isDirectory()
          ? 'present'
          : 'not-directory';
      } catch {
        status = 'unavailable';
      }
    }
    sources.push({ name: safeLabel(layer.name), kind, status });
  }
  const unhealthy = sources.some((s) =>
    ['unavailable', 'not-directory'].includes(s.status),
  );
  const data = {
    scope: 'fresh-configuration-check',
    checkedAt: new Date().toISOString(),
    configuration: 'valid',
    settings: resolveSettings(runtime.runtimeManifest),
    sources,
    observability: observability ?? {
      state: 'not-checked',
      note: 'Use the desktop CLI for device-local Grafana availability. No running-app history is read.',
    },
  };
  return {
    schemaVersion: 1,
    ok: !unhealthy,
    command: 'doctor',
    context: {
      profileId: safeLabel(runtime.selection.profileId),
      manifestRevision: `sha256:${runtime.revision}`,
    },
    data: unhealthy ? null : data,
    ...(unhealthy
      ? {
          error: {
            code: 'UNHEALTHY_DIAGNOSTICS',
            message: 'One or more source folders need attention.',
            details: data,
            retryable: true,
          },
        }
      : {}),
    warnings: sources
      .filter((s) => s.status === 'not-probed')
      .map((s) => ({ code: 'SOURCE_NOT_PROBED', source: s.name })),
    nextActions: unhealthy
      ? ['Check source folders in ContextCake Sources.']
      : [],
  };
}

export async function main({ observability = null } = {}) {
  const args = process.argv.slice(2);
  let manifest,
    profile,
    json = args.includes('--json');
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--manifest' || args[i] === '--profile') {
        const flag = args[i],
          value = args[++i];
        if (!value || value.startsWith('--'))
          throw Object.assign(new Error('Missing value'), {
            code: 'INVALID_INPUT',
          });
        if (flag === '--manifest') manifest = value;
        else profile = value;
      } else if (args[i] === '--json') json = true;
      else if (args[i] === '--help' || args[i] === '-h') {
        console.log(
          'contextcake doctor --manifest <file> [--profile <id>] [--json]\nFresh configuration and folder checks. Remote sources are not contacted.',
        );
        return;
      } else
        throw Object.assign(new Error('Invalid argument'), {
          code: 'INVALID_INPUT',
        });
    }
    if (!manifest)
      throw Object.assign(new Error('Manifest required'), {
        code: 'INVALID_INPUT',
      });
    const result = await diagnose(manifest, profile, observability);
    const report = result.data ?? result.error.details;
    const summary = [
      `Profile: ${result.context.profileId}`,
      `Fresh diagnostic run: ${result.ok ? 'checks completed' : 'needs attention'} (${report.checkedAt})`,
      `Configuration: ${report.configuration}`,
      `Effective limits: ${Object.entries(report.settings)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')}`,
      ...report.sources.map((s) => `${s.name}: ${s.status}`),
      `Local observability: ${report.observability.state}`,
      'Folder checks are capped at 100 sources and 5 seconds. Remote sources are not probed. No running-app history is read.',
    ].join('\n');
    console.log(json ? JSON.stringify(result) : summary);
    process.exitCode = result.ok ? 0 : 8;
  } catch (error) {
    const code =
      error.code === 'INVALID_INPUT'
        ? 'INVALID_INPUT'
        : error.code === 'ENOENT'
          ? 'NOT_FOUND'
          : ['EACCES', 'EPERM'].includes(error.code)
            ? 'PERMISSION_DENIED'
            : error.code === 'CONTEXTCAKE_TIMEOUT'
              ? 'UNAVAILABLE'
              : 'INVALID_CONFIGURATION';
    const result = {
      schemaVersion: 1,
      ok: false,
      command: 'doctor',
      context: null,
      data: null,
      error: {
        code,
        message: 'The diagnostic configuration could not be read.',
        details: null,
        retryable: false,
      },
      warnings: [],
      nextActions: ['Check the manifest and selected profile.'],
    };
    console.log(
      json ? JSON.stringify(result) : `Diagnostics unavailable: ${code}`,
    );
    process.exitCode =
      { NOT_FOUND: 3, PERMISSION_DENIED: 5, UNAVAILABLE: 6 }[code] ?? 2;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
)
  await main();
