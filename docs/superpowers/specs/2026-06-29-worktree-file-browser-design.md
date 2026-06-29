# Worktree file browser — design

**Date:** 2026-06-29
**Status:** Approved (design); implementation pending

## Goal

Give each worktree in the sidebar an icon button that opens a **file browser**, so a
user can navigate that worktree's tree and open any file into the workspace deck — view
markdown rendered, edit source — without going through a session.

This is the first step of a broader "easily access specific files per project" effort.
v1 is the browser + open-into-deck; deeper integrations come later.

## Background: why files were coupled to sessions

Today the only way to open a file is to click a path the agent referenced **inside a
session's chat transcript**. The server never touches disk; it routes file reads to a
daemon by `machineId`. The session was the handle that bundled the three things a read
needs:

1. `machineId` — which daemon holds the file.
2. `cwd` — the sandbox root (`isInside(path, cwd)` is allowed).
3. the transcript — the `knownPath` allowlist for files *outside* cwd the agent touched.

The daemon's check (`apps/daemon/src/file-access.ts`) is:

```
isInside(realPath, realCwd) || knownPath
```

The coupling is historical, not fundamental. A file's true home is `{ machineId, path }`.
A **worktree** already carries both (`machineId` + `path`), so the file browser keys on
the worktree, not a session. Because the browser only navigates **within the worktree
root**, every file it opens is `isInside(root)` and passes the sandbox check with no
`knownPath` escape hatch — a tighter security story than the session path.

## Design overview

Three layers. The unifying change is that file access is scoped by `{ machineId, root,
path }` everywhere — the daemon enforces `isInside(path, root)`. Sessions become one
caller that derives `root = session.cwd` (preserving today's behaviour, including the
`knownPath` allowlist for transcript-referenced paths); the worktree browser derives
`root = worktree.path`.

### 1. Backend — daemon-scoped file access by `{ machineId, root, path }`

- **New daemon RPC: directory listing.** Add `dirListRequest` / `dirListResult` to the
  protocol, mirroring the existing `fileReadRequest`/`fileAssetRequest` plumbing
  (`daemonRequest` in `apps/server/src/relay.ts`, the daemon-side switch in
  `apps/daemon/src/daemon.ts`, and a `listDirSandboxed` in
  `apps/daemon/src/file-access.ts`). The daemon lists entries at `path` (defaults to
  `root`), enforcing `isInside(path, root)`, and returns
  `{ ok, path, entries: { name, isDir }[] }`. Hidden files included; sorted dirs-first
  then name. (`knownPath` is irrelevant here — listing is always within `root`.)

- **New tRPC procedure: `files.list({ machineId, root, path })`** in
  `apps/server/src/router.ts` → `registry.listDir(...)` → `daemonRequest(..., machineId)`.
  This replaces any use of `repos.browse` for the file browser (`repos.browse` is
  directories-only and reads the *server's* local fs, so it is wrong for remote daemons
  and shows no files). `repos.browse` stays as-is for the repo picker.

- **Generalize read/write scope.** `files.read` / `files.write` gain a worktree-scoped
  path that takes `{ machineId, root, path }` instead of `{ sessionId, path }`. The
  daemon read/write RPCs already carry `cwd` + `knownPath`; the server simply supplies
  `cwd = root` and `knownPath = false` for worktree-scoped calls. Session-scoped calls
  keep deriving `cwd = session.cwd` and `knownPath` from the transcript, unchanged.
  (Exact API shape — overload vs. discriminated input — decided in the plan; behaviour
  is identical for existing session callers.)

### 2. Frontend — `FileTab` keyed by worktree, not session

`FileTab` (in `apps/web/src/store.tsx`) changes from:

```ts
{ id, sessionId, path, worktreePath }
```
to:
```ts
{ id, machineId, root, path }   // root = worktree path = the strip-grouping key
```

- `id` becomes `file:${root}:${path}` (drop the sessionId segment).
- The strip already groups file tabs by `worktreePath`; `root` takes over that role
  verbatim (`Workspace.tsx` `fileTabs.filter(f => f.root === worktree.path)`).
- `openFile` gains a worktree-scoped form: `openFile({ machineId, root, path })`. The
  existing chat-view callers (open-from-transcript) are migrated to derive `machineId` +
  `root` from the session they already have — no UX change there.
- `useFileDocument` / `MarkdownFilePanel` take `{ machineId, root }` instead of
  `sessionId`; reads/writes call the worktree-scoped `files.read`/`files.write`. The
  rendered Preview/Source/Split behaviour and CodeMirror save are untouched.

### 3. Frontend — the browser UI

- **Icon button on `WorktreeBlock`** (`apps/web/src/Sidebar.tsx`, alongside `PinButton`):
  a lucide icon (`FolderTree` / `Files`), hover-revealed via the existing
  `group-hover/wt:inline-flex` pattern, `title="Browse files"`. onClick opens the modal
  for that worktree.
- **`FileBrowserModal`** (new component, adapted from `RepoPickerModal.tsx`): a dialog
  rooted at `worktree.path`. Breadcrumb / up / refresh navigation **clamped to the
  worktree root** (cannot navigate above `root`). Lists dirs **and** files via
  `files.list`; dirs navigate in, files call `openFile({ machineId, root, path })` then
  close the modal. Loading + error states reuse the modal's existing patterns.

## Data flow (open a file)

```
Sidebar WorktreeBlock [Browse files icon]
  → FileBrowserModal(worktree)
      → trpc.files.list({ machineId, root, path })  → daemon listDirSandboxed → entries
      → user clicks a file
  → openFile({ machineId, root, path })  → FileTab pushed, paneA = id
  → Workspace renders MarkdownFilePanel({ machineId, root, path })
      → useFileDocument → trpc.files.read({ machineId, root, path }) → daemon (isInside root)
      → edits → trpc.files.write({ machineId, root, path, content, baseHash })
```

## Security

- All daemon file ops enforce `isInside(realPath, realRoot)`. The browser never sends a
  path outside `root`, and navigation is clamped to `root`, so there is no out-of-tree
  read/write. The `knownPath` allowlist is **not** used on the worktree path — it exists
  only for the session path's transcript-referenced files and is preserved there.
- `root` is realpath-resolved daemon-side (existing behaviour) to defeat symlink escape.

## Testing

- **Daemon** (`file-access.test.ts` style): `listDirSandboxed` returns entries inside
  `root`; rejects/clamps paths outside `root`; symlink-escape rejected; hidden files
  included; dirs-first ordering.
- **Server**: `files.list` routes to the right `machineId`; read/write worktree-scoped
  path sets `cwd = root`, `knownPath = false`; session-scoped path behaviour unchanged.
- **Web**: `FileTab` keyed by `{ machineId, root, path }`; `openFile` worktree form adds
  a tab under the correct worktree strip and activates it; `MarkdownFilePanel` reads via
  the worktree scope. Migrated session callers still open transcript paths.
- **Runtime (per UI-verification practice):** in-browser check — click the icon on a
  worktree row, navigate, open a markdown file (preview) and a source file (edit + save),
  confirm it lands in the right worktree's deck strip.

## Out of scope (v1)

- Creating / renaming / deleting / moving files; multi-select; search-in-tree.
- Inline sidebar tree expansion (we chose a modal/overlay).
- Cross-worktree or above-root browsing.
- Persisting open file tabs server-side (they remain client-only, as today).

## Open implementation choices (resolved in the plan, not blocking)

- Exact API shape for the read/write scope generalization (overload vs. tagged union).
- Icon choice (`FolderTree` vs. `Files`) and whether the button also appears on the
  repo's main row.
- Whether `FileBrowserModal` shares a base with `RepoPickerModal` or is a sibling copy.
