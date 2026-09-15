#!/usr/bin/env node
// Generate a self-contained 1200x630 share-card source. Render it in a browser
// at 1200x630, await document.fonts.ready, and save the viewport to public/og.png.
// Output is deliberately outside src/pages: this is not a public site route.
import { readFileSync, writeFileSync } from 'node:fs';
const read = (path) => readFileSync(new URL(path, import.meta.url));
const tokens = read('../src/styles/tokens.css').toString();
const font = read('../node_modules/@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-600-normal.woff2').toString('base64');
const logo = read('../../../assets/brand/contextcake-app-icon.svg').toString('base64');
const out = process.argv[2];
if (!out) throw new Error('Usage: node scripts/prepare-social-preview.mjs <output.html>');
writeFileSync(out, `<!doctype html><html lang="en"><meta charset="utf-8"><title>ContextCake social preview</title><style>
${tokens}
@font-face {font-family: Card;src:url(data:font/woff2;base64,${font});font-weight:600}
* {box-sizing:border-box} body {margin:0;width:1200px;height:630px;padding:58px 64px;background:var(--cc-canvas);color:var(--cc-text);font-family:Card,sans-serif;font-weight:600}
header {display:flex;align-items:center;gap:15px;font-size:27px} header img {width:45px;height:45px}
main {display:grid;grid-template-columns:700px 1fr;gap:24px;align-items:center;margin-top:64px} h1 {font-size:64px;line-height:1.08;letter-spacing:-.03em;margin:0 0 26px} h1 span {color:var(--cc-text-muted)} p {font-size:23px;line-height:1.5;color:var(--cc-text-body);margin:0;max-width:650px}
.sources {display:flex;flex-direction:column;align-items:flex-end;gap:12px;font-size:19px;color:var(--cc-on-cta)} .sources span {padding:18px 21px;border-radius:6px;width:230px;background:var(--cc-layer-personal)} .sources span:nth-child(2) {width:265px;background:var(--cc-layer-team)} .sources span:nth-child(3) {width:300px;background:var(--cc-layer-company)}
footer {position:absolute;top:552px;width:1072px;border-top:1px solid var(--cc-border-strong);padding-top:20px;display:flex;justify-content:space-between;font-size:17px;color:var(--cc-text-muted)}
</style><header><img src="data:image/svg+xml;base64,${logo}" alt="">ContextCake</header><main><div><h1>Project knowledge.<br><span>For your coding agent.</span></h1><p>Connect your sources. Set their priority.<br>Keep disagreements visible.</p></div><div class="sources" aria-label="Sources"><span>Personal notes</span><span>Team decisions</span><span>Project docs</span></div></main><footer><span>Local app · Markdown + GitHub · MCP</span><span>contextcake.com</span></footer></html>`);
console.log(`Prepared ${out}; render at 1200x630 after fonts load.`);
