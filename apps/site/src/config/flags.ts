// Site-wide commerce flags. The values live in flags.json so the plain-Node
// build scripts (scripts/verify-*.mjs, scripts/sync-app-release.mjs,
// scripts/render-redirects.mjs) and astro.config.mjs read the same file the
// pages do — the same arrangement as data/app-release.json. The shape check
// and the visibility rule come from scripts/site-flags.mjs so they exist once.
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
//   reverting the hand-edited docs copy noted in apps/site/CLAUDE.md
//   (public/_redirects is re-rendered from the flags on every build).
import { assertSiteFlags, isCommerceVisible } from '../../scripts/site-flags.mjs';
import rawFlags from './flags.json';

const flags = assertSiteFlags(rawFlags, 'src/config/flags.json');

export const PAYMENTS_LIVE = flags.paymentsLive === true;
export const COMMERCE_VISIBLE = isCommerceVisible(flags);
