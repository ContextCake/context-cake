# ContextCake public-site voice

ContextCake should sound like a knowledgeable coworker explaining a technical product.
The landing page speaks first to developers using coding agents and technical leads
maintaining project knowledge. Name the tools and files they recognize. Documentation
and other product pages should remain accessible to people who manage or write knowledge
without writing code.

## The voice

Use plain sentences and exact technical terms. The writing should help a reader understand
the product and decide what to do next without sounding like a sales script.

- **Plain:** Use familiar words and complete sentences. Do not make the reader decode the
  product before they can decide whether it is relevant.
- **Technically grounded:** Use the correct term when it adds precision. Explain what that
  term changes for the reader the first time it appears. Put proof beside the claim it supports.

The tone is calm and direct. It is not cute, grand, breathless, or self-congratulatory.

## Writing rules

1. **Say what it does first.** Identify ContextCake as a local app that connects project
   knowledge to coding agents. Start with files, sources, and AI tools. Introduce the
   architecture after the reader has a concrete picture.
2. **Use specific nouns and verbs.** Prefer "ContextCake reads a Markdown folder" to
   "bring your knowledge into one powerful workspace."
3. **Keep one main idea in each sentence.** Short paragraphs are easier to scan, but do not
   turn every thought into a slogan or fragment.
4. **Explain technical terms by consequence.** "MCP is the local connection that lets a
   compatible AI tool search and read your ContextCake sources" is more useful than
   "MCP-ready."
5. **Earn every claim.** Use the exact fact: signed and notarized, six read-only tools, no
   runtime packages, a source on every section, and a date when the source provides one.
6. **Use the same name for the same thing.** The homepage uses "coding agent" for its
   audience's workflow and "AI tool" for the application they connect. Use "MCP client"
   when protocol compatibility matters; avoid rotating between terms for variety.
7. **Make headings informative.** A reader scanning only the headings should understand the
   page. Buttons should name the action: "Download for Mac," "Open the demo," "See all
   install options."
8. **Write in present tense and active voice.** Contractions are fine. Sentence case is the
   default.

## Terms to use carefully

- **Layer:** a source with a priority, such as company, team, or personal. Show the examples
  before relying on the term.
- **Resolve:** choose which source supplies each section. Do not use it as a vague synonym
  for answer, combine, or fix.
- **Source:** a folder, repository, OKF bundle, or trusted MCP graph that ContextCake reads.
- **MCP:** the local connection that lets a compatible AI tool use ContextCake. Expand the
  protocol name in documentation, not in every marketing headline.
- **Pack:** a folder of rules, templates, examples, and reference material for a specific
  kind of work.

Avoid abstract or inflated phrases such as "working knowledge," "effective view," "unlock,"
"seamless," "powerful," "future of work," "technical landscape," and "single source of
truth." Avoid forced three-part slogans, rhetorical questions used only as transitions, and
headlines that are clever before they are clear.

## Page pattern

1. Name the outcome in the headline.
2. Explain how ContextCake produces it in one short paragraph.
3. Offer one main action and a small number of literal alternatives.
4. Show the product or a real result.
5. Explain the model with a concrete example.
6. Put install, compatibility, privacy, and trust facts near the decision they affect.

## Examples

| Avoid | Prefer |
|---|---|
| Keep your working knowledge where your AI tools can use it. | Give your AI tools one sourced answer from the docs you already have. |
| Different rules belong to different people. | Your docs do not all say the same thing. |
| The closest relevant layer wins. | ContextCake resolves one section at a time. |
| A small MCP interface. | Six read-only MCP tools. |
| Install the app. Add your knowledge. Ask your agent. | Download ContextCake for Mac. |

## Research basis

The useful common pattern across the reviewed sites was not a shared personality. It was a
shared order: state the job, name the object, show the action, then supply technical proof.

- [Microsoft Writing Style Guide](https://learn.microsoft.com/en-us/style-guide/brand-voice-above-all-simple-human): put the key takeaway first, use everyday words, and write for scanning.
- [Tailscale](https://tailscale.com/): pairs a plain setup promise with concrete networking and security details.
- [1Password Business](https://1password.com/business-security): leads with the familiar job, then groups technical detail by the work it supports.
- [Notion product overview](https://www.notion.com/product/notion): answers what the product is before expanding into use cases.
- [GitBook](https://www.gitbook.com/): uses a specific product problem, then explains the system that addresses it.

These are references for information order and clarity, not voices to imitate.

The September 2026 landing-page revision adds developer-product references and explicit
copy boundaries in `apps/site/landing-page-notes.md`. In particular, distinguish retrieved
context from generated answers, source priority from correctness, and local processing
from the connected AI tool's data handling.
