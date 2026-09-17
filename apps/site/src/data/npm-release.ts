import rawNpmRelease from './npm-release.json';
import rawAppRelease from './app-release.json';
import { npmCliRoute } from './npm-cli.mjs';

type NpmCliRoute = {
	version: string;
	spec: string;
	tarballIntegrity: string;
	install: string;
	setup: string;
	resolve: string;
	connectClaude: string;
	connectCodex: string;
	npx: string;
	platforms: string;
};

// null until npm has the app release's version. Production workflows refresh
// npm-release.json after the app record; the committed copy says unpublished.
export const npmCli = npmCliRoute(rawNpmRelease, rawAppRelease) as NpmCliRoute | null;
export { WSL_MANIFEST_NOTE } from './npm-cli.mjs';
