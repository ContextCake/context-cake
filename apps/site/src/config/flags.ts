// Site-wide commerce flags. The values live in flags.json so the plain-Node
// build scripts (scripts/verify-*.mjs, scripts/sync-app-release.mjs) read the
// same file the pages do — the same arrangement as data/app-release.json.
//
// These are constants, not environment variables, on purpose: flipping one is a
// reviewable diff, and the committed value is what every build (local, preview,
// production) renders. If a per-preview toggle is ever wanted, `astro:env` is the
// place to add it; do not read process.env here.
//
// - paymentsLive: checkout links are real and clickable.
// - commerceVisible: prices, plans, /pricing, /creators, and creator-program
//   copy render at all. Hidden means hidden, not deleted — data/commerce.ts and
//   the pricing/creators pages stay in the tree, so a flip is this file plus
//   regenerating public/_redirects (scripts/sync-app-release.mjs does that in CI)
//   and reverting the hand-edited docs copy noted in apps/site/CLAUDE.md.
import rawFlags from './flags.json';

type SiteFlags = { commerceVisible: boolean; paymentsLive: boolean };
const flags = rawFlags as SiteFlags;

export const PAYMENTS_LIVE = flags.paymentsLive === true;
// Live payments imply visible commerce; the two are never allowed to disagree.
export const COMMERCE_VISIBLE = flags.commerceVisible === true || PAYMENTS_LIVE;
