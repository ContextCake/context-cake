import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  COPY_PATTERNS,
  LINK_PATTERNS,
  normalizeEncodings,
  scanHtml,
  scanSitemap,
  stripExempt,
  verifyDist,
} from '../../apps/site/scripts/verify-commerce-hidden.mjs'
import { assertSiteFlags, isCommerceVisible, isHiddenCommercePath } from '../../apps/site/scripts/site-flags.mjs'

const page = (body) => `<!doctype html><html><body><main>${body}</main></body></html>`

test('the pattern lists cover the surfaces the plan named', () => {
  const all = [...LINK_PATTERNS, ...COPY_PATTERNS].map(String)
  for (const expected of ['/\\$\\d/', '/href="\\/pricing/', '/>Pricing</', '/Coming soon/', '/lemonsqueezy/i', '/Target license/']) {
    assert.ok(all.includes(expected), `missing pattern ${expected}`)
  }
  // Bare commerce-adjacent words stay legal (git checkout, MIT license, billing-api demo data).
  assert.deepEqual(scanHtml(page('<p>git checkout main · MIT license · billing-api · a paid subscription word</p>'), 'x/index.html'), [])
})

test('a price outside the exempt region fails and inside it passes', () => {
  const leak = page('<p>Personal license $99</p>')
  const failures = scanHtml(leak, 'packs/x/index.html')
  assert.equal(failures.length, 1)
  assert.match(failures[0], /packs\/x\/index\.html: \/\\\$\\d\//)

  const exempt = page('<section><h2>Browse</h2><div class="explorer-preview" data-verify-exempt="pack-files"><article><div class="body">Revenue was $1,842,000 in the subscription ledger.</div></article></div></section>')
  assert.deepEqual(scanHtml(exempt, 'packs/x/index.html'), [])

  // Copy right after the exempt element is still in scope: the strip ends at
  // the element's own closing tag, not at the next section.
  const after = page('<div data-verify-exempt="pack-files"><div>$5 inside</div></div><p>See app pricing</p>')
  const afterFailures = scanHtml(after, 'packs/x/index.html')
  assert.equal(afterFailures.length, 1)
  assert.match(afterFailures[0], /See app pricing/)
})

test('stripExempt removes only the marked element and fails closed', () => {
  assert.equal(stripExempt('<a><b data-verify-exempt="x"><b>in</b></b><c>out</c></a>'), '<a><c>out</c></a>')
  assert.equal(stripExempt('<p>none</p>'), '<p>none</p>')
  assert.equal(
    stripExempt('<i data-verify-exempt="one">1</i> keep <i data-verify-exempt="two">2</i> keep'),
    ' keep  keep',
  )
  assert.throws(() => stripExempt('<div data-verify-exempt="x"><div>never closed</div>', 'p.html'), /p\.html: data-verify-exempt="x" <div> never closes/)
  assert.throws(() => stripExempt('text data-verify-exempt="x" text', 'p.html'), /not inside an opening tag/)
})

test('encoded forms of a leak are caught', () => {
  assert.equal(normalizeEncodings('&#36;99 &dollar;5 &#x24;1 %2499 &gt;Pricing&lt; a%20b &amp;#36;'), '$99 $5 $1 $99 >Pricing< a b &#36;')

  const entity = scanHtml(page('<p>Only &#36;99</p>'), 'x/index.html')
  assert.equal(entity.length, 1)
  assert.match(entity[0], /after decoding/)

  const percent = scanHtml(page('<a href="mailto:x@example.com?subject=Founding%20creator%20application">apply</a>'), 'x/index.html')
  assert.equal(percent.length, 1)
  assert.match(percent[0], /founding creator/)

  // An entity-escaped attribute inside inlined markup still counts as the link.
  const escapedLink = scanHtml(page('<p>&lt;a href=&quot;/pricing&quot;&gt;Pricing&lt;/a&gt;</p>'), 'x/index.html')
  assert.equal(escapedLink.length, 2)
  assert.match(escapedLink[0], /href="\\\/pricing/)
  assert.match(escapedLink[1], />Pricing</)
})

test('the changelog page ignores copy patterns but not link patterns', () => {
  const notes = page('<article><p>Coming soon: $5 things and ContextCake Pro</p></article>')
  assert.deepEqual(scanHtml(notes, 'changelog/index.html'), [])
  assert.equal(scanHtml(notes, 'docs/index.html').length, 3)

  const withLink = page('<a href="/pricing">Pricing</a>')
  const failures = scanHtml(withLink, 'changelog/index.html')
  assert.equal(failures.length, 2)
  assert.match(failures[0], /href="\\\/pricing/)
  assert.match(failures[1], />Pricing</)
})

test('sitemaps may not list hidden commerce routes', () => {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://contextcake.com/</loc></url>
    <url><loc>https://contextcake.com/pricing/</loc></url>
    <url><loc>https://contextcake.com/creators</loc></url>
    <url><loc>https://contextcake.com/packs/</loc></url>
    <url><loc>https://contextcake.com/docs/reference/pricing-history/</loc></url>
  </urlset>`
  const failures = scanSitemap(xml, 'sitemap-0.xml')
  assert.deepEqual(failures, [
    'sitemap-0.xml: lists https://contextcake.com/pricing/ while commerce is hidden',
    'sitemap-0.xml: lists https://contextcake.com/creators while commerce is hidden',
  ])
  assert.equal(isHiddenCommercePath('/pricing'), true)
  assert.equal(isHiddenCommercePath('/pricing/'), true)
  assert.equal(isHiddenCommercePath('/pricing/history'), false)
})

test('verifyDist walks pages and sitemaps together', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-dist-'))
  try {
    await mkdir(join(dir, 'packs', 'x'), { recursive: true })
    await writeFile(join(dir, 'index.html'), page('<p>fine</p>'))
    await writeFile(join(dir, 'packs', 'x', 'index.html'), page('<div data-verify-exempt="pack-files"><p>$1</p></div><p>Target license</p>'))
    await writeFile(join(dir, 'sitemap-0.xml'), '<urlset><url><loc>https://contextcake.com/creators/</loc></url></urlset>')
    const result = await verifyDist(dir)
    assert.equal(result.pages, 2)
    assert.equal(result.sitemaps, 1)
    assert.equal(result.failures.length, 2)
    assert.match(result.failures[0], /packs\/x\/index\.html: \/Target license\//)
    assert.match(result.failures[1], /sitemap-0\.xml: lists .*\/creators\//)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('site flags are shape-checked and null-safe', () => {
  assert.deepEqual(assertSiteFlags({ commerceVisible: false, paymentsLive: false }), { commerceVisible: false, paymentsLive: false })
  assert.throws(() => assertSiteFlags(null, 'f.json'), /f\.json: expected an object/)
  assert.throws(() => assertSiteFlags([], 'f.json'), /f\.json: expected an object/)
  assert.throws(() => assertSiteFlags({ commerceVisible: false, paymentsLive: false, extra: true }, 'f.json'), /unknown key\(s\) extra/)
  assert.throws(() => assertSiteFlags({ commerceVisible: 'false', paymentsLive: false }, 'f.json'), /commerceVisible must be true or false, got "false"/)
  assert.equal(isCommerceVisible(null), false)
  assert.equal(isCommerceVisible(undefined), false)
  assert.equal(isCommerceVisible({ commerceVisible: false, paymentsLive: true }), true)
})
