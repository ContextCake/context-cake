import desktopPackage from '../../../desktop/package.json';

// ContextCake has one product version. The site, hosted Web Demo, and packaged
// app all derive it from the desktop package used by electron-builder.
export const appVersion = desktopPackage.version;
export const appTag = `app-v${appVersion}`;
export const appDownloadUrl = `https://github.com/ContextCake/context-cake/releases/download/${appTag}/ContextCake-${appVersion}-arm64.dmg`;
export const appReleaseUrl = `https://github.com/ContextCake/context-cake/releases/tag/${appTag}`;
// Evergreen link for prose and docs — always the newest app release page.
export const latestReleaseUrl = 'https://github.com/ContextCake/context-cake/releases/latest';
