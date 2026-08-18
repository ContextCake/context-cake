// The build scripts' view of src/config/flags.json. Pages import the same file
// through src/config/flags.ts; the visibility rule below must stay identical to
// COMMERCE_VISIBLE there — live payments imply visible commerce.
import { readFile } from 'node:fs/promises'

const FLAGS_URL = new URL('../src/config/flags.json', import.meta.url)

export async function readSiteFlags() {
  return JSON.parse(await readFile(FLAGS_URL, 'utf8'))
}

export function isCommerceVisible(flags = {}) {
  return flags.commerceVisible === true || flags.paymentsLive === true
}
