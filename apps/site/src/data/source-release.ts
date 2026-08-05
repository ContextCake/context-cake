// Source installation is an immutable, checksum-pinned snapshot. It uses the
// unified app-v* namespace but advances only after GitHub has generated the
// archive and its exact bytes have been verified.
import sourceRelease from './source-release.json';

export const sourceVersion = sourceRelease.version;
export const sourceTag = `app-v${sourceVersion}`;
export const sourceDownloadUrl = `https://github.com/ContextCake/context-cake/archive/refs/tags/${sourceTag}.tar.gz`;
export const sourceArchiveSha256 = sourceRelease.sha256;
