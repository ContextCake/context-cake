export interface ApplicationPlan {
	id: 'free' | 'pro' | 'team';
	name: string;
	price: string;
	annual: string;
	status: 'Available' | 'Coming soon';
	stripe: 'personal' | 'team' | 'company';
	summary: string;
	features: string[];
}

export const applicationPlans: ApplicationPlan[] = [
	{
		id: 'free',
		name: 'Free',
		price: '$0 forever',
		annual: 'No account required',
		status: 'Available',
		stripe: 'personal',
		summary: 'All local features, including Pack installation and authoring. No account required.',
		features: [
			'Unlimited local sources, layers, and profiles',
			'Resolution, provenance, conflicts, and MCP access',
			'Pack authoring, import, export, and installation',
			'Install any free Pack or Pack you purchase',
		],
	},
	{
		id: 'pro',
		name: 'Pro',
		price: '$9 / month',
		annual: '$90 annually · save $18',
		status: 'Coming soon',
		stripe: 'team',
		summary: 'Sync settings, profiles, and Pack entitlements across your devices and supported tools.',
		features: [
			'Cross-device settings, profile, and entitlement sync',
			'Reviewable Pack updates with diff and rollback',
			'Linked Pack deployment across supported local tools',
			'90-day version history and priority support',
		],
	},
	{
		id: 'team',
		name: 'Team',
		price: '$29 / month',
		annual: '$290 annually · save $58 · 3 seats included',
		status: 'Coming soon',
		stripe: 'company',
		summary: 'Give a small team a shared Pack catalog and control when Pack updates roll out.',
		features: [
			'Everything in Pro for three members',
			'Approved Pack catalog and Pack assignment',
			'Staged or pinned updates, roles, and admin history',
			'Additional seats: $7/month',
		],
	},
];

export const planComparison = [
	['Local sources, layers, and profiles', 'Unlimited', 'Unlimited', 'Unlimited'],
	['Local resolution and MCP access', 'Included', 'Included', 'Included'],
	['Install free or purchased Packs', 'Included', 'Included', 'Included'],
	['Cross-device settings and entitlements', 'Manual', 'Managed', 'Managed'],
	['Pack update diff and rollback', 'Manual', '90 days', 'Team policy'],
	['Pack assignment and staged rollout', '—', '—', 'Included'],
];

export const packPriceBands = [
	{ depth: 'Focused starter', personal: '$19', team: '$49', description: 'One bounded method, checklist, or recurring task.' },
	{ depth: 'Complete workflow', personal: '$49', team: '$129', description: 'A full beginning-to-end workflow with examples and templates.' },
	{ depth: 'Professional system', personal: '$99', team: '$249', description: 'Several connected workflows with rules, references, and tool guidance.' },
	{ depth: 'Extensive practice library', personal: '$149', team: '$399', description: 'A larger library that covers several parts of a professional practice.' },
];

export const foundingCreator = {
	limit: 20,
	launchShare: '90%',
	launchPeriod: 'first 12 months',
	standardShare: '80%',
};

export const catalogPacks = [
	{
		id: 'contextcake',
		name: 'ContextCake Context Pack',
		href: '/packs/contextcake',
		creator: 'ContextCake',
		status: 'Available free',
		price: 'Free',
		teamPrice: 'Free',
		reviewedAt: 'July 17, 2026',
		updateCadence: 'As the product evolves',
		workflow: 'Understand ContextCake, install it, write a layer, and connect an agent.',
		summary: 'Architecture, examples, setup instructions, and common mistakes for anyone using or extending ContextCake.',
		formats: ['Plain files', 'Claude Code', 'ChatGPT', 'Cursor', 'Copilot'],
		accent: 'team',
	},
	{
		id: 'data-analytics-team',
		name: 'Data & Analytics Teams',
		href: '/packs/data-analytics-teams',
		creator: 'ContextCake',
		status: 'Free preview · paid launch coming soon',
		price: '$99 personal',
		teamPrice: '$249 team · up to 5',
		reviewedAt: 'July 17, 2026',
		updateCadence: 'Monthly editorial releases planned',
		workflow: 'Clarify a stakeholder request, build against the source of truth, validate it, and deliver the insight.',
		summary: 'A repeatable process for analytics requests, with templates, validation rules, examples, and tool guidance.',
		formats: ['Plain files', 'Claude Code', 'ChatGPT', 'Cursor', 'Copilot'],
		accent: 'personal',
	},
] as const;
