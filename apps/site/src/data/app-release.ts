// The one place the site pins the shipped Mac app version. Both pages that
// render a version string or a direct DMG link (index.astro, install.astro)
// import from here, so a release bumps exactly one line. Update it only after
// the matching app-v* tag has published — the site deploys on merge, and a
// version named here must already be downloadable.
export const appVersion = '0.4.0';
export const appTag = `app-v${appVersion}`;
export const appDownloadUrl = `https://github.com/ContextCake/context-cake/releases/download/${appTag}/ContextCake-${appVersion}-arm64.dmg`;
export const appReleaseUrl = `https://github.com/ContextCake/context-cake/releases/tag/${appTag}`;
// Evergreen link for prose and docs — always the newest app release page.
export const latestReleaseUrl = 'https://github.com/ContextCake/context-cake/releases/latest';
