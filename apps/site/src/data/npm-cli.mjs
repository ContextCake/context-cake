// Pure views over the committed npm record (npm-release.json), shared by the
// pages (through npm-release.ts) and scripts/verify-install-page.mjs so the
// verifier checks the same commands the pages render.
//
// The npm route exists only when the record says npm has the version of the
// app release the site links. scripts/sync-npm-release.mjs already compares
// the two; checking again here keeps a stale record from pinning a version
// the rest of the page does not name.

export function npmCliRoute(npmRecord, appRecord) {
	if (npmRecord?.published !== true || npmRecord.version !== appRecord.version) return null
	const version = npmRecord.version
	const spec = `contextcake@${version}`
	return {
		version,
		spec,
		tarballIntegrity: npmRecord.tarballIntegrity,
		install: `npm install -g ${spec}`,
		setup: 'contextcake init\ncontextcake source add notes --path ~/Documents/notes',
		// Harness settings name the executable they resolved, never a bare
		// `contextcake` a later PATH change could swap (control-plane §5.11).
		resolve: 'command -v contextcake',
		connectClaude: 'claude mcp add --scope user contextcake -- "$(command -v contextcake)" mcp',
		connectCodex: 'codex mcp add contextcake -- "$(command -v contextcake)" mcp',
		npx: `npx --yes ${spec} init`,
		platforms: 'macOS, Linux, and WSL',
	}
}

export const WSL_MANIFEST_NOTE =
	'In WSL, the CLI keeps its own manifest in ~/.config/contextcake. It does not share a manifest with an app installed on Windows.'
