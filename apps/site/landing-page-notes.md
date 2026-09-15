# Landing page: positioning and evidence

## Audience and promise

Developers who use coding agents and already maintain project documentation,
team decisions, runbooks, or personal notes. The first screen identifies the
product as a local app and names its job: project knowledge for a coding agent.

Explain the benefit before naming the architecture. The story moves from missing
project context to source setup and priority, then demonstrates a combined result.
Introduce “cascade” only after showing how matching sections inherit. Introduce
“knowledge graph” through links between decisions and runbooks.

## Design references

Reviewed September 15, 2026. These inform information order and evidence, not
claims about conversion rates or styles to copy wholesale.

- [Resend](https://resend.com/): a short category-and-audience headline, followed by
  a usable code example. Borrow the specificity and proximity of evidence.
- [Linear](https://linear.app/): product screens and recognizable work carry much
  of the explanation. Give the actual ContextCake Library a substantial view.
- [Warp](https://www.warp.dev/): configuration examples make an abstract system
  concrete. ContextCake’s equivalent is a readable resolver result.
- [GitBook](https://www.gitbook.com/): an adjacent knowledge product, useful for
  checking that ContextCake explains its distinct source-priority behavior.

The existing Bricolage Grotesque typeface and amber / teal / blue source colors
remain the identity. The homepage uses a flat background, a simpler header,
legible result excerpts, and varied section layouts. Color identifies source
provenance; it is not a decorative promise of intelligence.

## Claim boundaries

- ContextCake retrieves and combines context; the connected AI tool generates its
  own response. Do not present a fabricated chat answer as engine output.
- `ContextPreview.astro` imports the build-generated demo result. Excerpts retain
  their source and available date. The differing database-choice text is shown in
  full; the other two selected sections show their first sentence.
- Combining versions requires matching concept IDs and section keys. The FAQ
  states this directly; the engine does not infer semantic equivalence between
  unrelated files.
- Local processing does not mean an AI provider never sees retrieved content.
  The FAQ explains the handoff to the connected AI tool.
- The six default MCP tools are read-only. Captures are opt-in. Preview approval
  shares an unreviewed capture with the team; promotion is a separate review step
  that moves it into durable team context.
- Packs are secondary to the core explanation and remain available in the FAQ
  and footer. Commerce flags and release-derived download routing are unchanged.
- No testimonials, adoption counts, speed claims, or conversion improvements are
  asserted without evidence.

## Product image provenance

`src/assets/context-library.webp` is a browser capture of the canonical Web Demo:
`https://contextcake-console.pages.dev/#/concepts/decisions%2Fprimary-db`, captured
September 15, 2026 at 1440 × 960. It shows the real Library with bundled sample
content and the visible simulation notice. It is not a mocked app window. Astro
emits responsive, compressed sizes, and the page lazy-loads the image.

## Review boundary

The mobile layout intentionally shows the definition and actions first, with the
full readable result directly below, rather than shrinking the example to fit one
screen. Content and FAQs work without JavaScript. The enhanced mobile menu and
saved theme preference use the existing local-only layout script.

A successful build and responsive QA establish that the page works. Whether new
visitors understand it faster still requires observing first-time readers; this
revision does not claim a measured comprehension or conversion improvement.

## Verification of this revision

- Site production build and install/commerce gates pass (41 generated pages).
- Full repository gate: 59/59 suites pass.
- Browser widths: 320, 375, 390, 768, 1024, 1440, in both light and dark themes;
  no horizontal document overflow or broken images.
- All 24 unique internal page links from the homepage return HTTP 200 locally.
  The unchanged `/download/mac` redirect remains generated from release metadata.
- Mobile menu: all four links visible in both themes; anchor navigation closes
  it; Escape closes it and returns focus. FAQs open and close from the keyboard.
- JavaScript-disabled check: navigation, readable output, and native FAQs work.
- Reduced-motion check: FAQ indicator transitions become instantaneous.
- Rendered text contrast check, including expanded FAQs: no failures; minimum
  5.96:1 in dark mode and 5.18:1 in light mode. This checks text colors over the
  rendered CSS backgrounds, not text embedded in the product screenshot.
- Clean browser context: no page errors and no third-party asset requests.
- Social preview regenerated from `scripts/prepare-social-preview.mjs`, then
  captured at 1200 × 630 after fonts loaded. It contains no simulated AI answer.
