# Worktree File Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hover-revealed icon button to each worktree row in the sidebar that opens a file-browser modal, letting the user navigate that worktree's tree and open any file into the workspace deck (markdown rendered, other files editable).

**Architecture:** File access is daemon-owned; the server reaches files by routing an RPC to a daemon by `machineId`, scoped to a containment root the daemon enforces (`isInside(path, root)`). Today that scope comes from a *session* (`cwd` + transcript `knownPath`). This plan adds a parallel **worktree scope** `{ machineId, root, path }` (root = worktree path, `knownPath` always false) so files can be browsed/opened without a session, while leaving the existing session path — including transcript-known out-of-tree opens — completely unchanged. A new daemon directory-listing RPC backs the browser; the existing file read/write RPCs are reused (they already carry `cwd` + `knownPath`).

**Tech Stack:** TypeScript monorepo (bun workspaces), zod protocol schemas (`@podium/protocol`), Hono + tRPC v11 server, node daemon, React 19 + Vite + shadcn/Base-UI + lucide-react web, Vitest.

## Global Constraints

- **Test runner:** Vitest. Run one file: `npx vitest run <path>`. Run a package's suite: `bun run --filter <pkg> test`. Typecheck: `bun run typecheck` (all) or `tsc --noEmit` in a package.
- **Do not modify the session-scoped file path's behaviour.** Session callers (`ChatView`, `AgentPanel`, `MarkdownPreview`) must keep opening files exactly as today, including transcript-known paths outside the worktree (`knownPath: true`). The worktree scope is additive.
- **Sandbox invariant:** every daemon file op resolves `realpath` on both root and target and requires `isInside(realTarget, realRoot)` unless `knownPath`. The worktree scope always passes `knownPath: false`.
- **Containment in the browser:** the modal never navigates above the worktree root.
- **Follow existing patterns:** lucide-react icons, `Button` from `@/components/ui/button`, `Dialog` from `@/components/ui/dialog`, the `daemonRequest` plumbing in `relay.ts`, the `pending*` result-map dispatch.
- **Commit after every task** (each task ends green: its tests pass + `bun run typecheck` clean).

---

## File Structure

**Backend**
- `packages/protocol/src/messages.ts` — add `DirEntry`, `DirListRequestMessage`, `DirListResultMessage`; add to `ControlMessage` / `DaemonMessage` unions; export types.
- `packages/protocol/src/file-messages.test.ts` — add parse tests for the new messages.
- `apps/daemon/src/file-access.ts` — add `listDirSandboxed({ root, path })`.
- `apps/daemon/src/file-access.test.ts` — add `listDirSandboxed` tests.
- `apps/daemon/src/daemon.ts` — add `case 'dirListRequest'` handler.
- `apps/server/src/relay.ts` — add `pendingDirLists` map + `dirListResult` dispatch + `listDir()`; branch `readFile()`/`writeFile()` to accept a worktree scope.
- `apps/server/src/router.ts` — add `files.list`; widen `files.read` / `files.write` inputs to a session-or-worktree union.
- `apps/server/src/relay.test.ts` — add a `listDir` routing test.

**Frontend**
- `apps/web/src/file-scope.ts` (new) — `FileScope` type + helpers (`scopeKey`, `tabIdFor`).
- `apps/web/src/store.tsx` — `FileTab` carries `scope`; add `openFileInWorktree`; scope-aware `readFileScoped`/`writeFileScoped`/`listDir`; keep `openFile(sessionId,path)`; fix `killSession`/`closeFileTab`.
- `apps/web/src/useFileDocument.ts` — take `FileScope` instead of `sessionId`.
- `apps/web/src/MarkdownFilePanel.tsx` — take `scope: FileScope` instead of `sessionId`.
- `apps/web/src/Workspace.tsx` — render `MarkdownFilePanel` with `scope` + scope-aware grouping key.
- `apps/web/src/FileBrowserModal.tsx` (new) — the browser dialog.
- `apps/web/src/Sidebar.tsx` — add the file-browser button + modal to `WorktreeBlock`.
- `apps/web/src/FileBrowserModal.test.tsx` (new) — render + navigate + open test.

---

## Task 1: Protocol — directory-listing messages

**Files:**
- Modify: `packages/protocol/src/messages.ts` (add schemas near `FileWriteRequestMessage` ~line 749 and the result block ~line 1060; add to unions at ~893 and ~1100)
- Test: `packages/protocol/src/file-messages.test.ts`

**Interfaces:**
- Produces:
  - `DirEntry = { name: string; isDir: boolean }`
  - `DirListRequestMessage = { type:'dirListRequest'; requestId:string; root:string; path:string }`
  - `DirListResultMessage = { type:'dirListResult'; requestId:string; ok:boolean; path:string; entries:DirEntry[]; error?:string }`

- [ ] **Step 1: Write the failing test** — append to `packages/protocol/src/file-messages.test.ts`:

```ts
import { DirListRequestMessage, DirListResultMessage } from './messages'

describe('dir list messages', () => {
  it('parses a dirListRequest in ControlMessage', () => {
    const msg = { type: 'dirListRequest', requestId: 'dl1', root: '/w', path: '/w/src' }
    expect(DirListRequestMessage.parse(msg).path).toBe('/w/src')
    expect(ControlMessage.parse(msg).type).toBe('dirListRequest')
  })

  it('parses a dirListResult carrying entries in DaemonMessage', () => {
    const msg = {
      type: 'dirListResult',
      requestId: 'dl1',
      ok: true,
      path: '/w/src',
      entries: [
        { name: 'lib', isDir: true },
        { name: 'index.ts', isDir: false },
      ],
    }
    expect(DirListResultMessage.parse(msg).entries).toHaveLength(2)
    expect(DaemonMessage.parse(msg).type).toBe('dirListResult')
  })
})
```

(Ensure `ControlMessage` and `DaemonMessage` are imported at the top of the test file — they already are for the existing cases; add `DirListRequestMessage, DirListResultMessage` to the import from `./messages`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/protocol/src/file-messages.test.ts`
Expected: FAIL — `DirListRequestMessage` is not exported / undefined.

- [ ] **Step 3: Add the schemas.** In `packages/protocol/src/messages.ts`, after `FileWriteRequestMessage`/its type export (~line 749):

```ts
export const DirListRequestMessage = z.object({
  type: z.literal('dirListRequest'),
  requestId: z.string(),
  /** Containment root — the daemon enforces the listed path stays inside it. */
  root: z.string(),
  /** Directory to list; equal to or nested under `root`. */
  path: z.string(),
})
export type DirListRequestMessage = z.infer<typeof DirListRequestMessage>
```

After `FileWriteResultMessage`/its type export (~line 1060):

```ts
export const DirEntry = z.object({ name: z.string(), isDir: z.boolean() })
export type DirEntry = z.infer<typeof DirEntry>

export const DirListResultMessage = z.object({
  type: z.literal('dirListResult'),
  requestId: z.string(),
  ok: z.boolean(),
  /** The resolved directory that was listed (realpath of the request path). */
  path: z.string(),
  entries: z.array(DirEntry).default([]),
  error: z.string().optional(),
})
export type DirListResultMessage = z.infer<typeof DirListResultMessage>
```

Add `DirListRequestMessage,` to the `ControlMessage` discriminated union array (after `FileWriteRequestMessage,` ~line 894) and `DirListResultMessage,` to the `DaemonMessage` union array (after `FileWriteResultMessage,` ~line 1100).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/protocol/src/file-messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run --filter @podium/protocol typecheck
git add packages/protocol/src/messages.ts packages/protocol/src/file-messages.test.ts
git commit -m "feat(protocol): dirList request/result messages for worktree file browser"
```

---

## Task 2: Daemon — `listDirSandboxed` + request handler

**Files:**
- Modify: `apps/daemon/src/file-access.ts`
- Test: `apps/daemon/src/file-access.test.ts`
- Modify: `apps/daemon/src/daemon.ts` (import ~line 77; switch ~after the `fileWriteRequest` case ~line 1444)

**Interfaces:**
- Consumes: `DirListResultMessage` (Task 1), existing `isInside`.
- Produces: `listDirSandboxed(opts:{ root:string; path?:string }): Promise<{ ok:boolean; path:string; entries:{name:string;isDir:boolean}[]; error?:string }>` — lists `path ?? root`, requires `isInside(realPath, realRoot)`, includes hidden files, sorts directories first then files, both alphabetical.

- [ ] **Step 1: Write the failing test** — append to `apps/daemon/src/file-access.test.ts` (add `listDirSandboxed` to the import from `./file-access`; the file already imports `mkdir`/`writeFile`/`mkdtemp`/`join` helpers used by sibling tests — reuse the same setup style):

```ts
import { listDirSandboxed } from './file-access'

describe('listDirSandboxed', () => {
  it('lists entries inside root, dirs first then files, alpha', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pod-ls-'))
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'b.ts'), 'b')
    await writeFile(join(dir, 'a.md'), 'a')
    const r = await listDirSandboxed({ root: dir })
    expect(r.ok).toBe(true)
    expect(r.entries).toEqual([
      { name: 'src', isDir: true },
      { name: 'a.md', isDir: false },
      { name: 'b.ts', isDir: false },
    ])
  })

  it('lists a nested subdir under root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pod-ls-'))
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'src', 'index.ts'), 'x')
    const r = await listDirSandboxed({ root: dir, path: join(dir, 'src') })
    expect(r.ok).toBe(true)
    expect(r.entries).toEqual([{ name: 'index.ts', isDir: false }])
  })

  it('rejects a path outside root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pod-ls-'))
    const outside = await mkdtemp(join(tmpdir(), 'pod-out-'))
    const r = await listDirSandboxed({ root: dir, path: outside })
    expect(r).toMatchObject({ ok: false, error: 'outside workspace' })
  })

  it('returns ok:false when the path is not a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pod-ls-'))
    const f = join(dir, 'a.ts')
    await writeFile(f, 'x')
    const r = await listDirSandboxed({ root: dir, path: f })
    expect(r.ok).toBe(false)
  })
})
```

(If `tmpdir`/`mkdtemp`/`mkdir` aren't already imported in the test file, add `import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'` and `import { tmpdir } from 'node:os'`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/daemon/src/file-access.test.ts`
Expected: FAIL — `listDirSandboxed` is not exported.

- [ ] **Step 3: Implement.** In `apps/daemon/src/file-access.ts`, extend the imports and add the function. Update the top import line to include `readdir`:

```ts
import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
```

Append at the end of the file:

```ts
export async function listDirSandboxed(opts: {
  root: string
  path?: string
}): Promise<{ ok: boolean; path: string; entries: { name: string; isDir: boolean }[]; error?: string }> {
  const target = opts.path ?? opts.root
  let realRoot: string
  let real: string
  try {
    realRoot = await realpath(opts.root)
    real = await realpath(target)
  } catch {
    return { ok: false, path: target, entries: [], error: 'not found' }
  }
  if (!isInside(real, realRoot)) return { ok: false, path: target, entries: [], error: 'outside workspace' }
  try {
    const st = await stat(real)
    if (!st.isDirectory()) return { ok: false, path: real, entries: [], error: 'not a directory' }
    const entries = (await readdir(real, { withFileTypes: true }))
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) =>
        a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
      )
    return { ok: true, path: real, entries }
  } catch {
    return { ok: false, path: real, entries: [], error: 'read error' }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/daemon/src/file-access.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the daemon handler.** In `apps/daemon/src/daemon.ts`, add `listDirSandboxed` to the import at ~line 77:

```ts
import { listDirSandboxed, readAssetSandboxed, readFileSandboxed, writeFileSandboxed } from './file-access'
```

After the `case 'fileWriteRequest': ... break` block (~line 1444), add:

```ts
      case 'dirListRequest':
        void listDirSandboxed({ root: msg.root, path: msg.path })
          .then((r) => send({ type: 'dirListResult', requestId: msg.requestId, ...r }))
          .catch((err) =>
            send({
              type: 'dirListResult',
              requestId: msg.requestId,
              ok: false,
              path: msg.path,
              entries: [],
              error: String(err),
            }),
          )
        break
```

- [ ] **Step 6: Typecheck + commit**

```bash
bun run --filter @podium/daemon typecheck
git add apps/daemon/src/file-access.ts apps/daemon/src/file-access.test.ts apps/daemon/src/daemon.ts
git commit -m "feat(daemon): listDirSandboxed + dirListRequest handler"
```

---

## Task 3: Server — `listDir`, worktree-scoped read/write, tRPC

**Files:**
- Modify: `apps/server/src/relay.ts` (pending maps ~line 304; result dispatch ~line 1955; `readFile`/`writeFile` ~line 2065/2117; add `listDir`)
- Modify: `apps/server/src/router.ts` (`files` router ~line 422)
- Test: `apps/server/src/relay.test.ts`

**Interfaces:**
- Consumes: `DirListRequestMessage`, `DirListResultMessage`, `DirEntry` (Task 1); existing `daemonRequest`, `pendingFileReads`, `FILE_RPC_TIMEOUT_MS`.
- Produces, on `SessionRegistry`:
  - `listDir(input:{ machineId?:string; root:string; path?:string }): Promise<{ ok:boolean; path:string; entries:DirEntry[]; error?:string }>`
  - `readFile(input: { sessionId:string; path:string } | { machineId?:string; root:string; path:string })` — same return type as today.
  - `writeFile(input: { sessionId:string; path:string; content:string; baseHash?:string } | { machineId?:string; root:string; path:string; content:string; baseHash?:string })` — same return type as today.
- tRPC: `files.list`, plus widened `files.read` / `files.write`.

- [ ] **Step 1: Write the failing test.** In `apps/server/src/relay.test.ts`, follow the existing harness used by other `daemonRequest` tests (find a test that drives a file read or transcript read to copy its setup — a registry with a connected fake daemon socket that echoes a result). Add:

```ts
it('routes listDir to the worktree machine and resolves entries', async () => {
  // Arrange a registry with one connected daemon (reuse the existing test harness
  // helper that the fileRead test uses). Capture the control message the daemon receives.
  const { registry, daemon } = makeRegistryWithDaemon() // existing helper in this file
  daemon.onControl((msg) => {
    if (msg.type === 'dirListRequest') {
      daemon.send({
        type: 'dirListResult',
        requestId: msg.requestId,
        ok: true,
        path: msg.path,
        entries: [{ name: 'src', isDir: true }],
      })
    }
  })
  const r = await registry.listDir({ machineId: daemon.machineId, root: '/w', path: '/w' })
  expect(r.ok).toBe(true)
  expect(r.entries).toEqual([{ name: 'src', isDir: true }])
})
```

> If the file's existing harness differs (helper names), mirror the closest existing `daemonRequest` round-trip test verbatim — the only new behaviour is the `dirListRequest`→`dirListResult` pair and that `listDir` targets `input.machineId`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/server/src/relay.test.ts`
Expected: FAIL — `registry.listDir` is not a function.

- [ ] **Step 3: Add the pending map + dispatch.** In `apps/server/src/relay.ts`, after the `pendingFileWrites` declaration (~line 312), add:

```ts
  private readonly pendingDirLists = new Map<
    string,
    (r: Omit<DirListResultMessage, 'type' | 'requestId'>) => void
  >()
```

Add the import for `DirListResultMessage` (and `DirEntry`) to the existing `@podium/protocol` import block. In the result-dispatch switch, after the `case 'fileAssetResult':` block (~line 1994), add:

```ts
      case 'dirListResult': {
        const resolve = this.pendingDirLists.get(msg.requestId)
        if (resolve) {
          this.pendingDirLists.delete(msg.requestId)
          const { type: _t, requestId: _r, ...payload } = msg
          resolve(payload)
        }
        break
      }
```

- [ ] **Step 4: Add `listDir` and the scoped read/write branches.** Replace the existing `readFile({ sessionId, path })` method (~line 2065) with a scope-aware version and add `listDir`:

```ts
  listDir(input: {
    machineId?: string
    root: string
    path?: string
  }): Promise<Omit<DirListResultMessage, 'type' | 'requestId'>> {
    const path = input.path ?? input.root
    return this.daemonRequest(
      this.pendingDirLists,
      'dl',
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, path, entries: [], error: 'timeout' }),
      (requestId) => ({ type: 'dirListRequest', requestId, root: input.root, path }),
      input.machineId ?? this.defaultMachineId(),
    )
  }

  readFile(
    input: { sessionId: string; path: string } | { machineId?: string; root: string; path: string },
  ): Promise<Omit<FileReadResultMessage, 'type' | 'requestId'>> {
    if ('sessionId' in input) {
      const session = this.sessions.get(input.sessionId)
      if (!session) return Promise.resolve({ ok: false, path: input.path, error: 'no session' })
      const knownPath = knownPathsFor(session.transcriptItems()).has(input.path)
      return this.daemonRequest(
        this.pendingFileReads,
        'fr',
        FILE_RPC_TIMEOUT_MS,
        () => ({ ok: false, path: input.path, error: 'timeout' }),
        (requestId) => ({ type: 'fileReadRequest', requestId, cwd: session.cwd, path: input.path, knownPath }),
        session.machineId,
      )
    }
    return this.daemonRequest(
      this.pendingFileReads,
      'fr',
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, path: input.path, error: 'timeout' }),
      (requestId) => ({ type: 'fileReadRequest', requestId, cwd: input.root, path: input.path, knownPath: false }),
      input.machineId ?? this.defaultMachineId(),
    )
  }
```

Apply the same session-or-worktree branch to `writeFile` (~line 2117), keeping the session arm identical to today and adding a worktree arm that sends `cwd: input.root`:

```ts
  writeFile(
    input:
      | { sessionId: string; path: string; content: string; baseHash?: string }
      | { machineId?: string; root: string; path: string; content: string; baseHash?: string },
  ): Promise<Omit<FileWriteResultMessage, 'type' | 'requestId'>> {
    const build = (requestId: string, cwd: string) => ({
      type: 'fileWriteRequest' as const,
      requestId,
      cwd,
      path: input.path,
      content: input.content,
      ...(input.baseHash ? { baseHash: input.baseHash } : {}),
    })
    if ('sessionId' in input) {
      const session = this.sessions.get(input.sessionId)
      if (!session) return Promise.resolve({ ok: false, error: 'no session' })
      return this.daemonRequest(
        this.pendingFileWrites,
        'fw',
        FILE_RPC_TIMEOUT_MS,
        () => ({ ok: false, error: 'timeout' }),
        (requestId) => build(requestId, session.cwd),
        session.machineId,
      )
    }
    return this.daemonRequest(
      this.pendingFileWrites,
      'fw',
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, error: 'timeout' }),
      (requestId) => build(requestId, input.root),
      input.machineId ?? this.defaultMachineId(),
    )
  }
```

(`knownPathsFor` is already imported in `relay.ts`; keep that import.)

- [ ] **Step 5: Widen the tRPC inputs + add `files.list`.** In `apps/server/src/router.ts`, replace the `files` router (~line 422) with:

```ts
  files: t.router({
    read: t.procedure
      .input(
        z.union([
          z.object({ sessionId: z.string(), path: z.string() }),
          z.object({ machineId: z.string().optional(), root: z.string(), path: z.string() }),
        ]),
      )
      .query(({ ctx, input }) => ctx.registry.readFile(input)),
    write: t.procedure
      .input(
        z.union([
          z.object({ sessionId: z.string(), path: z.string(), content: z.string(), baseHash: z.string().optional() }),
          z.object({
            machineId: z.string().optional(),
            root: z.string(),
            path: z.string(),
            content: z.string(),
            baseHash: z.string().optional(),
          }),
        ]),
      )
      .mutation(({ ctx, input }) => ctx.registry.writeFile(input)),
    list: t.procedure
      .input(z.object({ machineId: z.string().optional(), root: z.string(), path: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.listDir(input)),
  }),
```

> Preserve any other fields the current `write` input declares (e.g. exactly the `content`/`baseHash` shape already present); copy them into both union arms.

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run apps/server/src/relay.test.ts`
Expected: PASS.
Run: `bun run --filter @podium/server typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/relay.ts apps/server/src/router.ts apps/server/src/relay.test.ts
git commit -m "feat(server): files.list + worktree-scoped read/write routing"
```

---

## Task 4: Web store — `FileScope`, worktree open, scoped helpers

**Files:**
- Create: `apps/web/src/file-scope.ts`
- Modify: `apps/web/src/store.tsx` (`FileTab` ~line 153; `openFile` ~line 292; `closeFileTab` ~line 303; `readFile`/`writeFile` ~line 311; `killSession` ~line 338; `StoreValue` members ~line 88; context export ~line 711)
- Test: covered via Task 7's modal test + typecheck (store changes are structural).

**Interfaces:**
- Produces (in `file-scope.ts`):

```ts
export type FileScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'worktree'; machineId?: string; root: string }

/** Stable key for a scope — used in tab ids and mode-persistence keys. */
export function scopeKey(scope: FileScope): string {
  return scope.kind === 'session' ? `s:${scope.sessionId}` : `w:${scope.root}`
}

/** A file tab's id: unique per (scope, path). */
export function tabIdFor(scope: FileScope, path: string): string {
  return `file:${scopeKey(scope)}:${path}`
}
```

- Produces (on the store): `FileTab = { id:string; scope:FileScope; path:string; worktreePath:string }`; `openFile(sessionId:string, path:string)` (unchanged signature, builds a session scope); `openFileInWorktree(args:{ machineId?:string; root:string; path:string })`; `readFileScoped(scope:FileScope, path:string)`; `writeFileScoped(args:{ scope:FileScope; path:string; content:string; baseHash?:string })`; `listDir(args:{ machineId?:string; root:string; path?:string })`.

- [ ] **Step 1: Create `apps/web/src/file-scope.ts`** with the exact content from the Interfaces block above.

- [ ] **Step 2: Update `FileTab`** in `store.tsx` (~line 153). Add the import at the top: `import { type FileScope, scopeKey, tabIdFor } from './file-scope'`. Replace the interface:

```ts
/** An open file-editor tab. `id` is `file:<scopeKey>:<path>`; `worktreePath` (the
 *  containment root) scopes it to a worktree's tab strip. `scope` carries how the
 *  daemon read/write is addressed (a session today, or a worktree directly). */
export interface FileTab {
  id: string
  scope: FileScope
  path: string
  worktreePath: string
}
```

- [ ] **Step 3: Update `openFile` + add `openFileInWorktree`** (~line 292):

```ts
  const openFile = useMemo(
    () => (sessionId: string, path: string) => {
      const scope: FileScope = { kind: 'session', sessionId }
      const id = tabIdFor(scope, path)
      const worktreePath = sessions.find((s) => s.sessionId === sessionId)?.cwd ?? ''
      setFileTabs((tabs) =>
        tabs.some((t) => t.id === id) ? tabs : [...tabs, { id, scope, path, worktreePath }],
      )
      setPaneA(id)
    },
    [sessions],
  )
  const openFileInWorktree = useMemo(
    () => (args: { machineId?: string; root: string; path: string }) => {
      const scope: FileScope = { kind: 'worktree', machineId: args.machineId, root: args.root }
      const id = tabIdFor(scope, args.path)
      setFileTabs((tabs) =>
        tabs.some((t) => t.id === id)
          ? tabs
          : [...tabs, { id, scope, path: args.path, worktreePath: args.root }],
      )
      setPaneA(id)
    },
    [],
  )
```

- [ ] **Step 4: Replace `readFile`/`writeFile` with scoped helpers + keep session conveniences** (~line 311). The existing session-scoped `readFile(sessionId,path)` / `writeFile({sessionId,...})` are consumed by `useFileDocument` — those move to scope form in Task 5, so define:

```ts
  const readFileScoped = useMemo(
    () => (scope: FileScope, path: string) =>
      scope.kind === 'session'
        ? trpc.files.read.query({ sessionId: scope.sessionId, path })
        : trpc.files.read.query({ machineId: scope.machineId, root: scope.root, path }),
    [trpc],
  )
  const writeFileScoped = useMemo(
    () =>
      (args: { scope: FileScope; path: string; content: string; baseHash?: string }) =>
        args.scope.kind === 'session'
          ? trpc.files.write.mutate({ sessionId: args.scope.sessionId, path: args.path, content: args.content, baseHash: args.baseHash })
          : trpc.files.write.mutate({ machineId: args.scope.machineId, root: args.scope.root, path: args.path, content: args.content, baseHash: args.baseHash }),
    [trpc],
  )
  const listDir = useMemo(
    () => (args: { machineId?: string; root: string; path?: string }) =>
      trpc.files.list.query(args),
    [trpc],
  )
```

Remove the old `readFile`/`writeFile` `useMemo`s (the ones at ~311–320).

- [ ] **Step 5: Fix `closeFileTab` and `killSession`** (~303 / ~338). `closeFileTab` is unchanged (keys on `id`). In `killSession`, a file tab no longer always has a `sessionId`; replace the filter:

```ts
      setFileTabs((tabs) =>
        tabs.filter((t) => !(t.scope.kind === 'session' && t.scope.sessionId === sessionId)),
      )
```

- [ ] **Step 6: Update the `StoreValue` interface + context export.** In the interface (~88) replace the `openFile`/`readFile`/`writeFile` members:

```ts
  fileTabs: FileTab[]
  openFile: (sessionId: string, path: string) => void
  openFileInWorktree: (args: { machineId?: string; root: string; path: string }) => void
  closeFileTab: (id: string) => void
  readFileScoped: (
    scope: FileScope,
    path: string,
  ) => Promise<Awaited<ReturnType<Trpc['files']['read']['query']>>>
  writeFileScoped: (args: {
    scope: FileScope
    path: string
    content: string
    baseHash?: string
  }) => Promise<Awaited<ReturnType<Trpc['files']['write']['mutate']>>>
  listDir: (args: {
    machineId?: string
    root: string
    path?: string
  }) => Promise<Awaited<ReturnType<Trpc['files']['list']['query']>>>
```

(Add `import type { FileScope }` to the existing `./file-scope` import.) In the returned context object (~711) replace `openFile, readFile, writeFile` with: `openFile, openFileInWorktree, readFileScoped, writeFileScoped, listDir,` (keep `fileTabs, closeFileTab`).

- [ ] **Step 7: Typecheck** (expect errors only in the files Tasks 5/7 touch — `useFileDocument.ts`, `MarkdownFilePanel.tsx`, `Workspace.tsx` — which still use the old members; those are fixed next).

Run: `bun run --filter @podium/web typecheck`
Expected: errors confined to `useFileDocument.ts`, `MarkdownFilePanel.tsx`, `Workspace.tsx`. No errors in `store.tsx` / `file-scope.ts`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/file-scope.ts apps/web/src/store.tsx
git commit -m "feat(web): FileScope + openFileInWorktree + scoped file helpers"
```

---

## Task 5: Web — `useFileDocument` + `MarkdownFilePanel` take a `FileScope`

**Files:**
- Modify: `apps/web/src/useFileDocument.ts`
- Modify: `apps/web/src/MarkdownFilePanel.tsx`
- Modify: `apps/web/src/Workspace.tsx` (render + grouping key)

**Interfaces:**
- Consumes: `readFileScoped`/`writeFileScoped` (Task 4), `FileScope`, `scopeKey`.
- Produces: `useFileDocument(scope:FileScope, path:string): FileDocument` (return type unchanged); `MarkdownFilePanel({ scope:FileScope; path:string; onClose }):`.

- [ ] **Step 1: Update `useFileDocument.ts`.** Change the signature and the two store calls. Replace `export function useFileDocument(sessionId: string, path: string)` with `export function useFileDocument(scope: FileScope, path: string)`; add `import type { FileScope } from './file-scope'`. Change `const { readFile, writeFile } = useStore()` to `const { readFileScoped, writeFileScoped } = useStore()`. In `save`, replace both `writeFile({ sessionId, path, ... })` calls with `writeFileScoped({ scope, path, content: body, baseHash })` and `writeFileScoped({ scope, path, content: contentRef.current })`. In the load effect, replace `await readFile(sessionId, path)` with `await readFileScoped(scope, path)`. Update the `useCallback`/`useEffect` dependency arrays: replace `sessionId` with `scope` and `readFile`/`writeFile` with `readFileScoped`/`writeFileScoped`.

> `scope` is an object literal recreated each render by callers, which would re-fire the load effect. To keep the effect stable, depend on a primitive key. Add near the top of the hook: `const key = scopeKey(scope)` (import `scopeKey` from `./file-scope`), and use `key` in the load effect's dependency array instead of `scope` (keep `scope` referenced inside via a ref):

```ts
import { scopeKey, type FileScope } from './file-scope'
// ...
const scopeRef = useRef(scope)
scopeRef.current = scope
const key = scopeKey(scope)
// load effect deps: [key, path, readFileScoped, reloadNonce]; inside use scopeRef.current
// save deps: replace sessionId with key; inside save use scopeRef.current
```

- [ ] **Step 2: Update `MarkdownFilePanel.tsx`.** Change the prop type from `sessionId: string` to `scope: FileScope` (add `import type { FileScope } from './file-scope'`). Replace `const doc = useFileDocument(sessionId, path)` with `const doc = useFileDocument(scope, path)`. Replace the `tabId` line `const tabId = \`file:${sessionId}:${path}\`` with `const tabId = \`file:${scopeKey(scope)}:${path}\`` (import `scopeKey`).

- [ ] **Step 3: Update `Workspace.tsx`.** The file-strip grouping uses `f.worktreePath` — unchanged (still correct). Update only the render call (~line 269):

```tsx
                  <MarkdownFilePanel
                    scope={t.file.scope}
                    path={t.file.path}
                    onClose={() => closeFileTab(t.id)}
                  />
```

- [ ] **Step 4: Typecheck**

Run: `bun run --filter @podium/web typecheck`
Expected: clean (Task 7 adds the modal; nothing else should error now).

- [ ] **Step 5: Run the web suite to confirm no regressions** in existing file/chat tests:

Run: `bun run --filter @podium/web test`
Expected: PASS (existing `ChatView`/`agent-panel-*`/file tests still pass — the session path is behaviourally unchanged).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/useFileDocument.ts apps/web/src/MarkdownFilePanel.tsx apps/web/src/Workspace.tsx
git commit -m "refactor(web): file document + panel keyed by FileScope"
```

---

## Task 6: Web — `FileBrowserModal`

**Files:**
- Create: `apps/web/src/FileBrowserModal.tsx`
- Test: `apps/web/src/FileBrowserModal.test.tsx`

**Interfaces:**
- Consumes: `listDir` + `openFileInWorktree` from the store; `Dialog`/`Button`/lucide icons.
- Produces: `FileBrowserModal({ root, machineId, title, onClose }: { root:string; machineId?:string; title:string; onClose:()=>void }): JSX.Element`. Lists dirs+files at the current path (starts at `root`), navigates into dirs, clamps "Up" at `root`, and on a file click calls `openFileInWorktree({ machineId, root, path })` then `onClose()`.

- [ ] **Step 1: Write the failing test** — `apps/web/src/FileBrowserModal.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { FileBrowserModal } from './FileBrowserModal'

const listDir = vi.fn()
const openFileInWorktree = vi.fn()
vi.mock('./store', () => ({ useStore: () => ({ listDir, openFileInWorktree }) }))
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }))

describe('FileBrowserModal', () => {
  it('lists entries, navigates into a dir, opens a file', async () => {
    listDir.mockImplementation(async ({ path }: { path?: string }) =>
      path && path.endsWith('/src')
        ? { ok: true, path, entries: [{ name: 'index.ts', isDir: false }] }
        : { ok: true, path: '/w', entries: [{ name: 'src', isDir: true }, { name: 'a.md', isDir: false }] },
    )
    const onClose = vi.fn()
    render(<FileBrowserModal root="/w" title="files" onClose={onClose} />)

    await screen.findByText('src')
    fireEvent.click(screen.getByText('src'))
    await screen.findByText('index.ts')
    fireEvent.click(screen.getByText('index.ts'))

    await waitFor(() =>
      expect(openFileInWorktree).toHaveBeenCalledWith({ machineId: undefined, root: '/w', path: '/w/src/index.ts' }),
    )
    expect(onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/web/src/FileBrowserModal.test.tsx`
Expected: FAIL — module `./FileBrowserModal` not found.

- [ ] **Step 3: Implement `FileBrowserModal.tsx`** (adapted from `RepoPickerModal`, clamped to `root`, lists files too):

```tsx
import { ChevronUp, File as FileIcon, Folder, RefreshCw } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { formatAppError } from './AppErrorPage'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useStore } from './store'

type Entry = { name: string; isDir: boolean }

/** Join a directory and a child name into an absolute path (paths are POSIX here). */
function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

export function FileBrowserModal({
  root,
  machineId,
  title,
  onClose,
}: {
  root: string
  machineId?: string
  title: string
  onClose: () => void
}): JSX.Element {
  const { listDir, openFileInWorktree } = useStore()
  const isMobile = useIsMobile()
  const [path, setPath] = useState(root)
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (next: string) => {
      setLoading(true)
      setError(null)
      try {
        const r = await listDir({ machineId, root, path: next })
        if (!r.ok) {
          setError(r.error ?? 'Could not open directory')
          return
        }
        setPath(r.path)
        setEntries(r.entries)
      } catch (e) {
        setError(formatAppError(e, 'Could not open directory'))
      } finally {
        setLoading(false)
      }
    },
    [listDir, machineId, root],
  )

  useEffect(() => {
    void load(root)
  }, [load, root])

  const atRoot = path === root
  const parent = path.slice(0, path.lastIndexOf('/')) || '/'

  return (
    <Dialog
      open
      modal={isMobile ? 'trap-focus' : true}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="flex max-h-[min(720px,calc(100dvh-2rem))] w-full max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="gap-0 border-b border-border px-3.5 pt-3.5 pb-2.5 pr-10">
          <DialogTitle className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            {title}
          </DialogTitle>
          <div className="mt-1 break-words text-[13px] font-medium text-foreground">{path}</div>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2.5">
          <Button
            variant="ghost"
            size="icon"
            disabled={atRoot || loading}
            onClick={() => void load(parent)}
            aria-label="Up"
            title="Up"
          >
            <ChevronUp size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={loading}
            onClick={() => void load(path)}
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </Button>
        </div>
        {error && (
          <div className="border-b border-border px-3.5 py-2 text-xs text-destructive">{error}</div>
        )}
        <div className="min-h-[180px] flex-1 overflow-y-auto p-1.5" aria-busy={loading}>
          {loading && <div className="p-3 text-xs text-muted-foreground/70">Loading…</div>}
          {!loading && entries.length === 0 && (
            <div className="p-3 text-xs text-muted-foreground/70">Empty.</div>
          )}
          {!loading &&
            entries.map((entry) => {
              const abs = joinPath(path, entry.name)
              return (
                <Button
                  variant="ghost"
                  size="default"
                  className="h-auto w-full justify-start gap-2.5 px-2 py-2 text-left font-normal text-foreground"
                  key={abs}
                  disabled={loading}
                  onClick={() => {
                    if (entry.isDir) {
                      void load(abs)
                    } else {
                      openFileInWorktree({ machineId, root, path: abs })
                      onClose()
                    }
                  }}
                >
                  {entry.isDir ? <Folder size={16} /> : <FileIcon size={16} />}
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                    {entry.name}
                  </span>
                </Button>
              )
            })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/web/src/FileBrowserModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run --filter @podium/web typecheck
git add apps/web/src/FileBrowserModal.tsx apps/web/src/FileBrowserModal.test.tsx
git commit -m "feat(web): FileBrowserModal for browsing a worktree tree"
```

---

## Task 7: Web — file-browser button on the worktree row

**Files:**
- Modify: `apps/web/src/Sidebar.tsx` (`WorktreeBlock` ~line 687; lucide import ~line 3; render the button next to `PinButton` ~line 744)

**Interfaces:**
- Consumes: `FileBrowserModal` (Task 6); `WorktreeNavView` already carries `path` + `machineId`.

- [ ] **Step 1: Add the icon + modal to `WorktreeBlock`.** At the top of `Sidebar.tsx`, add `FolderTree` to the lucide-react import. Add `import { FileBrowserModal } from './FileBrowserModal'` and ensure `useState` is imported from `react`. Inside `WorktreeBlock`, add state:

```tsx
  const [browsing, setBrowsing] = useState(false)
```

Immediately after the existing `<PinButton ... />` inside the `group/wt` row (~line 751), add the browse button:

```tsx
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            'w-7 min-w-7 flex-none rounded-none',
            'hidden text-muted-foreground/70 hover:text-foreground group-hover/wt:inline-flex',
          )}
          title="Browse files"
          aria-label="Browse files"
          onClick={(e) => {
            e.stopPropagation()
            setBrowsing(true)
          }}
        >
          <FolderTree size={13} aria-hidden="true" />
        </Button>
```

Then, just before the closing `</div>` of the outer `min-w-0` wrapper (after `<StaleSection .../>`), render the modal:

```tsx
      {browsing && (
        <FileBrowserModal
          root={worktree.path}
          machineId={worktree.machineId}
          title={`Files — ${worktree.branch ?? worktree.path.split('/').pop()}`}
          onClose={() => setBrowsing(false)}
        />
      )}
```

(Confirm `Button` and `cn` are already imported in `Sidebar.tsx` — they are, used by `PinButton`/`PanelRow`.)

- [ ] **Step 2: Typecheck**

Run: `bun run --filter @podium/web typecheck`
Expected: clean.

- [ ] **Step 3: Build the web app** (catches any lazy-import / bundling issue):

Run: `bun run --filter @podium/web build`
Expected: success.

- [ ] **Step 4: Full suite green**

Run: `bun run test`
Expected: PASS across packages.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/Sidebar.tsx
git commit -m "feat(web): worktree file-browser button in the sidebar"
```

- [ ] **Step 6: Runtime verification (per project practice — UI work needs a real click).** With the dev host running, in the browser: hover a worktree row → the folder-tree icon appears → click it → the modal lists files+dirs rooted at the worktree → navigate into a subdir and back (Up disabled at root) → click a `.md` file (opens in the deck as a rendered preview under that worktree's strip) → click a source file (opens editable; edit + Cmd+S saves). Confirm the opened file tab sits in the correct worktree's deck and survives a tab switch.

---

## Self-Review

**Spec coverage:**
- Backend daemon-routed listing → Task 1 (protocol) + Task 2 (daemon) + Task 3 (`files.list`). ✓
- Generalized `{machineId, root, path}` read/write with sessions unchanged + `knownPath` preserved → Task 3 (branch keeps session arm verbatim, worktree arm sends `knownPath:false`). ✓
- `FileTab` rekeyed off session → Task 4 (`scope`). ✓ `openFile` session signature preserved (chat callers untouched) → Task 4. ✓
- `useFileDocument`/`MarkdownFilePanel` on `FileScope` → Task 5. ✓
- `FileBrowserModal` clamped to root, lists files+dirs, opens via worktree scope → Task 6. ✓
- Icon button hover-revealed on `WorktreeBlock` → Task 7. ✓
- Security (isInside on root, no knownPath escape, realpath) → Task 2 + Task 3. ✓
- Out of scope (create/rename/delete, search, tree-expand, above-root, server-side tab persistence) → not implemented. ✓
- Testing across daemon/server/web + runtime check → Tasks 2/3/6 unit + Task 7 step 6. ✓

**Placeholder scan:** No TBD/TODO. Two guarded references to existing test harnesses (Task 3 `makeRegistryWithDaemon`, Task 2 tmp helpers) are explicitly flagged to mirror the file's existing sibling tests rather than invent APIs — acceptable because the exact helper name is local to those files and the behaviour to assert is fully specified.

**Type consistency:** `FileScope`, `scopeKey`, `tabIdFor` defined in Task 4 and consumed identically in Tasks 5–6. `readFileScoped`/`writeFileScoped`/`listDir`/`openFileInWorktree` names match between store (Task 4), hook (Task 5), and modal (Task 6). `listDir` return shape `{ ok, path, entries, error? }` consistent from daemon (Task 2) → server (Task 3) → store/modal (Tasks 4/6). `DirEntry { name, isDir }` consistent throughout.
