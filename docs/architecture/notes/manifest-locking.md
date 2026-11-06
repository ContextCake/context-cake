# Manifest lock ownership and recovery

Both `withManifestLock` and `withManifestLockAsync` acquire the same
`<manifest>.lock` directory. Each initializer creates a unique, empty owner
file whose name contains its PID, creation time, and random UUID. Before entering
the mutation, it verifies the directory identity and that its claim is the only
entry. The identity check alone is insufficient: an inode can be reused while
an initializer is paused.

Recovery removes only an exact claim whose PID is no longer alive,
then uses nonrecursive `rmdir`. It never parks, restores, or recursively deletes
the shared path. A late reaper cannot remove a replacement's populated directory.
It can remove a replacement that is still empty, but that initializer then
fails claim placement or its sole-owner check and retries. Empty directories
left by interrupted initialization expire after the stale window. Complete
dead-owner claims recover immediately, so a crashed engine can relaunch without
waiting for that window. Unknown
entries are preserved and keep the lock busy.

Release likewise removes only the caller's unique claim and tries nonrecursive
`rmdir`. A delayed release cannot remove the next owner's claim.

The desktop bootstrap waits asynchronously for this lease. A synchronous wait
on the Electron main process can prevent it from reaping its shutting-down
utility process or sending the delayed kill, keeping that child's PID apparently
alive throughout the lock timeout. The native teardown/relaunch regression
covers this boundary.

## Upgrading from file locks

Older binaries create a regular JSON lockfile at the same path. A live legacy
owner is honored. An expired legacy lock fails safely with an actionable error:
Node has no portable atomic operation that compares a file generation and
unlinks only that generation. Reading a token and subsequently unlinking can
delete an older binary's replacement owner.

For a stale legacy lock, close all ContextCake processes using that manifest,
verify that no mutation is still running, remove only the named legacy lockfile,
and retry. Do not remove an active lock. Upgrade all processes sharing a manifest
together; concurrent writers using the old and new protocols are unsupported.

## Editor writes

`control/files.mjs` takes the manifest lease, reads the complete manifest
strictly, and selects current roots. If a requested root overlaps the live
repository, it takes the repository lock before checking stale-editor timestamps,
reading content, or staging files. Overlapping aliases receive the same lock.

Whole-file and multi-layer section saves share the staged transaction journal
and startup recovery path with discrepancy decisions. A failed commit restores
all contributors and the touched index entries, preserving unrelated staging.
Commits name the actual relative filenames, including their extensions. A
byte-identical save does not create an empty commit. Push occurs after releasing
the manifest lease; offline commits remain local for source Sync to deliver.

Recovery is rechecked when the journal changes, including another process's
write or a failed rollback in the current process. A previously successful
recovery must not allow an old pending transaction to overwrite a later save.
