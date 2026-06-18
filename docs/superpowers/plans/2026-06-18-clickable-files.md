# Clickable Files → Inline Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make highlighted file references in Podium's chat view and native terminal clickable, opening an editable CodeMirror panel that reads and writes the file through a sandboxed daemon RPC.

**Architecture:** A new server→daemon `files.read`/`files.write` RPC (mirroring the existing transcript-read RPC) reads/writes files on the session's host, with a realpath sandbox enforced daemon-side. The web app gains a single `openFile(sessionId, path)` action that opens a `FileEditorPanel` (CodeMirror 6, lazy-loaded). Two detectors call it: a chat detector (structured tool/attachment paths as chips + path tokens inside markdown `<code>` spans) and a native detector (an xterm link provider that links ANSI-styled, wrap-stitched path runs cross-checked against the session's transcript-known paths).

**Tech Stack:** TypeScript, Zod (protocol), tRPC (server), React 19 (web), xterm.js + `@xterm/addon-web-links` (terminal-client), CodeMirror 6 (new), Vitest (tests), bun (package manager / `bunx`).

## Global Constraints

- **Editor is editable + save**, not read-only (Phase 4 makes it writable; Phases 1–3 build the read path first).
- **Detection is highlighted-only.** Chat: a path links only inside an inline-`<code>` span or as a structured tool/attachment path. Native: a path run links only when ANSI-styled (non-default fg, bold, or underline).
- **Write is sandboxed to the repo** = the session `cwd` subtree. Reads additionally allowed for transcript-known paths (server sets a `knownPath` flag); those open **read-only**.
- **Sandbox is enforced daemon-side via `realpath`** (symlink-safe), using `path.relative` containment — never raw string-prefixing of unresolved input.
- **No addon reimplementation.** The native file-link provider is a new `registerLinkProvider` (not a fork of `@xterm/addon-web-links`). If the URL multiline bug is upstream, fix via `bun patch` + upstream PR.
- **CodeMirror is lazy-loaded** (dynamic `import()`), never in the first-paint bundle.
- `MAX_FILE_BYTES = 2 * 1024 * 1024`. `FILE_RPC_TIMEOUT_MS = 10_000`.
- Test runner: from a package dir, `bunx vitest run <relative-test-path>`. Test files import `{ describe, expect, it } from 'vitest'`.
- Commit after every task (the final step of each task).

---

## Phase 1 — Transport + read-only viewer

### Task 1: Protocol messages + `toolPaths` field

**Files:**
- Modify: `packages/protocol/src/messages.ts` (TranscriptItem ~193-225; ControlMessage union ~564-579; DaemonMessage union ~701-722)
- Test: `packages/protocol/src/file-messages.test.ts` (create)

**Interfaces:**
- Produces: `FileReadRequestMessage`, `FileReadResultMessage`, `FileWriteRequestMessage`, `FileWriteResultMessage` (Zod schemas + inferred types), all members of the existing `ControlMessage`/`DaemonMessage` unions. `TranscriptItem.toolPaths?: string[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/file-messages.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  ControlMessage,
  DaemonMessage,
  FileReadRequestMessage,
  FileReadResultMessage,
  FileWriteRequestMessage,
  FileWriteResultMessage,
  TranscriptItem,
} from './messages'

describe('file RPC messages', () => {
  it('parses a fileReadRequest with the knownPath flag', () => {
    const msg = {
      type: 'fileReadRequest',
      requestId: 'fr1',
      cwd: '/repo',
      path: '/repo/a.ts',
      knownPath: false,
    }
    expect(FileReadRequestMessage.parse(msg)).toEqual(msg)
    expect(ControlMessage.parse(msg)).toEqual(msg)
  })

  it('parses a fileReadResult carrying content + baseHash', () => {
    const msg = {
      type: 'fileReadResult',
      requestId: 'fr1',
      ok: true,
      path: '/repo/a.ts',
      content: 'hi',
      baseHash: '123:2',
    }
    expect(FileReadResultMessage.parse(msg)).toMatchObject({ ok: true, content: 'hi' })
    expect(DaemonMessage.parse(msg)).toMatchObject({ type: 'fileReadResult' })
  })

  it('parses a fileWriteRequest and a conflict result', () => {
    expect(
      FileWriteRequestMessage.parse({
        type: 'fileWriteRequest',
        requestId: 'fw1',
        cwd: '/repo',
        path: '/repo/a.ts',
        content: 'x',
        baseHash: '1:1',
      }).type,
    ).toBe('fileWriteRequest')
    expect(
      FileWriteResultMessage.parse({ type: 'fileWriteResult', requestId: 'fw1', ok: false, conflict: true })
        .conflict,
    ).toBe(true)
  })

  it('TranscriptItem accepts optional toolPaths', () => {
    const item = TranscriptItem.parse({ id: '1', role: 'tool', text: '', toolPaths: ['/repo/a.ts'] })
    expect(item.toolPaths).toEqual(['/repo/a.ts'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/protocol && bunx vitest run src/file-messages.test.ts`
Expected: FAIL — `FileReadRequestMessage` (etc.) is not exported.

- [ ] **Step 3: Add the schemas and union members**

In `packages/protocol/src/messages.ts`, add `toolPaths` to the `TranscriptItem` object (after `tags`):

```ts
  tags: z.array(TranscriptTag).optional(),
  /** Absolute file paths this item structurally references (tool file_path
   *  inputs and @-mention / edit / compact attachment filenames). Drives
   *  clickable file chips and the native-terminal link allow-set. */
  toolPaths: z.array(z.string()).optional(),
```

Add the four message schemas (place near `TranscriptReadRequestMessage` / `TranscriptReadResultMessage`):

```ts
export const FileReadRequestMessage = z.object({
  type: z.literal('fileReadRequest'),
  requestId: z.string(),
  cwd: z.string(),
  path: z.string(),
  /** Server-asserted: this path is in the session transcript-known set, so the
   *  daemon may read it even if it resolves outside the cwd. Read-only. */
  knownPath: z.boolean(),
})
export type FileReadRequestMessage = z.infer<typeof FileReadRequestMessage>

export const FileReadResultMessage = z.object({
  type: z.literal('fileReadResult'),
  requestId: z.string(),
  ok: z.boolean(),
  path: z.string(),
  content: z.string().optional(),
  /** `${mtimeMs}:${size}` snapshot, echoed back on write to detect conflicts. */
  baseHash: z.string().optional(),
  tooLarge: z.boolean().optional(),
  binary: z.boolean().optional(),
  error: z.string().optional(),
})
export type FileReadResultMessage = z.infer<typeof FileReadResultMessage>

export const FileWriteRequestMessage = z.object({
  type: z.literal('fileWriteRequest'),
  requestId: z.string(),
  cwd: z.string(),
  path: z.string(),
  content: z.string(),
  baseHash: z.string().optional(),
})
export type FileWriteRequestMessage = z.infer<typeof FileWriteRequestMessage>

export const FileWriteResultMessage = z.object({
  type: z.literal('fileWriteResult'),
  requestId: z.string(),
  ok: z.boolean(),
  baseHash: z.string().optional(),
  conflict: z.boolean().optional(),
  error: z.string().optional(),
})
export type FileWriteResultMessage = z.infer<typeof FileWriteResultMessage>
```

Add `FileReadRequestMessage` and `FileWriteRequestMessage` to the `ControlMessage` discriminated union list, and `FileReadResultMessage` and `FileWriteResultMessage` to the `DaemonMessage` discriminated union list.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/protocol && bunx vitest run src/file-messages.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/file-messages.test.ts
git commit -m "protocol: add file read/write RPC messages + TranscriptItem.toolPaths"
```

---

### Task 2: Daemon file handler + realpath sandbox

**Files:**
- Create: `apps/daemon/src/file-access.ts`
- Modify: `apps/daemon/src/daemon.ts` (add cases to the ControlMessage switch ~945-947, near `readParkedTranscript`)
- Test: `apps/daemon/src/file-access.test.ts` (create)

**Interfaces:**
- Produces: `isInside(child: string, parent: string): boolean`; `readFileSandboxed(opts: { cwd: string; path: string; knownPath: boolean }): Promise<Omit<FileReadResultMessage, 'type' | 'requestId'>>`; `writeFileSandboxed(opts: { cwd: string; path: string; content: string; baseHash?: string }): Promise<Omit<FileWriteResultMessage, 'type' | 'requestId'>>`.
- Consumes: `FileReadResultMessage`, `FileWriteResultMessage` types (Task 1).

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/file-access.test.ts`:

```ts
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isInside, readFileSandboxed, writeFileSandboxed } from './file-access'

async function repo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'podium-fa-'))
}

describe('isInside', () => {
  it('accepts a child path and rejects siblings / traversal', () => {
    expect(isInside('/r/a/b.ts', '/r')).toBe(true)
    expect(isInside('/r', '/r')).toBe(true)
    expect(isInside('/r-evil/x', '/r')).toBe(false)
    expect(isInside('/other', '/r')).toBe(false)
  })
})

describe('readFileSandboxed', () => {
  it('reads a file inside cwd and returns content + baseHash', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'hello')
    const r = await readFileSandboxed({ cwd, path: join(cwd, 'a.ts'), knownPath: false })
    expect(r.ok).toBe(true)
    expect(r.content).toBe('hello')
    expect(r.baseHash).toMatch(/^\d+(\.\d+)?:5$/)
  })

  it('rejects a path outside cwd when not knownPath', async () => {
    const cwd = await repo()
    const outside = await repo()
    await writeFile(join(outside, 'secret'), 'x')
    const r = await readFileSandboxed({ cwd, path: join(outside, 'secret'), knownPath: false })
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('allows an outside path when knownPath is true', async () => {
    const cwd = await repo()
    const outside = await repo()
    await writeFile(join(outside, 'memo.md'), 'note')
    const r = await readFileSandboxed({ cwd, path: join(outside, 'memo.md'), knownPath: true })
    expect(r.ok).toBe(true)
    expect(r.content).toBe('note')
  })

  it('rejects a symlink that escapes cwd', async () => {
    const cwd = await repo()
    const outside = await repo()
    await writeFile(join(outside, 'secret'), 'x')
    await symlink(join(outside, 'secret'), join(cwd, 'link'))
    const r = await readFileSandboxed({ cwd, path: join(cwd, 'link'), knownPath: false })
    expect(r.ok).toBe(false)
  })
})

describe('writeFileSandboxed', () => {
  it('writes inside cwd and detects a stale baseHash conflict', async () => {
    const cwd = await repo()
    const p = join(cwd, 'a.ts')
    await writeFile(p, 'orig')
    const ok = await writeFileSandboxed({ cwd, path: p, content: 'new' })
    expect(ok.ok).toBe(true)
    expect(await readFile(p, 'utf8')).toBe('new')
    const conflict = await writeFileSandboxed({ cwd, path: p, content: 'x', baseHash: 'stale:1' })
    expect(conflict.ok).toBe(false)
    expect(conflict.conflict).toBe(true)
  })

  it('refuses to write outside cwd', async () => {
    const cwd = await repo()
    const outside = await repo()
    const r = await writeFileSandboxed({ cwd, path: join(outside, 'x'), content: 'y' })
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/daemon && bunx vitest run src/file-access.test.ts`
Expected: FAIL — `./file-access` not found.

- [ ] **Step 3: Implement the sandbox module**

Create `apps/daemon/src/file-access.ts`:

```ts
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type { FileReadResultMessage, FileWriteResultMessage } from '@podium/protocol'

const MAX_FILE_BYTES = 2 * 1024 * 1024

type ReadResult = Omit<FileReadResultMessage, 'type' | 'requestId'>
type WriteResult = Omit<FileWriteResultMessage, 'type' | 'requestId'>

/** True when `child` is `parent` or nested under it (no `..` escape). Both args
 *  must already be realpath-resolved by the caller. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true
  return false
}

const sig = (s: { mtimeMs: number; size: number }): string => `${s.mtimeMs}:${s.size}`

export async function readFileSandboxed(opts: {
  cwd: string
  path: string
  knownPath: boolean
}): Promise<ReadResult> {
  const { cwd, path, knownPath } = opts
  let realCwd: string
  let real: string
  try {
    realCwd = await realpath(cwd)
    real = await realpath(path)
  } catch {
    return { ok: false, path, error: 'not found' }
  }
  if (!isInside(real, realCwd) && !knownPath) return { ok: false, path, error: 'outside workspace' }
  const st = await stat(real)
  if (!st.isFile()) return { ok: false, path, error: 'not a file' }
  if (st.size > MAX_FILE_BYTES) return { ok: false, path, tooLarge: true }
  const buf = await readFile(real)
  if (isBinary(buf)) return { ok: false, path, binary: true }
  return { ok: true, path, content: buf.toString('utf8'), baseHash: sig(st) }
}

export async function writeFileSandboxed(opts: {
  cwd: string
  path: string
  content: string
  baseHash?: string
}): Promise<WriteResult> {
  const { cwd, path, content, baseHash } = opts
  let realCwd: string
  let realDir: string
  try {
    realCwd = await realpath(cwd)
    realDir = await realpath(dirname(path))
  } catch {
    return { ok: false, error: 'not found' }
  }
  const real = join(realDir, basename(path))
  if (!isInside(real, realCwd)) return { ok: false, error: 'outside workspace' }
  if (baseHash) {
    const current = await stat(real)
      .then(sig)
      .catch(() => null)
    if (current && current !== baseHash) return { ok: false, conflict: true }
  }
  await writeFile(real, content, 'utf8')
  const st = await stat(real)
  return { ok: true, baseHash: sig(st) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/daemon && bunx vitest run src/file-access.test.ts`
Expected: PASS (all cases, including the symlink-escape rejection).

- [ ] **Step 5: Wire the handler into the daemon switch**

In `apps/daemon/src/daemon.ts`, import the helpers near the other imports:

```ts
import { readFileSandboxed, writeFileSandboxed } from './file-access'
```

Add cases to the ControlMessage switch (alongside `case 'transcriptReadRequest':`):

```ts
      case 'fileReadRequest':
        void readFileSandboxed({ cwd: msg.cwd, path: msg.path, knownPath: msg.knownPath }).then((r) =>
          send({ type: 'fileReadResult', requestId: msg.requestId, ...r }),
        )
        break
      case 'fileWriteRequest':
        void writeFileSandboxed({
          cwd: msg.cwd,
          path: msg.path,
          content: msg.content,
          ...(msg.baseHash ? { baseHash: msg.baseHash } : {}),
        }).then((r) => send({ type: 'fileWriteResult', requestId: msg.requestId, ...r }))
        break
```

- [ ] **Step 6: Run the daemon package tests + typecheck**

Run: `cd apps/daemon && bunx vitest run && bunx tsc --noEmit`
Expected: PASS, no type errors (the switch is now exhaustive over the new ControlMessage members).

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/file-access.ts apps/daemon/src/file-access.test.ts apps/daemon/src/daemon.ts
git commit -m "daemon: sandboxed file read/write handler (realpath boundary + conflict detection)"
```

---

### Task 3: Server relay `readFile`/`writeFile` + known-path policy

**Files:**
- Modify: `apps/server/src/relay.ts` (pending maps ~62-71; response handler switch ~963-970; new methods near `readTranscript` ~1015-1033)
- Test: `apps/server/src/file-relay.test.ts` (create)

**Interfaces:**
- Consumes: `daemonRequest` helper; `this.sessions` map with `session.cwd` and `session.transcriptItems()`.
- Produces: `SessionRegistry.knownPathsFor(session): Set<string>`; `readFile({ sessionId, path }): Promise<ReadPayload>`; `writeFile({ sessionId, path, content, baseHash? }): Promise<WritePayload>` where `ReadPayload = Omit<FileReadResultMessage,'type'|'requestId'>` and `WritePayload = Omit<FileWriteResultMessage,'type'|'requestId'>`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/file-relay.test.ts`. This unit-tests only the pure `knownPathsFor` policy (the RPC round-trip is covered by manual/integration testing since it needs a live daemon):

```ts
import { describe, expect, it } from 'vitest'
import { knownPathsFor } from './file-relay-policy'

describe('knownPathsFor', () => {
  it('collects toolPaths from transcript items into a set', () => {
    const set = knownPathsFor([
      { id: '1', role: 'tool', text: '', toolPaths: ['/repo/a.ts', '/home/u/memo.md'] },
      { id: '2', role: 'assistant', text: 'hi' },
      { id: '3', role: 'tool', text: '', toolPaths: ['/repo/a.ts'] },
    ])
    expect(set.has('/repo/a.ts')).toBe(true)
    expect(set.has('/home/u/memo.md')).toBe(true)
    expect(set.size).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bunx vitest run src/file-relay.test.ts`
Expected: FAIL — `./file-relay-policy` not found.

- [ ] **Step 3: Extract the pure policy helper**

Create `apps/server/src/file-relay-policy.ts`:

```ts
import type { TranscriptItem } from '@podium/protocol'

/** The set of absolute paths a session has structurally referenced — the
 *  read allow-list for files outside the repo cwd. */
export function knownPathsFor(items: TranscriptItem[]): Set<string> {
  const set = new Set<string>()
  for (const item of items) for (const p of item.toolPaths ?? []) set.add(p)
  return set
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bunx vitest run src/file-relay.test.ts`
Expected: PASS.

- [ ] **Step 5: Add relay plumbing**

In `apps/server/src/relay.ts`:

Import the policy + types:

```ts
import { knownPathsFor } from './file-relay-policy'
import type { FileReadResultMessage, FileWriteResultMessage } from '@podium/protocol'
```

Add pending maps beside `pendingTranscriptReads` (~line 71):

```ts
  private readonly pendingFileReads = new Map<
    string,
    (r: Omit<FileReadResultMessage, 'type' | 'requestId'>) => void
  >()
  private readonly pendingFileWrites = new Map<
    string,
    (r: Omit<FileWriteResultMessage, 'type' | 'requestId'>) => void
  >()
```

Add response cases beside `case 'transcriptReadResult':` (~line 970):

```ts
      case 'fileReadResult': {
        const resolve = this.pendingFileReads.get(msg.requestId)
        if (resolve) {
          this.pendingFileReads.delete(msg.requestId)
          const { type: _t, requestId: _r, ...payload } = msg
          resolve(payload)
        }
        break
      }
      case 'fileWriteResult': {
        const resolve = this.pendingFileWrites.get(msg.requestId)
        if (resolve) {
          this.pendingFileWrites.delete(msg.requestId)
          const { type: _t, requestId: _r, ...payload } = msg
          resolve(payload)
        }
        break
      }
```

Add the methods beside `readTranscript` (~line 1033), with a constant `const FILE_RPC_TIMEOUT_MS = 10_000` near the other timeouts:

```ts
  readFile({
    sessionId,
    path,
  }: {
    sessionId: string
    path: string
  }): Promise<Omit<FileReadResultMessage, 'type' | 'requestId'>> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.resolve({ ok: false, path, error: 'no session' })
    const knownPath = knownPathsFor(session.transcriptItems()).has(path)
    return this.daemonRequest(
      this.pendingFileReads,
      'fr',
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, path, error: 'timeout' }),
      (requestId) => ({ type: 'fileReadRequest', requestId, cwd: session.cwd, path, knownPath }),
    )
  }

  writeFile({
    sessionId,
    path,
    content,
    baseHash,
  }: {
    sessionId: string
    path: string
    content: string
    baseHash?: string
  }): Promise<Omit<FileWriteResultMessage, 'type' | 'requestId'>> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.resolve({ ok: false, error: 'no session' })
    return this.daemonRequest(
      this.pendingFileWrites,
      'fw',
      FILE_RPC_TIMEOUT_MS,
      () => ({ ok: false, error: 'timeout' }),
      (requestId) => ({
        type: 'fileWriteRequest',
        requestId,
        cwd: session.cwd,
        path,
        content,
        ...(baseHash ? { baseHash } : {}),
      }),
    )
  }
```

- [ ] **Step 6: Typecheck the server**

Run: `cd apps/server && bunx vitest run && bunx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/file-relay-policy.ts apps/server/src/file-relay.test.ts apps/server/src/relay.ts
git commit -m "server: relay readFile/writeFile via daemonRequest + known-path read policy"
```

---

### Task 4: tRPC `files` router

**Files:**
- Modify: `apps/server/src/router.ts` (add `files` sub-router beside `sessions` ~15-78)

**Interfaces:**
- Consumes: `ctx.registry.readFile`, `ctx.registry.writeFile` (Task 3).
- Produces: `trpc.files.read.query({ sessionId, path })`, `trpc.files.write.mutate({ sessionId, path, content, baseHash? })`.

- [ ] **Step 1: Add the router**

In `apps/server/src/router.ts`, inside `appRouter = t.router({ ... })`, add:

```ts
  files: t.router({
    read: t.procedure
      .input(z.object({ sessionId: z.string(), path: z.string() }))
      .query(({ ctx, input }) => ctx.registry.readFile(input)),
    write: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          path: z.string(),
          content: z.string(),
          baseHash: z.string().optional(),
        }),
      )
      .mutation(({ ctx, input }) => ctx.registry.writeFile(input)),
  }),
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/server && bunx tsc --noEmit`
Expected: PASS (the `AppRouter` type now includes `files`).

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/router.ts
git commit -m "server: expose files.read / files.write tRPC procedures"
```

---

### Task 5: Web store — `openFile`/`closeFile` + `readFile`/`writeFile`

**Files:**
- Modify: `apps/web/src/store.tsx` (Store interface ~63; state ~156-157; provider value; wrappers near `refreshPins`/`setPinned` ~177-183)
- Test: `apps/web/src/store-editor.test.ts` (create — pure reducer-style helper)

**Interfaces:**
- Produces (on the store / `useStore()`):
  - `editorFile: { sessionId: string; path: string } | null`
  - `openFile(sessionId: string, path: string): void`
  - `closeFile(): void`
  - `readFile(sessionId: string, path: string): Promise<Omit<FileReadResultMessage,'type'|'requestId'>>`
  - `writeFile(args: { sessionId: string; path: string; content: string; baseHash?: string }): Promise<Omit<FileWriteResultMessage,'type'|'requestId'>>`

- [ ] **Step 1: Write the failing test (path-normalization helper)**

`openFile` normalizes a path against the session cwd so relative paths from prose/terminal resolve to absolute. Create `apps/web/src/file-path.ts` consumers' test first — `apps/web/src/file-path.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { resolveAgainstCwd } from './file-path'

describe('resolveAgainstCwd', () => {
  it('keeps absolute paths', () => {
    expect(resolveAgainstCwd('/repo', '/repo/a.ts')).toBe('/repo/a.ts')
  })
  it('joins relative paths onto cwd', () => {
    expect(resolveAgainstCwd('/repo', 'src/a.ts')).toBe('/repo/src/a.ts')
    expect(resolveAgainstCwd('/repo/', './src/a.ts')).toBe('/repo/src/a.ts')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bunx vitest run src/file-path.test.ts`
Expected: FAIL — `./file-path` not found.

- [ ] **Step 3: Implement the helper**

Create `apps/web/src/file-path.ts`:

```ts
/** Resolve a path that may be relative to a session cwd into an absolute path.
 *  Browser-side, so no node:path — POSIX join + a light `.`/`..` normalize. */
export function resolveAgainstCwd(cwd: string, path: string): string {
  const abs = path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`
  const out: string[] = []
  for (const seg of abs.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `/${out.join('/')}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bunx vitest run src/file-path.test.ts`
Expected: PASS.

- [ ] **Step 5: Add store state + methods**

In `apps/web/src/store.tsx`:

Add to the `Store` interface (near `setPane`, ~line 63):

```ts
  editorFile: { sessionId: string; path: string } | null
  openFile: (sessionId: string, path: string) => void
  closeFile: () => void
  readFile: (
    sessionId: string,
    path: string,
  ) => Promise<Awaited<ReturnType<Trpc['files']['read']['query']>>>
  writeFile: (args: {
    sessionId: string
    path: string
    content: string
    baseHash?: string
  }) => Promise<Awaited<ReturnType<Trpc['files']['write']['mutate']>>>
```

Add state (near `paneA`/`paneB`, ~line 156):

```ts
  const [editorFile, setEditorFile] = useState<{ sessionId: string; path: string } | null>(null)
```

Add the methods (near `refreshPins`/`setPinned`, ~line 177):

```ts
  const openFile = useMemo(
    () => (sessionId: string, path: string) => setEditorFile({ sessionId, path }),
    [],
  )
  const closeFile = useMemo(() => () => setEditorFile(null), [])
  const readFile = useMemo(
    () => (sessionId: string, path: string) => trpc.files.read.query({ sessionId, path }),
    [trpc],
  )
  const writeFile = useMemo(
    () => (args: { sessionId: string; path: string; content: string; baseHash?: string }) =>
      trpc.files.write.mutate(args),
    [trpc],
  )
```

Add `editorFile, openFile, closeFile, readFile, writeFile` to the provider's value object.

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/file-path.ts apps/web/src/file-path.test.ts apps/web/src/store.tsx
git commit -m "web: store openFile/closeFile + readFile/writeFile + path resolver"
```

---

### Task 6: `FileEditorPanel` (read-only) + Workspace overlay + CodeMirror dep

**Files:**
- Modify: `apps/web/package.json` (add CodeMirror deps)
- Create: `apps/web/src/FileEditorPanel.tsx`
- Modify: `apps/web/src/Workspace.tsx` (render the overlay after the deck ~197)

**Interfaces:**
- Consumes: `useStore()` → `editorFile`, `closeFile`, `readFile` (Task 5).
- Produces: `<FileEditorPanel />` (no props; reads `editorFile` from the store). Renders nothing when `editorFile` is null.

- [ ] **Step 1: Add CodeMirror dependencies**

Run from the worktree root:

```bash
cd apps/web && bun add codemirror @codemirror/state @codemirror/view @codemirror/lang-javascript @codemirror/lang-json @codemirror/lang-markdown @codemirror/lang-python @codemirror/lang-css @codemirror/lang-html
```

Expected: `package.json` gains the deps; `bun.lock` updates.

- [ ] **Step 2: Write the language-selection test**

Create `apps/web/src/editor-lang.ts` consumers' test `apps/web/src/editor-lang.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { langIdForPath } from './editor-lang'

describe('langIdForPath', () => {
  it('maps extensions to language ids', () => {
    expect(langIdForPath('/a/b.ts')).toBe('javascript')
    expect(langIdForPath('/a/b.tsx')).toBe('javascript')
    expect(langIdForPath('/a/b.json')).toBe('json')
    expect(langIdForPath('/a/readme.md')).toBe('markdown')
    expect(langIdForPath('/a/x.unknownext')).toBe('plain')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web && bunx vitest run src/editor-lang.test.ts`
Expected: FAIL — `./editor-lang` not found.

- [ ] **Step 4: Implement the language map**

Create `apps/web/src/editor-lang.ts`:

```ts
export type LangId = 'javascript' | 'json' | 'markdown' | 'python' | 'css' | 'html' | 'plain'

const BY_EXT: Record<string, LangId> = {
  ts: 'javascript', tsx: 'javascript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json',
  md: 'markdown', markdown: 'markdown',
  py: 'python',
  css: 'css', scss: 'css',
  html: 'html', htm: 'html',
}

export function langIdForPath(path: string): LangId {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return BY_EXT[ext] ?? 'plain'
}

/** Lazily import the CodeMirror language extension for a file. Kept out of the
 *  first-paint bundle. */
export async function loadLanguage(id: LangId): Promise<import('@codemirror/state').Extension[]> {
  switch (id) {
    case 'javascript':
      return [(await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true })]
    case 'json':
      return [(await import('@codemirror/lang-json')).json()]
    case 'markdown':
      return [(await import('@codemirror/lang-markdown')).markdown()]
    case 'python':
      return [(await import('@codemirror/lang-python')).python()]
    case 'css':
      return [(await import('@codemirror/lang-css')).css()]
    case 'html':
      return [(await import('@codemirror/lang-html')).html()]
    default:
      return []
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && bunx vitest run src/editor-lang.test.ts`
Expected: PASS.

- [ ] **Step 6: Implement the read-only panel**

Create `apps/web/src/FileEditorPanel.tsx`:

```tsx
import { EditorState } from '@codemirror/state'
import { EditorView, basicSetup } from 'codemirror'
import { X } from 'lucide-react'
import { type JSX, useEffect, useRef, useState } from 'react'
import { langIdForPath, loadLanguage } from './editor-lang'
import { useStore } from './store'

export function FileEditorPanel(): JSX.Element | null {
  const { editorFile, closeFile, readFile } = useStore()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!editorFile) return
    let view: EditorView | null = null
    let cancelled = false
    setStatus('loading')
    void (async () => {
      const r = await readFile(editorFile.sessionId, editorFile.path)
      if (cancelled) return
      if (!r.ok) {
        setStatus('error')
        setMessage(r.tooLarge ? 'File too large' : r.binary ? 'Binary file' : (r.error ?? 'Failed to open'))
        return
      }
      const ext = await loadLanguage(langIdForPath(editorFile.path))
      if (cancelled || !hostRef.current) return
      view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: r.content ?? '',
          extensions: [basicSetup, ...ext, EditorView.editable.of(false)],
        }),
      })
      setStatus('ready')
    })()
    return () => {
      cancelled = true
      view?.destroy()
    }
  }, [editorFile, readFile])

  if (!editorFile) return null
  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {editorFile.path}
        </span>
        <button type="button" onClick={closeFile} aria-label="Close" className="text-muted-foreground">
          <X size={16} />
        </button>
      </div>
      {status === 'error' ? (
        <div className="p-4 text-sm text-muted-foreground">{message}</div>
      ) : (
        <div ref={hostRef} className="min-h-0 flex-1 overflow-auto text-[13px]" />
      )}
    </div>
  )
}
```

- [ ] **Step 7: Mount the overlay in Workspace**

In `apps/web/src/Workspace.tsx`, import the panel and render it after the deck `</div>` (~line 197), inside the relatively-positioned container so `absolute inset-0` overlays the deck:

```tsx
import { FileEditorPanel } from './FileEditorPanel'
```

```tsx
        </div>
        <FileEditorPanel />
```

Ensure the immediate parent wrapping the deck is `relative` (add `relative` to its className if missing).

- [ ] **Step 8: Build the web app to verify it compiles + bundles**

Run: `cd apps/web && bunx tsc --noEmit && bun run build`
Expected: PASS; build output shows CodeMirror in a lazily-loaded chunk (dynamic import), not the entry chunk.

- [ ] **Step 9: Manual smoke (temporary hook)**

Temporarily add `onClick={() => openFile(sessionId, session?.cwd ?? '/')}` is not meaningful; instead verify via the browser devtools console after the next tasks wire real triggers. For now, confirm `FileEditorPanel` renders nothing when `editorFile` is null (no console errors on load).

- [ ] **Step 10: Commit**

```bash
git add apps/web/package.json apps/web/bun.lock apps/web/src/editor-lang.ts apps/web/src/editor-lang.test.ts apps/web/src/FileEditorPanel.tsx apps/web/src/Workspace.tsx
git commit -m "web: read-only CodeMirror FileEditorPanel as a Workspace overlay"
```

---

## Phase 2 — Chat detection

### Task 7: Parser emits `toolPaths` (tool inputs + attachment lines)

**Files:**
- Modify: `packages/agent-bridge/src/transcript/claude.ts` (`claudeRecordToItems` ~26-53; tool_use parse ~157-172; add an attachment branch)
- Modify: `packages/agent-bridge/src/transcript/claude.test.ts` (EXISTS — append a new describe block; `claudeRecordToItems` is already imported from `'./claude.js'`)

**Interfaces:**
- Produces: `claudeRecordToItems` (returns `TranscriptItem[]`) sets `toolPaths` on items derived from tool_use `file_path`/`path`/`notebook_path` and from top-level `attachment` records (`file` / `edited_text_file` / `compact_file_reference`).

**Note:** `claude.test.ts` already exists with `claudeRecordColor`/`claudeRecordToItems`/`toolInputPreview` describe blocks and the import `import { claudeRecordColor, claudeRecordToItems, toolInputPreview } from './claude.js'`. Do NOT re-add imports or recreate the file — append only.

- [ ] **Step 1: Write the failing tests**

Append this describe block to the existing `packages/agent-bridge/src/transcript/claude.test.ts` (imports are already present):

```ts
describe('claudeRecordToItems toolPaths', () => {
  it('extracts file_path from a tool_use block', () => {
    const items = claudeRecordToItems({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } }] },
    })
    expect(items.some((i) => i.toolPaths?.includes('/repo/a.ts'))).toBe(true)
  })

  it('extracts an @-mention file attachment path', () => {
    const items = claudeRecordToItems({
      type: 'attachment',
      attachment: { type: 'file', filename: '/repo/spec.md', displayPath: 'spec.md' },
    })
    expect(items.some((i) => i.toolPaths?.includes('/repo/spec.md'))).toBe(true)
  })

  it('extracts an edited_text_file attachment path', () => {
    const items = claudeRecordToItems({
      type: 'attachment',
      attachment: { type: 'edited_text_file', filename: '/repo/b.ts', snippet: '...' },
    })
    expect(items.some((i) => i.toolPaths?.includes('/repo/b.ts'))).toBe(true)
  })
})
```

(If `claudeRecordToItems` returns a single item rather than an array, adapt the assertions to that shape — match the existing signature.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/agent-bridge && bunx vitest run src/transcript/claude.test.ts`
Expected: FAIL — items have no `toolPaths` and the attachment branch returns nothing.

- [ ] **Step 3: Implement extraction**

In `packages/agent-bridge/src/transcript/claude.ts`, add a helper near `toolInputPreview` (~line 195):

```ts
const FILE_PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const

function toolPathsFromInput(input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const rec = input as Record<string, unknown>
  const out: string[] = []
  for (const k of FILE_PATH_KEYS) if (typeof rec[k] === 'string') out.push(rec[k] as string)
  return out
}
```

In the `tool_use` branch (~157-172), set `toolPaths` on the produced item when non-empty:

```ts
        const paths = toolPathsFromInput(b.input)
        // ...existing item construction..., adding:
        ...(paths.length ? { toolPaths: paths } : {}),
```

Add a top-level attachment branch in `claudeRecordToItems` (where record `type` is dispatched). The three subtypes all expose `filename` (absolute):

```ts
  if (rec.type === 'attachment') {
    const att = (rec as { attachment?: { type?: string; filename?: string } }).attachment
    const sub = att?.type
    if ((sub === 'file' || sub === 'edited_text_file' || sub === 'compact_file_reference') && att?.filename) {
      return [
        {
          id: /* reuse existing id strategy, e.g. */ `att-${att.filename}`,
          role: 'user',
          text: '',
          toolPaths: [att.filename],
          tags: [{ kind: 'file', label: att.filename.split('/').pop() ?? att.filename }],
        },
      ]
    }
    return []
  }
```

(Match the function's actual return type/shape and id strategy from the surrounding code; the essential change is: emit `toolPaths: [filename]`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent-bridge && bunx vitest run src/transcript/claude.test.ts`
Expected: PASS, and the existing `toolInputPreview` tests stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/transcript/claude.ts packages/agent-bridge/src/transcript/claude.test.ts
git commit -m "agent-bridge: surface tool/attachment file paths as TranscriptItem.toolPaths"
```

---

### Task 8: Chat clickable chips (structured paths)

**Files:**
- Modify: `apps/web/src/ChatView.tsx` (`ToolBlock` ~625-661; tag rendering ~515-531; access `sessionId` prop ~37)

**Interfaces:**
- Consumes: `item.toolPaths` (Task 7); `useStore().openFile`, session `cwd`; `resolveAgainstCwd` (Task 5).

- [ ] **Step 1: Render tool paths as clickable chips in ToolBlock**

In `apps/web/src/ChatView.tsx`, get `openFile` and the session cwd at the top of `ChatView` (it already receives `sessionId`):

```tsx
  const { hub, openFile, sessions } = useStore()
  const cwd = sessions.find((s) => s.sessionId === sessionId)?.cwd ?? '/'
```

Thread `sessionId`/`cwd`/`openFile` to `ToolBlock` (add props), and in `ToolBlock` render chips for `item.toolPaths`:

```tsx
      {item.toolPaths?.map((p) => (
        <button
          key={p}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            openFile(sessionId, resolveAgainstCwd(cwd, p))
          }}
          className="ml-[17px] inline-flex max-w-full items-center gap-1 truncate rounded border border-input px-[7px] py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          title={`Open ${p}`}
        >
          {p.split('/').pop()}
        </button>
      ))}
```

Make the file `tags` pills (~515-531) clickable the same way when `tag.kind === 'file'` and a matching path exists in `item.toolPaths` (open the first toolPath). Import `resolveAgainstCwd` from `./file-path`.

- [ ] **Step 2: Typecheck + build**

Run: `cd apps/web && bunx tsc --noEmit && bun run build`
Expected: PASS.

- [ ] **Step 3: Manual verification**

In the running app, open a session with Read/Edit tool calls in chat → a file chip appears under the tool row → clicking it opens the editor overlay showing the file. (Verification deferred to the end-of-phase manual pass if no live session is available now.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/ChatView.tsx
git commit -m "web: clickable file chips for tool/attachment paths in chat"
```

---

### Task 9: Chat prose linkification (paths inside `<code>` spans)

**Files:**
- Modify: `apps/web/src/markdown.ts` (`renderMarkdown` ~51)
- Modify: `apps/web/src/ChatView.tsx` (click delegation on the rendered-HTML container ~510-514)
- Modify: `apps/web/src/markdown.test.ts` (EXISTS — has a `renderMarkdown` describe block with 5 tests; add `linkifyCodePaths` to the import on line 2 and append a new describe block. Do NOT recreate the file.)

**Interfaces:**
- Produces: `linkifyCodePaths(html: string): string` — wraps path-like tokens inside `<code>…</code>` in `<a class="file-link" data-path="…">`. `renderMarkdown` calls it between `marked.parse` and `DOMPurify.sanitize`. The regex (`/<code>([^<]+)<\/code>/g`) only matches attribute-less `<code>` whose content has no child tags, so it leaves the existing diff/escape tests untouched.

- [ ] **Step 1: Write the failing test**

In the existing `apps/web/src/markdown.test.ts`, change line 2 to `import { linkifyCodePaths, renderMarkdown } from './markdown'` and append this describe block:

```ts
describe('linkifyCodePaths', () => {
  it('links a path-like token inside a code span', () => {
    const out = linkifyCodePaths('see <code>apps/web/src/derive.ts</code> now')
    expect(out).toContain('class="file-link"')
    expect(out).toContain('data-path="apps/web/src/derive.ts"')
  })

  it('leaves non-path code spans alone', () => {
    const out = linkifyCodePaths('<code>bun test</code>')
    expect(out).not.toContain('file-link')
  })

  it('does not touch text outside code spans', () => {
    const out = linkifyCodePaths('apps/web/src/derive.ts')
    expect(out).not.toContain('file-link')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bunx vitest run src/markdown.test.ts`
Expected: FAIL — `linkifyCodePaths` not exported.

- [ ] **Step 3: Implement linkification + call it in renderMarkdown**

In `apps/web/src/markdown.ts`, add (and export) the function and call it inside `renderMarkdown`:

```ts
// A token looks like a file path if it has a directory separator or a known
// code-file extension. Conservative on purpose — the backtick is the intent
// signal; this only filters out non-file code spans (commands, identifiers).
const PATHISH = /^[\w./@~-]+\/[\w./@~-]+$|^[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|css|scss|html|htm|rs|go|sh|yml|yaml|toml)$/

export function linkifyCodePaths(html: string): string {
  return html.replace(/<code>([^<]+)<\/code>/g, (full, inner: string) => {
    const token = inner.trim()
    if (!PATHISH.test(token)) return full
    return `<code><a class="file-link" data-path="${token}">${inner}</a></code>`
  })
}

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(linkifyCodePaths(marked.parse(text, { async: false })))
}
```

(DOMPurify keeps `<a>`, `class`, and `data-*` attributes by default, so the marker survives sanitization.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bunx vitest run src/markdown.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire click delegation in ChatView**

In `apps/web/src/ChatView.tsx`, on the element that renders `dangerouslySetInnerHTML` (~510-514), add an `onClick` that intercepts `.file-link` clicks:

```tsx
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest('a.file-link') as HTMLElement | null
          if (!a) return
          e.preventDefault()
          const p = a.getAttribute('data-path')
          if (p) openFile(sessionId, resolveAgainstCwd(cwd, p))
        }}
```

Add a CSS rule for `.file-link` (underline/pointer) in the chat stylesheet so the affordance is visible.

- [ ] **Step 6: Build**

Run: `cd apps/web && bunx tsc --noEmit && bun run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/markdown.ts apps/web/src/markdown.test.ts apps/web/src/ChatView.tsx
git commit -m "web: linkify file paths inside chat code spans → openFile"
```

---

## Phase 3 — Native detection + multiline fix

### Task 10: Wrap-stitched logical-line builder (the multiline core)

**Files:**
- Create: `packages/terminal-client/src/buffer-line.ts`
- Test: `packages/terminal-client/src/buffer-line.test.ts`

**Interfaces:**
- Produces:
  - `type Cell = { char: string; x: number; y: number; styled: boolean }`
  - `type BufferLike = { getLine(y: number): LineLike | undefined }`, `type LineLike = { length: number; isWrapped: boolean; getCell(x: number, c?: unknown): CellLike | undefined }`, `type CellLike = { getChars(): string; getWidth(): number; isBold(): boolean; getFgColor(): number; getFgColorMode(): number; isUnderline(): boolean }`
  - `stitchLogicalLine(buf: BufferLike, anyRow: number): Cell[]` — returns the full logical line containing `anyRow`, walking back to the first non-wrapped row and forward through `isWrapped` continuations, each cell carrying its real `{x,y}` and a `styled` flag (non-default fg OR bold OR underline).

- [ ] **Step 1: Write the failing test**

Create `packages/terminal-client/src/buffer-line.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { stitchLogicalLine } from './buffer-line'

// Minimal fake xterm buffer: rows of [char, styled] pairs; row N>0 wrapped flag.
function fakeBuf(rows: Array<{ cells: Array<[string, boolean]>; wrapped: boolean }>) {
  return {
    getLine(y: number) {
      const row = rows[y]
      if (!row) return undefined
      return {
        length: row.cells.length,
        isWrapped: row.wrapped,
        getCell(x: number) {
          const c = row.cells[x]
          if (!c) return undefined
          return {
            getChars: () => c[0],
            getWidth: () => 1,
            isBold: () => c[1],
            isUnderline: () => false,
            getFgColor: () => -1,
            getFgColorMode: () => 0,
          }
        },
      }
    },
  }
}

describe('stitchLogicalLine', () => {
  it('joins a path that wraps across two rows into one logical line with real coords', () => {
    // "/repo/a" on row 0, "bc.ts" wrapped onto row 1, all bold (styled).
    const buf = fakeBuf([
      { cells: [...'/repo/a'].map((c) => [c, true] as [string, boolean]), wrapped: false },
      { cells: [...'bc.ts'].map((c) => [c, true] as [string, boolean]), wrapped: true },
    ])
    const cells = stitchLogicalLine(buf, 1) // ask about the continuation row
    expect(cells.map((c) => c.char).join('')).toBe('/repo/abc.ts')
    expect(cells.find((c) => c.char === 'b')).toMatchObject({ x: 0, y: 1 })
    expect(cells.every((c) => c.styled)).toBe(true)
  })

  it('marks default-fg, non-bold cells as not styled', () => {
    const buf = fakeBuf([{ cells: [['x', false]], wrapped: false }])
    expect(stitchLogicalLine(buf, 0)[0].styled).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/terminal-client && bunx vitest run src/buffer-line.test.ts`
Expected: FAIL — `./buffer-line` not found.

- [ ] **Step 3: Implement the stitcher**

Create `packages/terminal-client/src/buffer-line.ts`:

```ts
export interface CellLike {
  getChars(): string
  getWidth(): number
  isBold(): boolean
  isUnderline(): boolean
  getFgColor(): number
  getFgColorMode(): number
}
export interface LineLike {
  length: number
  isWrapped: boolean
  getCell(x: number, cell?: unknown): CellLike | undefined
}
export interface BufferLike {
  getLine(y: number): LineLike | undefined
}

export interface Cell {
  char: string
  x: number
  y: number
  styled: boolean
}

function cellStyled(c: CellLike): boolean {
  // Default fg in xterm is mode 0 (DEFAULT). Any explicit colour, bold, or
  // underline counts as "highlighted".
  return c.getFgColorMode() !== 0 || c.isBold() || c.isUnderline()
}

/** Build the full logical line containing `anyRow`: walk back to the first row
 *  whose successor chain reaches anyRow (i.e. the first non-wrapped row), then
 *  forward through wrapped continuations. Each emitted cell keeps its real
 *  buffer coordinate so matches map back to the grid. */
export function stitchLogicalLine(buf: BufferLike, anyRow: number): Cell[] {
  let start = anyRow
  while (start > 0) {
    const line = buf.getLine(start)
    if (!line?.isWrapped) break
    start -= 1
  }
  const out: Cell[] = []
  for (let y = start; ; y += 1) {
    const line = buf.getLine(y)
    if (!line) break
    if (y !== start && !line.isWrapped) break
    for (let x = 0; x < line.length; x += 1) {
      const c = line.getCell(x)
      if (!c) continue
      if (c.getWidth() === 0) continue // spacer half of a wide glyph
      const char = c.getChars() || ' '
      out.push({ char, x, y, styled: cellStyled(c) })
    }
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/terminal-client && bunx vitest run src/buffer-line.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/terminal-client/src/buffer-line.ts packages/terminal-client/src/buffer-line.test.ts
git commit -m "terminal-client: wrap-stitched logical-line builder with per-cell style + coords"
```

---

### Task 11: File-path link provider + `TerminalView.setFileLinks`

**Files:**
- Create: `packages/terminal-client/src/file-link-provider.ts`
- Modify: `packages/terminal-client/src/terminal-view.ts` (add `setFileLinks`; register the provider)
- Test: `packages/terminal-client/src/file-link-provider.test.ts`

**Interfaces:**
- Consumes: `stitchLogicalLine`, `Cell`, `BufferLike` (Task 10).
- Produces:
  - `type FileLinkConfig = { cwd: string; knownPaths: Set<string>; onOpen: (absPath: string) => void }`
  - `findStyledPathMatches(cells: Cell[], cfg: FileLinkConfig): Array<{ path: string; cells: Cell[] }>` — styled, path-like runs that resolve to a known path (suffix match) or look like a repo path.
  - `TerminalView.setFileLinks(cfg: FileLinkConfig | null): void`

- [ ] **Step 1: Write the failing test**

Create `packages/terminal-client/src/file-link-provider.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Cell } from './buffer-line'
import { findStyledPathMatches } from './file-link-provider'

function cells(s: string, styled: boolean, y = 0): Cell[] {
  return [...s].map((char, x) => ({ char, x, y, styled }))
}

describe('findStyledPathMatches', () => {
  const cfg = { cwd: '/repo', knownPaths: new Set(['/repo/apps/web/src/derive.ts']), onOpen: () => {} }

  it('matches a styled path-like run', () => {
    const m = findStyledPathMatches(cells('edit apps/web/src/derive.ts', true), cfg)
    expect(m).toHaveLength(1)
    expect(m[0].path).toBe('apps/web/src/derive.ts')
  })

  it('ignores an unstyled run even if path-like', () => {
    expect(findStyledPathMatches(cells('apps/web/src/derive.ts', false), cfg)).toHaveLength(0)
  })

  it('keeps the real coords of the matched cells for wrapped runs', () => {
    const run = [...cells('/repo/a', true, 0), ...cells('bc.ts', true, 1)]
    const m = findStyledPathMatches(run, cfg)
    expect(m[0].cells[0]).toMatchObject({ y: 0 })
    expect(m[0].cells.at(-1)).toMatchObject({ y: 1 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/terminal-client && bunx vitest run src/file-link-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement match logic + the provider**

Create `packages/terminal-client/src/file-link-provider.ts`:

```ts
import { type BufferLike, type Cell, stitchLogicalLine } from './buffer-line'

export interface FileLinkConfig {
  cwd: string
  knownPaths: Set<string>
  onOpen: (absPath: string) => void
}

// A run of these characters is a path candidate. Trailing punctuation is trimmed.
const PATH_CHARS = /[\w./@~-]/
const PATHISH =
  /\/[\w./@~-]+|[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|css|scss|html|htm|rs|go|sh|yml|yaml|toml)/

function resolveAgainstCwd(cwd: string, path: string): string {
  const abs = path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`
  const out: string[] = []
  for (const seg of abs.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `/${out.join('/')}`
}

/** A candidate is accepted if its resolved absolute path is a known transcript
 *  path, or a known path ends with the candidate (suffix match for truncated
 *  TUI paths), or it resolves under cwd and looks path-like. */
function accept(token: string, cfg: FileLinkConfig): string | null {
  if (!PATHISH.test(token)) return null
  const abs = resolveAgainstCwd(cfg.cwd, token)
  if (cfg.knownPaths.has(abs)) return abs
  for (const k of cfg.knownPaths) if (k.endsWith(`/${token}`) || k === token) return k
  if (abs.startsWith(`${cfg.cwd.replace(/\/+$/, '')}/`)) return abs
  return null
}

export function findStyledPathMatches(
  cells: Cell[],
  cfg: FileLinkConfig,
): Array<{ path: string; cells: Cell[] }> {
  const matches: Array<{ path: string; cells: Cell[] }> = []
  let run: Cell[] = []
  const flush = (): void => {
    if (run.length) {
      let token = run.map((c) => c.char).join('')
      let trimmed = run
      // Trim trailing sentence punctuation that isn't part of a path.
      while (trimmed.length && /[.,;:)\]]$/.test(token) && !/\.\w+$/.test(token)) {
        trimmed = trimmed.slice(0, -1)
        token = trimmed.map((c) => c.char).join('')
      }
      const abs = accept(token, cfg)
      if (abs) matches.push({ path: abs, cells: trimmed })
    }
    run = []
  }
  for (const c of cells) {
    if (c.styled && PATH_CHARS.test(c.char)) run.push(c)
    else flush()
  }
  flush()
  return matches
}

/** Build an xterm ILinkProvider from a config + a live buffer accessor. */
export function makeFileLinkProvider(
  getBuffer: () => BufferLike,
  getConfig: () => FileLinkConfig | null,
) {
  return {
    provideLinks(
      bufferLineNumber: number,
      callback: (links: Array<unknown> | undefined) => void,
    ): void {
      const cfg = getConfig()
      if (!cfg) return callback(undefined)
      const cells = stitchLogicalLine(getBuffer(), bufferLineNumber - 1) // xterm rows are 1-based here
      const onThisRow = (m: { cells: Cell[] }): boolean =>
        m.cells.some((c) => c.y === bufferLineNumber - 1)
      const links = findStyledPathMatches(cells, cfg)
        .filter(onThisRow)
        .map((m) => {
          const first = m.cells[0]
          const last = m.cells[m.cells.length - 1]
          return {
            text: m.path,
            range: {
              start: { x: first.x + 1, y: first.y + 1 },
              end: { x: last.x + 1, y: last.y + 1 },
            },
            activate: () => cfg.onOpen(m.path),
          }
        })
      callback(links.length ? links : undefined)
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/terminal-client && bunx vitest run src/file-link-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the provider in TerminalView**

In `packages/terminal-client/src/terminal-view.ts`:

Import + add a field and a setter; register the provider once in the constructor (after the WebLinksAddon load ~95):

```ts
import { type FileLinkConfig, makeFileLinkProvider } from './file-link-provider'
```

```ts
  private fileLinkConfig: FileLinkConfig | null = null

  // in the constructor, after loading WebLinksAddon:
    this.term.registerLinkProvider(
      makeFileLinkProvider(
        () => this.term.buffer.active as unknown as import('./buffer-line').BufferLike,
        () => this.fileLinkConfig,
      ),
    )

  /** Configure (or clear) clickable file-path links. Highlighted, path-like runs
   *  that resolve to a known path or a path under cwd become clickable. */
  setFileLinks(cfg: FileLinkConfig | null): void {
    this.fileLinkConfig = cfg
  }
```

- [ ] **Step 6: Typecheck the package**

Run: `cd packages/terminal-client && bunx tsc --noEmit && bunx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/terminal-client/src/file-link-provider.ts packages/terminal-client/src/file-link-provider.test.ts packages/terminal-client/src/terminal-view.ts
git commit -m "terminal-client: styled file-path link provider with wrap-aware multi-row ranges"
```

---

### Task 12: Feed config from AgentPanel (sessionId, cwd, known paths, openFile)

**Files:**
- Modify: `packages/terminal-client/src/index.ts` and/or `session-mount.ts` (expose `setFileLinks` on `MountedSession.view` — it already is, via `TerminalView`)
- Modify: `apps/web/src/AgentPanel.tsx` (after mount ~138-156; subscribe to transcript for known paths)

**Interfaces:**
- Consumes: `mounted.view.setFileLinks` (Task 11); `useStore().openFile`; `hub.subscribeTranscript`; `session.cwd`; `resolveAgainstCwd`.

- [ ] **Step 1: Collect known paths + configure the provider**

In `apps/web/src/AgentPanel.tsx`, after `mountedRef.current = mounted` (~149), wire the file-link config. Maintain a known-path set from the transcript subscription:

```tsx
  // near other hooks
  const { hub, openFile } = useStore()
  const knownPathsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    return hub.subscribeTranscript(sessionId, (items) => {
      const set = new Set<string>()
      for (const it of items) for (const p of it.toolPaths ?? []) set.add(p)
      knownPathsRef.current = set
      mountedRef.current?.view.setFileLinks({
        cwd: session?.cwd ?? '/',
        knownPaths: set,
        onOpen: (abs) => openFile(sessionId, abs),
      })
    })
  }, [hub, sessionId, session?.cwd, openFile])
```

And set an initial (possibly empty) config right after mount so links work before the first transcript callback:

```tsx
  mounted.view.setFileLinks({
    cwd: session?.cwd ?? '/',
    knownPaths: knownPathsRef.current,
    onOpen: (abs) => openFile(sessionId, abs),
  })
```

(If `AgentPanel` already subscribes to the transcript elsewhere, reuse that subscription instead of adding a second one.)

- [ ] **Step 2: Typecheck + build**

Run: `cd apps/web && bunx tsc --noEmit && bun run build`
Expected: PASS.

- [ ] **Step 3: Manual verification**

In a live session, when the agent prints a coloured path in the TUI, hovering shows the link affordance and clicking opens the editor. Deferred to the end-of-phase manual pass.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/AgentPanel.tsx
git commit -m "web: feed cwd + transcript-known paths + openFile into the terminal link provider"
```

---

### Task 13: Diagnose & fix the URL multiline (wrapped) link bug

**Files:**
- Modify (provisional): `packages/terminal-client/src/terminal-view.ts` and/or a `patches/` entry via `bun patch` (decided by the diagnosis)
- Create: `packages/terminal-client/src/web-links-wrap.test.ts` (regression guard)

**Interfaces:**
- No new exported API. Outcome: a wrapped URL is clickable along its whole range on a narrow terminal.

- [ ] **Step 1: Reproduce and locate the root cause**

The bug shows on mobile because the narrow terminal wraps links constantly. Reproduce deterministically:

```bash
cd packages/terminal-client
# Inspect how the stock addon stitches wrapped lines + builds the link range:
sed -n '1,200p' node_modules/@xterm/addon-web-links/lib/addon-web-links.js
```

Determine which of these is true (write the finding into the commit message):
- (a) the addon's wrapped-line range math is wrong (off-by-one / wrong row on the continuation), OR
- (b) Podium's integration breaks it (e.g. the WebGL renderer link decoration, the custom `dom-viewport` scroll, or the mobile remount at the 768px breakpoint re-registers nothing), OR
- (c) tap activation on the continuation row doesn't hit the link range.

Use a focused DOM test (happy-dom is already the terminal-client test env) to assert the link range produced for a URL that spans two rows.

- [ ] **Step 2: Write the failing regression test**

Create `packages/terminal-client/src/web-links-wrap.test.ts` asserting the behavior that's currently broken. If the root cause is (a) — the addon — assert against the addon's `LinkComputer`/provider output for a two-row URL. If (b)/(c) — assert against `TerminalView` wiring (e.g. that a provider is registered and returns a multi-row range after a simulated narrow-width wrap). Shape (adapt to the located cause):

```ts
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
// import the addon or TerminalView per the located cause

describe('wrapped URL link', () => {
  it('produces a single link spanning both rows for a URL that wraps', async () => {
    const term = new Terminal({ cols: 20, rows: 4 })
    // write a URL longer than 20 cols so it wraps, then assert the provider
    // returns one link whose range.start.y !== range.end.y.
    expect(true).toBe(true) // replace with the real assertion from Step 1's finding
  })
})
```

Run: `cd packages/terminal-client && bunx vitest run src/web-links-wrap.test.ts`
Expected: FAIL (reproduces the bug).

- [ ] **Step 3: Apply the fix at the located layer**

- If **(a) upstream addon bug:** patch it locally without reimplementing it:
  ```bash
  cd /home/user/src/other/podium/.claude/worktrees/clickable-files
  bun patch @xterm/addon-web-links
  # edit the extracted copy: fix the wrapped-range computation only
  bun patch --commit <extracted-dir>
  ```
  Then prepare an upstream PR against `xtermjs/xterm.js` with the same minimal fix (note the PR link in the commit message).
- If **(b) integration bug:** fix in `terminal-view.ts` (re-register the provider on remount/SIGWINCH, or correct the renderer/decoration interaction).
- If **(c) tap activation:** ensure the link range covers continuation-row cells (our `makeFileLinkProvider` already does; mirror the fix for URLs).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/terminal-client && bunx vitest run src/web-links-wrap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/terminal-client/src/web-links-wrap.test.ts packages/terminal-client/src/terminal-view.ts patches/ 2>/dev/null
git commit -m "terminal-client: fix wrapped (multiline) link activation [root cause: <a/b/c from Step 1>]"
```

---

## Phase 4 — Editing

### Task 14: Make the editor writable + save / conflict / dirty UX

**Files:**
- Modify: `apps/web/src/FileEditorPanel.tsx`

**Interfaces:**
- Consumes: `useStore().writeFile` (Task 5); `baseHash` from the read (Task 2/3).

- [ ] **Step 1: Write the dirty-state helper test**

Add to `apps/web/src/editor-lang.test.ts` (or a new `apps/web/src/editor-save.test.ts`) a pure test for the save-enablement rule:

```ts
import { describe, expect, it } from 'vitest'
import { canSave } from './editor-save'

describe('canSave', () => {
  it('is true only when editable, dirty, and not saving', () => {
    expect(canSave({ editable: true, dirty: true, saving: false })).toBe(true)
    expect(canSave({ editable: false, dirty: true, saving: false })).toBe(false)
    expect(canSave({ editable: true, dirty: false, saving: false })).toBe(false)
    expect(canSave({ editable: true, dirty: true, saving: true })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bunx vitest run src/editor-save.test.ts`
Expected: FAIL — `./editor-save` not found.

- [ ] **Step 3: Implement the helper**

Create `apps/web/src/editor-save.ts`:

```ts
export function canSave(s: { editable: boolean; dirty: boolean; saving: boolean }): boolean {
  return s.editable && s.dirty && !s.saving
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bunx vitest run src/editor-save.test.ts`
Expected: PASS.

- [ ] **Step 5: Make the panel editable + save**

In `apps/web/src/FileEditorPanel.tsx`:
- Track `baseHash` from the read result, a `dirty` flag (CodeMirror `EditorView.updateListener.of((u) => u.docChanged && setDirty(true))`), `saving`, and `editable` (= the file is inside the repo: open editable when the read succeeded for an in-cwd path; the read result doesn't say, so derive editability from whether `editorFile.path` resolves under the session cwd — pass `editable` from the opener, or treat all reads as editable and let `files.write` reject out-of-repo with an error toast).
- Replace `EditorView.editable.of(false)` with `EditorView.editable.of(editable)`.
- Add a Save button (enabled per `canSave`) and a ⌘/Ctrl-S keymap that calls:

```tsx
  const save = async () => {
    if (!editorFile || !viewRef.current) return
    setSaving(true)
    const content = viewRef.current.state.doc.toString()
    const r = await writeFile({ sessionId: editorFile.sessionId, path: editorFile.path, content, baseHash })
    setSaving(false)
    if (r.ok) {
      setBaseHash(r.baseHash)
      setDirty(false)
      toast.success('Saved')
    } else if (r.conflict) {
      toast.error('File changed on disk — reload or overwrite')
      // offer: reload (re-read) or overwrite (call writeFile without baseHash)
    } else {
      toast.error(r.error ?? 'Save failed')
    }
  }
```

(`toast` from `sonner`, already a dependency.) Add a dirty dot in the header and a confirm-on-close when `dirty`.

- [ ] **Step 6: Build**

Run: `cd apps/web && bunx tsc --noEmit && bun run build`
Expected: PASS.

- [ ] **Step 7: Manual verification (end-to-end)**

In a live session: open a repo file from a chat chip → edit → ⌘/Ctrl-S → toast "Saved" → reopen confirms the change persisted. Open an out-of-repo known file → it opens but Save is unavailable / write is rejected. Externally modify a file after opening, then save → conflict prompt appears.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/editor-save.ts apps/web/src/editor-save.test.ts apps/web/src/FileEditorPanel.tsx
git commit -m "web: editable FileEditorPanel with save, conflict detection, dirty guard"
```

---

## Final verification (after all tasks)

- [ ] Run the full suite: from worktree root `bun run --filter './packages/*' test` and each app's `bunx vitest run`.
- [ ] `cd apps/web && bun run build` (confirm CodeMirror is in a lazy chunk).
- [ ] Manual matrix: chat chip click; chat code-span click; native styled-path click; native **wrapped** path click on a narrow/mobile terminal; edit+save; conflict; out-of-repo read-only; binary/too-large states.
- [ ] Use `superpowers:requesting-code-review` before merge.

## Self-review against spec (completed during planning)

- **Spec coverage:** transport RPC → Tasks 1,3,4; sandbox → Task 2; editor panel → Tasks 6,14; openFile seam → Task 5; chat structured → Tasks 7,8; chat prose → Task 9; native provider → Tasks 10,11,12; multiline bug → Tasks 10,13; testing strategy → per-task tests + final matrix. All spec sections map to tasks.
- **Placeholder scan:** the only deliberately open item is Task 13's root-cause branch — unavoidable because the user asked to "figure out why"; it carries concrete diagnostic steps and three concrete fix paths, not a vague TODO.
- **Type consistency:** `FileReadResultMessage`/`FileWriteResultMessage` payloads (`Omit<…,'type'|'requestId'>`) are used identically in daemon (Task 2), relay (Task 3), and store (Task 5). `toolPaths` defined in Task 1 and consumed in Tasks 3,7,8,12. `resolveAgainstCwd` defined in Task 5, reused in Tasks 8,9 (web) and reimplemented intentionally in Task 11 (terminal-client can't import from apps/web). `FileLinkConfig` defined in Task 11, consumed in Task 12.
