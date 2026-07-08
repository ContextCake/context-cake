// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://contextcake.com',
	integrations: [
		starlight({
			title: 'ContextCake',
			description:
				'Working context for AI teams. Keep policy, team practice, and local judgment in the same answer.',
			// The marketing 404 (src/pages/404.astro) owns /404 — don't inject Starlight's.
			disable404Route: true,
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/ContextCake/context-cake',
				},
			],
			customCss: ['./src/styles/custom.css'],
			// Sidebar order = reading order (design.md §5)
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Installation', slug: 'docs/getting-started/installation' },
						{ label: 'Your first cascade', slug: 'docs/getting-started/first-cascade' },
						{ label: 'Connect an agent (MCP)', slug: 'docs/getting-started/connect-an-agent' },
					],
				},
				{
					label: 'Concepts',
					items: [
						{ label: 'The layer cake', slug: 'docs/concepts/layer-cake' },
						{ label: 'OKF bundles', slug: 'docs/concepts/okf-bundles' },
						{ label: 'Merge semantics', slug: 'docs/concepts/merge-semantics' },
						{ label: 'Conflicts & provenance', slug: 'docs/concepts/conflicts-and-provenance' },
						{ label: 'The trust boundary', slug: 'docs/concepts/trust-boundary' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Playground tour', slug: 'docs/guides/playground-tour' },
						{ label: 'Foreign MCP sources', slug: 'docs/guides/foreign-mcp-sources' },
						{ label: 'The capture write path', slug: 'docs/guides/capture-write-path' },
						{ label: 'Promoting concepts', slug: 'docs/guides/promoting-concepts' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'layers.json manifest', slug: 'docs/reference/manifest' },
						{ label: 'CLI', slug: 'docs/reference/cli' },
						{ label: 'MCP tools', slug: 'docs/reference/mcp-tools' },
						{ label: 'Override syntax', slug: 'docs/reference/override-syntax' },
						{ label: 'Update checks and privacy', slug: 'docs/reference/updates-and-privacy' },
					],
				},
			],
		}),
	],
});
