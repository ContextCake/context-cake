import rawRelease from './app-release.json';
import { platformsFor, sourceRouteHeading, sourceRouteNames, joinOr } from './app-downloads.mjs';

type Artifact = { name: string; url: string; sha256: string; bytes: number };
export type ReleasePlatform = {
	id: string;
	os: string;
	arch: string;
	osLabel: string;
	label: string;
	platformName: string;
	updates: string;
	downloadPath: string;
	downloadAliases: string[];
	available: boolean;
	installer: Artifact | null;
	updater: Artifact | null;
};
export type AvailablePlatform = ReleasePlatform & { available: true; installer: Artifact };
type PublishedAppRelease = {
	version: string;
	tag: string;
	releaseUrl: string;
	checksumsUrl: string;
	platforms: ReleasePlatform[];
	mcpb?: Artifact;
};
const release = rawRelease as PublishedAppRelease;

// The desktop package version is a release candidate. Public site links come
// from the newest app release that actually exists on GitHub. Production
// workflows refresh this record before building; local/offline builds use the
// committed last-known-good copy instead of inventing a future download URL.
// The rows come from scripts/release-platforms.mjs by way of that sync.
export const appVersion = release.version;
export const appTag = release.tag;
export const appReleaseUrl = release.releaseUrl;
export const appChecksumsUrl = release.checksumsUrl;
export const latestReleaseUrl = release.releaseUrl;
export const appMcpb = release.mcpb;

// Every platform this release can be downloaded for, in table order.
export const appPlatforms = release.platforms.filter((row) => row.available) as AvailablePlatform[];
if (!appPlatforms.length) {
	throw new Error('app-release.json must list at least one available platform');
}
export const macDownloads = platformsFor(release, 'mac') as AvailablePlatform[];
// Empty until a release attaches the .deb; pages render nothing for it then.
export const linuxDownloads = platformsFor(release, 'linux') as AvailablePlatform[];

// The first row is the default one-click download (Apple silicon today).
export const primaryDownload = appPlatforms[0];
export const appDownloadUrl = primaryDownload.downloadPath;

export const sourceRoutePlatforms: string[] = sourceRouteNames(release);
export const sourceRouteList: string = joinOr(sourceRoutePlatforms);
export const sourceRouteTitle: string = sourceRouteHeading(release);
