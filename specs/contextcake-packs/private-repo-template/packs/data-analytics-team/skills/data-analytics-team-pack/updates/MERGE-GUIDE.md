# Merge Guide

This pack updates roughly monthly. Because you should not edit installed pack files
directly (see `local-overlay/README.md`), updating means replacing the installed files
wholesale and re-applying anything your team keeps in its own overlay — not hand-editing
a diff.

For every update:

1. **Read `updates/CHANGELOG.md`.** Find the new version's entry and note which files or
   modules changed. Skip straight to step 4 if nothing in the entry affects a file you've
   overlaid or customized.
2. **Re-install or re-download the new version** of the pack (see the relevant guide in
   `tool-guides/` for your setup) rather than patching the old files in place.
3. **Diff the new pack files against your local overlay**, not against the old installed
   files. Your overlay is the thing you actually care about preserving; the old installed
   files are disposable. If you keep notes on which fields or sections you've overridden
   (a source-of-truth exception, an extra clarified-spec field, house terminology), check
   each one against the new version.
4. **Copy in the changes your team wants.** Most updates are additive (new glossary
   terms, a new example, a new tool guide) and need no action beyond re-installing. Only
   act on changes that touch a file or field you rely on.
5. **Keep local exceptions outside the installed pack files.** If a new version changed
   something your overlay depends on, update the overlay to match — do not fork the
   installed file. Forking defeats the next update.
6. **Re-run your first task.** After updating, re-run the tool guide's first-task check
   (see `tool-guides/`) to confirm your assistant is still picking up the pack correctly.

If a version bump is major (a new major version number in `updates/CHANGELOG.md`),
expect field names or file paths to have changed — read the changelog entry in full
before re-installing, since a straight overlay diff may not be enough.
