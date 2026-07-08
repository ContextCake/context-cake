import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createMarkdownProcessor } from '@astrojs/markdown-remark';

export interface PackTreeEntry {
	id: string;
	kind: 'dir' | 'file';
	name: string;
	path: string;
	/** Depth from the pack root (0 = top level). */
	depth: number;
	/** Path of the containing directory ('' when top level). */
	parent: string;
}

export interface PackFile {
	id: string;
	name: string;
	path: string;
	/** Raw file source (used for the "Source" view). */
	content: string;
	language: string;
	/** Rendered markdown HTML for the "Rendered" view; null for non-markdown. */
	renderedHtml: string | null;
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

/** Remove a leading YAML frontmatter block so the rendered view shows only the body. */
function stripFrontmatter(source: string) {
	if (!source.startsWith('---')) return source;
	const end = source.indexOf('\n---', 3);
	if (end === -1) return source;
	return source.slice(end + 4).replace(/^\r?\n/, '');
}

/** Drop explicit `{#anchor}` / `{#anchor override=…}` attributes from headings for clean rendering. */
function stripHeadingAnchors(source: string) {
	return source.replace(/^(#{1,6}[ \t]+.*?)[ \t]*\{#[^}]*\}[ \t]*$/gm, '$1');
}

let processorPromise: ReturnType<typeof createMarkdownProcessor> | null = null;
function getProcessor() {
	if (!processorPromise) {
		processorPromise = createMarkdownProcessor({
			shikiConfig: { theme: 'github-dark-default' },
		});
	}
	return processorPromise;
}

async function renderMarkdown(raw: string): Promise<string> {
	const body = stripHeadingAnchors(stripFrontmatter(raw));
	const processor = await getProcessor();
	const { code } = await processor.render(body);
	return code;
}

async function walkTree(
	rootDir: string,
	currentDir: string,
	parentPath: string,
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

	for (const dirent of sorted) {
		const absolutePath = path.join(currentDir, dirent.name);
		const relativePath = toPosix(path.relative(rootDir, absolutePath));
		const depth = relativePath.split('/').length - 1;

		treeEntries.push({
			id: relativePath,
			kind: dirent.isDirectory() ? 'dir' : 'file',
			name: dirent.name,
			path: relativePath,
			depth,
			parent: parentPath,
		});

		if (dirent.isDirectory()) {
			await walkTree(rootDir, absolutePath, relativePath, treeEntries, files);
			continue;
		}

		const raw = await readFile(absolutePath, 'utf8');
		const language = getLanguage(relativePath);
		files.push({
			id: relativePath,
			name: dirent.name,
			path: relativePath,
			content: raw,
			language,
			renderedHtml: language === 'md' ? await renderMarkdown(raw) : null,
		});
	}
}

export async function loadPackExplorer(rootDir: string, rootLabel: string): Promise<PackExplorerData> {
	const treeEntries: PackTreeEntry[] = [];
	const files: PackFile[] = [];

	await walkTree(rootDir, rootDir, '', treeEntries, files);

	return {
		rootLabel,
		treeEntries,
		files,
	};
}
