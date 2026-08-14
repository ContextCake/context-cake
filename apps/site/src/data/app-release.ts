import rawRelease from './app-release.json';

type Artifact = { name: string; url: string; sha256: string; bytes: number };
type PublishedAppRelease = {
	version: string;
	tag: string;
	releaseUrl: string;
	checksumsUrl: string;
	artifacts: { dmg: Artifact; updaterZip: Artifact; mcpb?: Artifact };
};
const release = rawRelease as PublishedAppRelease;

// The desktop package version is a release candidate. Public site links come
// from the newest app release that actually exists on GitHub. Production
// workflows refresh this record before building; local/offline builds use the
// committed last-known-good copy instead of inventing a future download URL.
export const appVersion = release.version;
export const appTag = release.tag;
export const appDownloadUrl = '/download/mac';
export const appArtifactUrl = release.artifacts.dmg.url;
export const appDownloadName = release.artifacts.dmg.name;
export const appDownloadSha256 = release.artifacts.dmg.sha256;
export const appDownloadBytes = release.artifacts.dmg.bytes;
export const appReleaseUrl = release.releaseUrl;
export const appChecksumsUrl = release.checksumsUrl;
export const latestReleaseUrl = release.releaseUrl;
export const appMcpb = release.artifacts.mcpb;
