# npm name reservation

npm can only attach a trusted publisher to a package that already exists, so
`contextcake` and `context-cake` were first published by hand as empty `0.0.0`
placeholders built from the sources in this directory:

```sh
npm publish packages/npm/reserve/contextcake --access public --ignore-scripts
npm publish packages/npm/reserve/context-cake --access public --ignore-scripts
```

These directories are the record of exactly what went to the registry before the
automated channel existed. They are not built, installed, or published again.
The shipping packages are `packages/npm/contextcake` (the CLI) and
`packages/npm/context-cake` (the pointer), both published only by
`.github/workflows/npm-publish.yml` from the tarball the signed GitHub Release
already carries.

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

The full channel procedure, including who approves a publish, is in
[`docs/go-live.md`](../../../docs/go-live.md).
