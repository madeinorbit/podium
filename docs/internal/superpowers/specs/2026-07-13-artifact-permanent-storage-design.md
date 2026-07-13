# Artifact permanent storage — design

**Issue:** #441 · **Date:** 2026-07-13 · **Status:** approved-pending-review

## Problem

`podium issue artifact --add <path>` stores only a path string in the issue
panel (`IssuePanelArtifact.path`). The bytes are read live from the worktree /
filesystem at render time via the `/files/asset` route → daemon `readAsset`
RPC. When the source lives in `/tmp` or an uncommitted worktree, cleanup or
worktree deletion silently loses the artifact.

## Decisions (human-approved)

1. **Bytes are uploaded to the central server** and stored in a
   server-managed directory — artifacts survive tmp/worktree cleanup and the
   originating machine being offline.
2. **Snapshot on add.** The stored copy is immutable; re-running
   `artifact --add` with the same source path replaces the stored bundle.
   No live-tracking, no file watching.
3. **Asset bundles supported.** An artifact may be a single file or a small
   file set (HTML + images/css). `--add <dir>` snapshots a directory;
   repeated `--add` flags in one invocation form one bundle.

## Approach (A: server-pull snapshot)

The `artifact-add` command already flows CLI → server → issue service. At
that point the server pulls the file bytes from the owning daemon over the
existing `readAsset` RPC channel (the same channel the live render path uses
today) and writes them into a server-managed store. No new upload protocol.

### Store layout

```
<state-dir>/artifacts/<issueId>/<artifactId>/<relpath...>
```

- `artifactId`: short random id minted by the server at add time.
- Single file → one file at its basename; the manifest marks it as `entry`.
- Bundle → files preserved under their relative paths; `entry` is the added
  HTML/MD file (or the first file).

### Panel schema (protocol)

`IssuePanelArtifact` gains optional fields, staying back-compatible:

```ts
{
  path: string            // source path as today (display + re-add matching)
  title?: string
  addedAt: string
  artifactId?: string     // present ⇒ served from the permanent store
  entry?: string          // relpath of the primary file inside the bundle
  files?: { path: string; size: number }[]  // bundle manifest
}
```

Entries without `artifactId` (pre-existing) keep rendering via the legacy
live `/files/asset` route, with the current "file gone" failure mode.

### Command flow (`artifact-add`)

1. CLI resolves the path(s) as today (relative to issue worktree or absolute)
   and sends the op. New op shape:
   `{ op: 'artifact-add'; path: string; title?: string; extraPaths?: string[] }`.
2. Server resolves the owning machine + root (issue worktree, falling back to
   the invoking session's machine/cwd), same resolution the live route uses.
3. For a directory: server asks the daemon for the file list (reuse the
   existing worktree file-browser listing RPC / FileScope sandbox); for
   files: the given list.
4. Server pulls each file via `readAsset`. Files above the single-shot cap
   are pulled with a chunked variant (offset/length parameters on
   `readAsset`, or a sibling `readAssetChunk` RPC).
5. Server writes bytes under the store path, fsyncs, then commits the panel
   update (artifactId + manifest) through the normal issue write seam.
   Failure to pull ⇒ the op errors; no half-registered artifact entry
   (partial files in a fresh artifactId dir are removed best-effort).
6. **Re-add**: an existing entry with the same source `path` on the same
   issue is replaced — new files written under a NEW artifactId, panel entry
   updated in place (same list position), old artifactId dir deleted after
   commit. New-id-then-swap keeps served URLs consistent with content.

### Serving

New route `GET /files/artifact/<issueId>/<artifactId>/<relpath>` (path-style,
same auth posture as the existing HTTP surface). Path-style so that relative
`src`/`href` references inside a bundle's HTML entry resolve naturally to
sibling files. Server-local read — no daemon round-trip, works with the
machine offline. Content-type by extension;
`cache-control: private, max-age=31536000, immutable` (content never changes
under a given artifactId — re-add mints a new id). Path traversal guarded by
resolving inside the artifact dir.

`packages/client-core` `artifactUrl()` picks the new route when
`artifactId` is present, legacy `/files/asset` route otherwise.

### Limits & GC

- Per-file cap 100 MB, per-bundle cap 500 MB, per-bundle file count 200.
  Exceeding ⇒ command error naming the offending file.
- `artifact-remove` deletes the entry AND its store directory.
- Issue archive keeps artifacts (that's the point). Operator `issue delete`
  deletes `<state-dir>/artifacts/<issueId>/`. Orphan sweep (dirs whose
  issue/entry no longer exists) piggybacks on existing GC cadence —
  best-effort, not load-bearing.

### Error handling

- Daemon offline / file unreadable at add time ⇒ op fails with a clear CLI
  message; nothing stored.
- Store dir unwritable / disk full ⇒ op fails before the panel commit.
- Serving a missing artifactId ⇒ 404 (entry shown with a "snapshot missing"
  state in the UI, same visual as today's dead-path case).

### Testing

- Unit: store write/replace/remove, path-traversal guard, cap enforcement.
- Integration: CLI `artifact --add` (file + dir) against a live server+daemon
  pair → bytes land in state dir → route serves them → source deleted →
  route still serves them.
- Web: artifact renders from the new route (existing dock-panel tests
  extended for `artifactId` URL selection).

## Out of scope

- Content-addressed dedup / hashing (can be layered under the same ids).
- Auto re-sync on source change (explicitly rejected).
- Migrating existing path-only entries (they keep legacy behavior).
