---
type: tool-guide
updated: 2026-07-06
---

# Using with ChatGPT {#using-with-chatgpt}

ChatGPT doesn't read a plugin manifest the way Claude Code does. Instead, you upload the
pack's files as knowledge so a project or custom GPT can search and cite them, then you
reference the specific file you want in your prompt.

## Upload the pack as project files {#upload-the-pack-as-project-files}

1. Create a ChatGPT project (or a custom GPT) dedicated to your team's analytics work.
2. Open the project's file upload area and add the markdown files from the pack. At a
   minimum, upload the four hero-workflow files and the three templates:
   `workflows/stakeholder-request-to-insight.md`, `workflows/request-clarification.md`,
   `workflows/build-and-validate.md`, `workflows/insight-delivery.md`,
   `templates/clarified-spec-template.md`, `templates/validation-checklist-template.md`,
   `templates/insight-summary-template.md`.
3. Upload the rest of the pack (`glossary/`, `policies-and-rules/`, `examples/`) as
   capacity allows — more files means better retrieval when you ask a specific question.

Keep the folder structure in the file names if your upload flow flattens directories
(e.g. rename a duplicate `README.md` to `glossary-source-of-truth.md`) so you can tell
files apart once they're all sitting in one project.

## Reference files in prompts {#reference-files-in-prompts}

ChatGPT's project files are retrieved by relevance, not loaded wholesale, so name the
file you mean instead of describing it vaguely:

```text
Using clarified-spec-template.md from the uploaded pack, help me clarify this stakeholder
request: "Can you send me a chart of how MRR is trending?"
```

```text
I've built the MRR query below. Walk it through validation-checklist-template.md and
tell me what's still unchecked.
```

Naming the exact template or workflow file gets you the actual field list from the pack
instead of ChatGPT improvising a generic checklist from its own training.

## Your first task {#your-first-task}

Upload at minimum `workflows/request-clarification.md` and
`templates/clarified-spec-template.md`, then run the canonical first request:

```text
A stakeholder (VP of Sales) asked: "How is MRR trending?" Using
request-clarification.md and clarified-spec-template.md from the uploaded files, ask me
the clarifying questions I need to answer before I build anything.
```

You should get back questions covering metric definition (committed vs. recognized),
source of truth, grain, segments, and time window — not a query. If ChatGPT jumps
straight to SQL, it didn't retrieve the uploaded files; re-check the upload and re-name
the file in your prompt.

## See also {#see-also}

- `../workflows/request-clarification.md`
- `../templates/clarified-spec-template.md`
- `../examples/worked-example-mrr-request.md`
