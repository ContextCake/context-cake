// Pure views over the committed release record (app-release.json), shared by
// the pages (through app-release.ts) and scripts/verify-install-page.mjs so the
// verifier checks the same strings the pages render.
//
// The record has one row per release platform. A row is `available` when the
// published release attached its installer; older releases carry Apple silicon
// only. Pages render the available rows and send everyone else to the source
// route, so a new platform row needs no page edit.

export function availablePlatforms(record) {
	return record.platforms.filter((row) => row.available)
}

export function platformsFor(record, os) {
	return availablePlatforms(record).filter((row) => row.os === os)
}

// Platforms with no native download in this release, in sentence form. Linux
// and WSL stay on the source route until a release carries a Linux row.
export function sourceRouteNames(record) {
	const available = new Set(availablePlatforms(record).map((row) => row.platformName))
	const names = [
		...record.platforms.filter((row) => !row.available).map((row) => row.platformName),
		'Linux',
		'WSL',
	]
	return [...new Set(names)].filter((name) => !available.has(name))
}

export function joinOr(names) {
	if (names.length <= 1) return names.join('')
	if (names.length === 2) return `${names[0]} or ${names[1]}`
	return `${names.slice(0, -1).join(', ')}, or ${names.at(-1)}`
}

export function sourceRouteHeading(record) {
	return `Run the source version on ${joinOr(sourceRouteNames(record))}.`
}

export function formatFileSize(bytes) {
	return `${(bytes / 1_048_576).toFixed(1)} MB`
}
