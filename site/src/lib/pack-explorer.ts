import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface PackTreeEntry {
	id: string;
	kind: 'dir' | 'file';
	name: string;
	path: string;
	prefix: string;
}

export interface PackFile {
	id: string;
	name: string;
	path: string;
	content: string;
	language: string;
}

export interface PackExplorerData {
	rootLabel: string;
	treeEntries: PackTreeEntry[];
	files: PackFile[];
}

const languageByExtension: Record<string, string> = {
	'.json': 'json',
	'.md': 'md',
	'.yaml': 'yaml',
	'.yml': 'yaml',
};

function toPosix(relativePath: string) {
	return relativePath.split(path.sep).join(path.posix.sep);
}

function getLanguage(filePath: string) {
	return languageByExtension[path.extname(filePath).toLowerCase()] ?? 'text';
}

async function walkTree(
	rootDir: string,
	currentDir: string,
	ancestorsLast: boolean[],
	treeEntries: PackTreeEntry[],
	files: PackFile[],
) {
	const dirents = await readdir(currentDir, { withFileTypes: true });
	const sorted = dirents
		.filter((dirent) => dirent.name !== '.DS_Store')
		.sort((left, right) => {
			if (left.isDirectory() !== right.isDirectory()) {
				return left.isDirectory() ? -1 : 1;
			}

			return left.name.localeCompare(right.name);
		});

	for (const [index, dirent] of sorted.entries()) {
		const absolutePath = path.join(currentDir, dirent.name);
		const relativePath = toPosix(path.relative(rootDir, absolutePath));
		const isLast = index === sorted.length - 1;
		const prefix =
			ancestorsLast.map((entryIsLast) => (entryIsLast ? '    ' : '│   ')).join('') +
			(isLast ? '└── ' : '├── ');

		treeEntries.push({
			id: relativePath,
			kind: dirent.isDirectory() ? 'dir' : 'file',
			name: dirent.name,
			path: relativePath,
			prefix,
		});

		if (dirent.isDirectory()) {
			await walkTree(rootDir, absolutePath, [...ancestorsLast, isLast], treeEntries, files);
			continue;
		}

		files.push({
			id: relativePath,
			name: dirent.name,
			path: relativePath,
			content: await readFile(absolutePath, 'utf8'),
			language: getLanguage(relativePath),
		});
	}
}

export async function loadPackExplorer(rootDir: string, rootLabel: string): Promise<PackExplorerData> {
	const treeEntries: PackTreeEntry[] = [];
	const files: PackFile[] = [];

	await walkTree(rootDir, rootDir, [], treeEntries, files);

	return {
		rootLabel,
		treeEntries,
		files,
	};
}
