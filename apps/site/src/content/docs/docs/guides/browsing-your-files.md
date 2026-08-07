---
title: Browsing your context files
description: Walk from a source to the documents behind it, edit one in place, and follow it back to the concept it resolves to.
---

Every concept ContextCake serves came from a file somewhere. **Knowledge → Files**
is the navigator over those files: a tree per source, the document rendered
beside it, and a link in both directions between a file and the concept it
becomes.

The [Web Demo](/demo) has the same navigator, read-only, over the three-layer
demo bundle — the tree, the documents, and the file ⇄ concept links, with no
Save.

## From a source to its files

In **Sources**, select a source. Two rows in the panel are worth reading before
you open anything: **Files** is how many files that source holds, and
**Location** is the folder it reads. **Browse files** opens the navigator scoped
to it.

Two other ways in:

- **Knowledge → Files** (`⇧⌘F`) shows every source at once.
- The command palette (`⌘K`) carries one *Browse files in `<source>`* entry per
  source.

## The tree

Each source is a root row with its file count and its layer colour; folders sit
under it, closed, each with the number of files in its subtree. A vault of a few
thousand notes therefore opens as a short list of folders rather than a wall of
file names — expand only the part you care about. Only the rows on screen exist
in the page, so the tree costs the same at 30 files as at 3,000.

It is a keyboard tree:

| Key | Does |
|-----|------|
| `↑` `↓` | Move between visible rows |
| `→` | Open a folder, then step into it |
| `←` | Close a folder, or jump to its parent |
| `Home` `End` | First / last row |
| `Enter` | Open a file, or toggle a folder |

The top-bar search box filters by file name and path, and opens every folder
that still holds a match — a filtered tree is no use closed. If a source holds
more files than the scan limit allows, the navigator says so at the top of the
tree and tells you where to raise it (Settings → Indexing).

## Scoping to one source

Arriving from **Browse files** scopes the tree to that source: a chip names it,
with the file count and the folder underneath. Clear the chip to see every
source again. Scoping to a source that keeps nothing on this machine says which
kind of source it is instead of showing an empty folder — see
[Sources with no files to browse](#sources-with-no-files-to-browse).

## Deep links

The navigator is addressable, and the URL updates as you browse:

- `#/files` — the whole tree
- `#/files/team` — scoped to the `team` source
- `#/files/team/runbooks/deploy.md` — that file open, its folders revealed

The second segment is the path inside the source, so a name with a space or a
note six folders deep both survive the round trip. This is the link to paste
into a ticket when you want a colleague to look at the same document.

## Reading and editing

Markdown opens rendered. The **Raw** tab shows the file exactly as written —
frontmatter, `{#anchor}` heading attributes and all — and that tab is the
editor.

Edit, then **Save** (`⌘S`). ContextCake writes the file and re-resolves the
cascade, so Concepts, Cascade and Conflicts agree with what you just typed
rather than with what was there when the app started. Editing a section that
another layer disagrees with is one way to settle a conflict; the
[merge resolver](/docs/guides/playground-tour#resolving-conflicts) is the other.

Some limits are deliberate:

- Saving is refused if the file changed on disk after you opened it. Reopen it
  and merge — nothing is overwritten in the meantime.
- This view only ever overwrites files that already exist, and only inside a
  source's own folder. It creates nothing and deletes nothing.
- Images and PDFs preview instead of opening for edit. A text file above the
  indexer's size cap opens read-only, because it is a file the cascade does not
  read either.
- Files in a cloned repository are editable, but the edit lives only in your
  clone — and a dirty clone can make the next **Sync** fail.

## A file and the concept it becomes

An open document names the concept it resolves to, with that concept's conflict
count; click through to read the merged result in **Concepts**. Going the other
way, every contributor listed on a concept has an **Open file** button that
lands on the exact file in that layer.

The rule behind both links is simple: a concept id is the file's path inside its
source with the document extension removed, so `runbooks/deploy.md` in the
`team` source is the concept `runbooks/deploy` — the same derivation the engine
makes when it reads the layer.

Which extensions count depends on the kind of source: a
[ContextCake bundle](/docs/concepts/okf-bundles) reads `.md`, and a Markdown
folder reads `.md`, `.mdx`, and `.txt`. Everything else in the folder — an
image, a PDF, a `.txt` note sitting in an OKF bundle — is listed in the tree and
has no concept behind it. Those files get no link rather than one that opens on
an error.

## Reveal in Finder

In the Mac app, the file header has **Reveal in Finder**, and a source's panel
has one for the folder itself. The app resolves the location from the source
name and the path inside it and refuses anything that escapes that source's
folder, so a reveal can only ever land inside the folder you pointed it at. The
browser build has no Finder, so the button is absent there rather than present
and dead.

## Repointing a source's folder

Moved your notes? In **Sources**, open **Rename / level / folder**, edit
**Location**, and save. ContextCake re-reads the new folder and leaves your
other sources alone — you do not have to remove the source and add it back.

This is offered for folder-backed sources: a ContextCake bundle or a Markdown
folder. A cloned repository's folder is managed by **Sync**, and a GitHub-API or
MCP source has no folder to move; for those, remove the source and add it again.

## Sources with no files to browse

Two source kinds keep nothing on your machine and so never appear in the tree:

- **A GitHub repository read over the API** — indexed without a clone, so no
  file from it is stored locally.
- **An MCP source** — a remote graph ContextCake reads live and translates at
  read time. See [Foreign MCP sources](/docs/guides/foreign-mcp-sources).

That absence is a healthy state, not a failure, and the navigator says so when
you scope to one of them. Their content is in **Knowledge → Concepts** like
everything else. A repository you cloned is the exception: the clone is a real
folder on disk, so it does show up here.
