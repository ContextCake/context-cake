---
type: tool-guide
updated: 2026-07-06
---

# Using with GitHub Copilot {#using-with-github-copilot}

Copilot Chat draws context from files open or present in your workspace. There's no
plugin or upload step — the pack works as long as its files are checked into the
repository Copilot is attached to.

## Keep the pack files in the workspace {#keep-the-pack-files-in-the-workspace}

Add the pack to your repo, for example under `docs/`:

```bash
mkdir -p docs/data-analytics-team-pack
cp -R data-analytics-team-pack/* docs/data-analytics-team-pack/
git add docs/data-analytics-team-pack
```

Commit it like any other repo doc. Copilot's workspace-wide chat can then draw on it
without you opening every file by hand, though for anything specific — a template, a
workflow — you get more reliable results by opening the file or referencing it directly
(next section).

## Reference files in-chat {#reference-files-in-chat}

In Copilot Chat, use `#file` to attach a specific pack file to your question:

```text
#file:docs/data-analytics-team-pack/templates/insight-summary-template.md
Draft an insight summary for the MRR trend analysis I just finished, using this
template's fields.
```

```text
#file:docs/data-analytics-team-pack/policies-and-rules/source-of-truth-precedence.md
Our dashboard's active-accounts number jumped 20%. Does this policy tell me what to
check first?
```

If you're working in a file that already has the relevant template or workflow open in
another editor tab, Copilot Chat can pick it up from open tabs too — but `#file` is more
reliable when you need a specific document rather than whatever happens to be open.

## Your first task {#your-first-task}

Open `docs/data-analytics-team-pack/workflows/request-clarification.md` and
`docs/data-analytics-team-pack/templates/clarified-spec-template.md` as tabs, then ask
Copilot Chat:

```text
#file:docs/data-analytics-team-pack/workflows/request-clarification.md
#file:docs/data-analytics-team-pack/templates/clarified-spec-template.md
A stakeholder asked "How is MRR trending?" Use these to walk me through clarifying the
request before I write any SQL.
```

You should get the clarified-spec fields back as questions — metric definition, source
of truth, grain, time window, and the rest — not a query. If Copilot answers with SQL
directly, the pack files weren't actually attached; re-add them with `#file`.

## See also {#see-also}

- `../workflows/request-clarification.md`
- `../templates/insight-summary-template.md`
- `../updates/MERGE-GUIDE.md`
