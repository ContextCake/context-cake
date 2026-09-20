# npm name reservation

npm can only attach a trusted publisher to a package that already exists, so
`contextcake` was first published by hand as an empty `0.0.0` placeholder built
from the source in this directory:

```sh
npm publish packages/npm/reserve/contextcake --access public --ignore-scripts
```

This directory is the record of exactly what went to the registry before the
automated channel existed. It is not built, installed, or published again. The
shipping package is `packages/npm/contextcake`, published only by
`.github/workflows/npm-publish.yml` from the tarball the signed GitHub Release
already carries.

The hyphenated `context-cake` was attempted on 2026-09-20 and refused:

```
403 Package name too similar to existing package contextcake
```

That is the outcome worth having. npm's similarity rule blocks the lookalike for
everyone, which is stronger than owning the name, and it needs no maintenance.
There is deliberately no pointer package.

Deprecate each placeholder in the same session it is published, not later.
Until a real version ships, `0.0.0` is what `npm install contextcake` resolves,
and the deprecation warning is the only thing that says so:

```sh
npm deprecate contextcake@0.0.0 "Name reservation. Install a released version."
```

The placeholders declare no `bin` and no `main`, so an accidental install leaves
a user with nothing rather than a broken `contextcake` command.

Deprecating is the right tool here, not unpublishing: npm allows unpublish only
within 72 hours, and removing a version that something already resolved breaks
that install. A deprecated version stays resolvable and warns on install.

The full channel procedure, including both approval gates, is in
[`docs/go-live.md`](../../../docs/go-live.md).
