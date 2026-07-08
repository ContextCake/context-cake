import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(here, '..');
const repoRoot = path.resolve(siteRoot, '..', '..');
const consoleRoot = path.join(repoRoot, 'apps', 'console');
const consoleDist = path.join(consoleRoot, 'dist');
const targetDir = path.join(siteRoot, 'public', 'demo-app');

async function ensureConsoleDeps() {
	try {
		await execFileP('npm', ['ls'], {
			cwd: consoleRoot,
			env: process.env,
		});
	} catch {
		await execFileP('npm', ['ci'], {
			cwd: consoleRoot,
			env: process.env,
		});
	}
}

async function buildConsole() {
	await execFileP('npm', ['run', 'build', '--', '--base=/demo-app/'], {
		cwd: consoleRoot,
		env: process.env,
	});
}

async function syncDemoBuild() {
	await rm(targetDir, { force: true, recursive: true });
	await mkdir(targetDir, { recursive: true });
	await cp(consoleDist, targetDir, { recursive: true });
}

await ensureConsoleDeps();
await buildConsole();
await syncDemoBuild();

console.log(`[build-console-demo] copied apps/console/dist -> ${path.relative(repoRoot, targetDir)}`);
