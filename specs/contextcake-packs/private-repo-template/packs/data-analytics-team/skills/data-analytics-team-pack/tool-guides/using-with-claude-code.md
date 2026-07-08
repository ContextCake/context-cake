---
type: tool-guide
updated: 2026-07-06
---

# Using with Claude Code {#using-with-claude-code}

This pack ships as a Claude Code plugin. Once installed, `SKILL.md` and every file it
routes to are available to Claude Code as project context — you don't paste anything in,
you just ask for the work and Claude Code reads the relevant pack files on its own.

## Install from the private marketplace {#install-from-the-private-marketplace}

If your organization has read-only collaborator access to the ContextCake Packs private
marketplace, add it and install the pack:

```bash
claude plugin marketplace add contextcake/contextcake-packs
claude plugin install data-analytics-team-pack
```

Collaborator access is read-only: you can pull updates but not push changes back to the
marketplace repo. To pick up a new release, run:

```bash
claude plugin marketplace update contextcake/contextcake-packs
claude plugin update data-analytics-team-pack
```

## Install from the unzipped files {#install-from-the-unzipped-files}

If you received the pack as a zip instead of marketplace access, unzip it anywhere on
disk and point Claude Code at the directory directly with `--plugin-dir` — no
marketplace registration needed:

```bash
unzip data-analytics-team-pack.zip -d ~/packs/data-analytics-team-pack
claude --plugin-dir ~/packs/data-analytics-team-pack
```

This loads the pack for that session. To load it every session in a given project, add
the same `--plugin-dir` flag to your project's Claude Code launch alias or wrapper
script.

## Where the files go {#where-the-files-go}

Whichever install path you use, the pack's directory structure is unchanged: `SKILL.md`
at the root, with `overview/`, `glossary/`, `workflows/`, `templates/`,
`policies-and-rules/`, `prompt-guides/`, `examples/`, and `tool-guides/` beneath it.
Claude Code reads `SKILL.md` first and follows its links into the rest of the pack as
needed — it does not load every file into context up front.

Do not edit files inside the installed plugin directory. If your team needs local
exceptions (a different source-of-truth system, a house style tweak), put them in your
own project context, not inside the pack. See `../local-overlay/README.md` for the
pattern.

## Your first task {#your-first-task}

Confirm the install worked by running the hero workflow on a real request. In a Claude
Code session inside your project, ask:

```text
A stakeholder wants to know how MRR is trending. Use the data-analytics-team-pack
workflow to help me clarify this request before I build anything.
```

Claude Code should pull in `workflows/request-clarification.md` and
`templates/clarified-spec-template.md`, then walk you through the clarified-spec fields
(source of truth, metric definition, grain, time window, and the rest) instead of
jumping straight to a query. That's the pack working correctly — clarify before build,
every time.

## See also {#see-also}

- `../SKILL.md`
- `../workflows/stakeholder-request-to-insight.md`
- `../updates/MERGE-GUIDE.md`
