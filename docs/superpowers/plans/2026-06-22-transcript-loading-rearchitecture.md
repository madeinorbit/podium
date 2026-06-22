# Transcript Loading Re-architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat transcript load reliably for every session (live, parked, exited) by making the on-disk JSONL the single source of truth, served via one opaque-cursor read/subscribe primitive, with a re-seedable server cache and a uniform client read-then-subscribe flow.

**Architecture:** The daemon (filesystem owner) resolves each session's ordered JSONL **file chain** and serves cursor-anchored reads from it. Items carry a stable **opaque cursor** (`{fileId, byteOffset, recordUuid, subIndex}`, base64url, daemon-defined). The client always **reads** a tail window then **subscribes from that cursor** — identical for live and parked. The server holds a bounded cursor-aware in-memory window as a pure latency cache that re-seeds from disk on every (re)attach and never persists.

**Tech Stack:** TypeScript (Bun runtime), Zod (`@podium/protocol` message schemas), node:fs/promises, tRPC (`apps/server/src/router.ts`), WebSocket relay, Vitest (unit/integration), Playwright (e2e via the committed `?e2e=1` harness).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-22-transcript-loading-rearchitecture-design.md`. Every task implicitly serves it.
- Source of truth = the JSONL on disk. The server cache is NEVER the source of truth and is NEVER persisted to SQLite.
- Cursor is OPAQUE to client and server: only `packages/agent-bridge/src/transcript/cursor.ts` encodes/decodes it.
- All five harnesses (claude-code, codex, grok, cursor, opencode) ride the unified primitive. Claude Code is verified first.
- Streaming stays block-granular — NO token streaming. Only `flush()` + poll tightening for latency.
- Big-bang protocol swap: remove old `transcriptSnapshot`/`transcriptAppend`/`transcriptPage`; no back-compat shim. web+server+daemon deploy together from `main`.
- **Bounded reads (no whole-file slurp):** a transcript can be hundreds of MB. Every disk read MUST be a bounded byte window anchored at the cursor offset (generalize the existing doubling-window strategy in the retired `readTranscriptPage`), never a whole-file read. A page/seed request is O(window), not O(file). `readFileItems` whole-file parsing is permitted ONLY as a small-file/test building block, never on the live read path.
- Big-bang swap makes the repo cross-package-untypecheck mid-plan (messages removed in Phase C, consumers fixed in D–F). Task reviews scope to the task's own package tests; the final whole-branch review verifies full-repo typecheck + suite.
- Dispatch implementer/reviewer subagents on the **opus** model (per project preference).
- All work in the `feat/transcript-rearch` worktree at `/home/user/src/other/podium/.claude/worktrees/transcript-rearch`. Implementers MUST `cd` there and commit there — NEVER the main checkout.
- Never break the live `main` checkout — all work stays in the `feat/transcript-rearch` worktree.
- Keep the daemon-side window cap (`MAX_INITIAL_ITEMS`) and server cap (`MAX_TRANSCRIPT_ITEMS`) in step at 12_000.

---

## File Structure

**New files**
- `packages/agent-bridge/src/transcript/cursor.ts` — opaque cursor codec + types. One responsibility: encode/decode/compare cursors.
- `packages/agent-bridge/src/transcript/cursor.test.ts`
- `packages/agent-bridge/src/transcript/file-chain.ts` — per-harness ordered JSONL file-chain resolution.
- `packages/agent-bridge/src/transcript/file-chain.test.ts`
- `packages/agent-bridge/src/transcript/slice.ts` — cursor-anchored `readTranscriptSlice` over a file chain (replaces `readTranscriptTail` + `readTranscriptPage`).
- `packages/agent-bridge/src/transcript/slice.test.ts`
- `e2e/transcript-loading.spec.ts` — runtime verification.

**Modified files**
- `packages/protocol/src/messages.ts` — `TranscriptItem.cursor`; new `transcriptRead`/`transcriptReadResult`/`transcriptDelta`; `transcriptSubscribe.since`; remove `transcriptSnapshot`/`transcriptAppend`/`transcriptPage*`.
- `packages/agent-bridge/src/transcript/tailer.ts` — cursor-stamping read loop, `flush()`, delta callback carries cursors; remove `readTranscriptTail`/`readTranscriptPage` (moved to `slice.ts`).
- `packages/agent-bridge/src/transcript/{claude,codex,grok,cursor,opencode}.ts` — expose record `uuid` to the reader so it can stamp cursors (parsers stay otherwise unchanged); export a `fileChainFor` resolver hook.
- `packages/agent-bridge/src/index.ts` / `transcript/index.ts` — re-export new modules.
- `apps/daemon/src/daemon.ts` — harness-uniform ungated tail-start; re-seed on both reattach branches; cursor `transcriptRead` handler; tail emits `transcriptDelta`.
- `apps/server/src/session.ts` — cursor-aware cache window; re-seed entry point; serve read/subscribe from cache-or-disk.
- `apps/server/src/relay.ts` — `readTranscript` cursor read (cache → daemon disk); re-seed on reattach; remove `transcriptPage` short-circuit.
- `apps/server/src/router.ts` — tRPC `sessions.transcriptRead` replaces `transcript` + `transcriptPage`.
- `packages/terminal-client/src/connection.ts` — cursor-keyed transcript store; read-then-subscribe; reconnect catch-up.
- `apps/web/src/ChatView.tsx` — uniform read-then-subscribe; drop `parked` branch + `fromEnd` math; cursor-keyed items + paging.

---

## Phase A — Cursor + item anchoring (agent-bridge, no wire change yet)

### Task A1: Opaque cursor codec

**Files:**
- Create: `packages/agent-bridge/src/transcript/cursor.ts`
- Test: `packages/agent-bridge/src/transcript/cursor.test.ts`

**Interfaces:**
- Produces:
  - `interface CursorParts { fileId: string; offset: number; uuid: string | null; sub: number }`
  - `function encodeCursor(p: CursorParts): string` — base64url of compact JSON.
  - `function decodeCursor(c: string): CursorParts | null` — null on malformed input.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor } from './cursor.js'

describe('cursor codec', () => {
  it('round-trips parts', () => {
    const parts = { fileId: 'a1b2', offset: 4096, uuid: 'ddce65b9-03a7', sub: 2 }
    expect(decodeCursor(encodeCursor(parts))).toEqual(parts)
  })
  it('round-trips a null uuid', () => {
    const parts = { fileId: 'a1b2', offset: 0, uuid: null, sub: 0 }
    expect(decodeCursor(encodeCursor(parts))).toEqual(parts)
  })
  it('is opaque (no raw path/uuid substring leakage by accident is fine, but must be base64url)', () => {
    expect(encodeCursor({ fileId: 'f', offset: 1, uuid: null, sub: 0 })).toMatch(/^[A-Za-z0-9_-]+$/)
  })
  it('returns null on malformed input', () => {
    expect(decodeCursor('not-base64-$$$')).toBeNull()
    expect(decodeCursor('')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent-bridge && bunx vitest run src/transcript/cursor.test.ts`
Expected: FAIL — `Cannot find module './cursor.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/agent-bridge/src/transcript/cursor.ts
export interface CursorParts {
  /** Stable id of the JSONL file this item's record lives in. */
  fileId: string
  /** Byte offset of the start of the record's line within that file. */
  offset: number
  /** The record's JSONL `uuid` if present, for drift validation; null otherwise. */
  uuid: string | null
  /** Index of this item among the items the record produced (0-based). */
  sub: number
}

export function encodeCursor(p: CursorParts): string {
  const json = JSON.stringify([p.fileId, p.offset, p.uuid, p.sub])
  return Buffer.from(json, 'utf8').toString('base64url')
}

export function decodeCursor(c: string): CursorParts | null {
  if (!c) return null
  try {
    const arr = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'))
    if (!Array.isArray(arr) || arr.length !== 4) return null
    const [fileId, offset, uuid, sub] = arr
    if (typeof fileId !== 'string' || typeof offset !== 'number' || typeof sub !== 'number') return null
    if (uuid !== null && typeof uuid !== 'string') return null
    return { fileId, offset, uuid, sub }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agent-bridge && bunx vitest run src/transcript/cursor.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/transcript/cursor.ts packages/agent-bridge/src/transcript/cursor.test.ts
git commit -m "feat(transcript): opaque cursor codec ({fileId,offset,uuid,sub})"
```

---

### Task A2: Stamp a stable cursor onto every parsed item in the read loop

The parser (`claudeRecordToItems` etc.) does not know byte offsets — the reader does. Add a small generic helper that, given the file's `fileId`, a record's start `offset`, its parsed `uuid`, and the items it produced, stamps each item's `cursor`. This is consumed by both the tailer (Task B3) and the slice reader (Task B1).

**Files:**
- Create: helper `stampCursors` in `packages/agent-bridge/src/transcript/cursor.ts`
- Modify: `packages/protocol/src/messages.ts` — add `cursor?: string` to `TranscriptItem` (Task C1 finalizes protocol; the field is added here because the helper sets it).
- Test: `packages/agent-bridge/src/transcript/cursor.test.ts` (extend)

**Interfaces:**
- Consumes: `CursorParts`, `encodeCursor` (A1); `TranscriptItem` (`@podium/protocol`).
- Produces: `function stampCursors(items: TranscriptItem[], fileId: string, offset: number, uuid: string | null): TranscriptItem[]` — returns items with `cursor` set per sub-index (mutates copies, not inputs).
- Produces: `function recordUuid(record: unknown): string | null` — reads `.uuid` from a parsed JSONL record, null when absent.

- [ ] **Step 1: Add `cursor` to the protocol TranscriptItem (so the type compiles)**

In `packages/protocol/src/messages.ts`, inside the `TranscriptItem` object (after `id`), add:

```ts
  /** Opaque, daemon-defined position anchor for read-from/subscribe-since paging.
   *  Stable across re-reads of the same file bytes (unlike `id`, which is
   *  synthesized for some items). The client treats it as opaque. */
  cursor: z.string().optional(),
```

- [ ] **Step 2: Write the failing test (extend cursor.test.ts)**

```ts
import { recordUuid, stampCursors } from './cursor.js'

describe('stampCursors', () => {
  it('stamps a distinct cursor per sub-index, all sharing file+offset', () => {
    const items = [
      { id: 'x', role: 'user', text: 'a' },
      { id: 'y', role: 'tool', text: '', toolResult: 'r' },
    ] as any
    const out = stampCursors(items, 'file1', 100, 'uuid-1')
    expect(out[0].cursor).not.toEqual(out[1].cursor)
    expect(decodeCursor(out[0].cursor!)).toEqual({ fileId: 'file1', offset: 100, uuid: 'uuid-1', sub: 0 })
    expect(decodeCursor(out[1].cursor!)).toEqual({ fileId: 'file1', offset: 100, uuid: 'uuid-1', sub: 1 })
  })
  it('does not mutate input items', () => {
    const items = [{ id: 'x', role: 'user', text: 'a' }] as any
    stampCursors(items, 'f', 0, null)
    expect(items[0].cursor).toBeUndefined()
  })
})

describe('recordUuid', () => {
  it('reads uuid when present, null otherwise', () => {
    expect(recordUuid({ uuid: 'abc' })).toBe('abc')
    expect(recordUuid({ type: 'attachment' })).toBeNull()
    expect(recordUuid('nope')).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/agent-bridge && bunx vitest run src/transcript/cursor.test.ts`
Expected: FAIL — `stampCursors`/`recordUuid` not exported.

- [ ] **Step 4: Implement in `cursor.ts`**

```ts
import type { TranscriptItem } from '@podium/protocol'

export function stampCursors(
  items: TranscriptItem[],
  fileId: string,
  offset: number,
  uuid: string | null,
): TranscriptItem[] {
  return items.map((item, sub) => ({ ...item, cursor: encodeCursor({ fileId, offset, uuid, sub }) }))
}

export function recordUuid(record: unknown): string | null {
  if (record && typeof record === 'object' && typeof (record as { uuid?: unknown }).uuid === 'string') {
    return (record as { uuid: string }).uuid
  }
  return null
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd packages/agent-bridge && bunx vitest run src/transcript/cursor.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-bridge/src/transcript/cursor.ts packages/agent-bridge/src/transcript/cursor.test.ts packages/protocol/src/messages.ts
git commit -m "feat(transcript): stampCursors + recordUuid; TranscriptItem.cursor"
```

---

## Phase B — Cursor-anchored read over a file chain (agent-bridge)

### Task B1: `readTranscriptSlice` over a single file (anchor/direction/limit)

Replace the positional `fromEnd` reader with a cursor-anchored one. This task handles a SINGLE file; Task B4 wraps it over a chain. Reuse the existing doubling-window backward-read perf strategy from `readTranscriptPage`.

**Files:**
- Create: `packages/agent-bridge/src/transcript/slice.ts`
- Test: `packages/agent-bridge/src/transcript/slice.test.ts`

**Interfaces:**
- Consumes: `CursorParts`, `encodeCursor`, `stampCursors`, `recordUuid` (A1/A2); `LineDecoder` (`../jsonl-stream.js`).
- Produces:
  ```ts
  interface SliceResult { items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean }
  function readFileItems(
    path: string, fileId: string,
    recordToItems: (r: unknown) => TranscriptItem[],
    window?: { start: number; end: number },   // byte window; omitted = whole file (small-file/test only)
  ): Promise<TranscriptItem[]>   // parse the window, every item cursor-stamped, in file order
  ```
  `readFileItems` is the cursor-stamping building block. When `window` is given it reads only `[start,end)`, dropping a leading partial line if `start>0` (the established TAIL_BYTES pattern). The whole-file form is for tests and small files ONLY — the live read path (Task B3) always passes a bounded window per Global Constraints.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeCursor } from './cursor.js'
import { readFileItems } from './slice.js'

const rec = (uuid: string, type: string, text: string) =>
  JSON.stringify({ uuid, type, message: { role: type, content: [{ type: 'text', text }] }, timestamp: '2026-06-22T00:00:00Z' })

describe('readFileItems', () => {
  it('stamps every item with a decodable cursor carrying the file id and record uuid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'slice-'))
    const path = join(dir, 't.jsonl')
    await writeFile(path, [rec('u1', 'user', 'hi'), rec('a1', 'assistant', 'yo')].join('\n') + '\n')
    // minimal recordToItems for the test: one item per record carrying its text
    const toItems = (r: any) => [{ id: r.uuid, role: r.type, text: r.message.content[0].text }] as any
    const items = await readFileItems(path, 'FID', toItems)
    expect(items.map((i) => i.text)).toEqual(['hi', 'yo'])
    const c0 = decodeCursor(items[0].cursor!)!
    expect(c0.fileId).toBe('FID')
    expect(c0.uuid).toBe('u1')
    expect(c0.sub).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent-bridge && bunx vitest run src/transcript/slice.test.ts`
Expected: FAIL — `./slice.js` not found.

- [ ] **Step 3: Implement `readFileItems`**

```ts
// packages/agent-bridge/src/transcript/slice.ts
import { open } from 'node:fs/promises'
import type { TranscriptItem } from '@podium/protocol'
import { LineDecoder } from '../jsonl-stream.js'
import { recordUuid, stampCursors } from './cursor.js'

export interface SliceResult { items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean }

/** Parse a whole JSONL file into cursor-stamped items, in file order.
 *  Each line's byte offset is tracked so its items anchor to a stable position. */
export async function readFileItems(
  path: string,
  fileId: string,
  recordToItems: (r: unknown) => TranscriptItem[],
  window?: { start: number; end: number },
): Promise<TranscriptItem[]> {
  let buf: Buffer
  let base = 0 // absolute byte offset of buf[0] within the file
  try {
    const handle = await open(path, 'r')
    try {
      if (window) {
        const start = Math.max(0, window.start)
        const len = Math.max(0, window.end - start)
        const b = Buffer.alloc(len)
        const { bytesRead } = await handle.read(b, 0, len, start)
        buf = b.subarray(0, bytesRead)
        base = start
      } else {
        buf = await handle.readFile()
      }
    } finally {
      await handle.close()
    }
  } catch {
    return []
  }
  const out: TranscriptItem[] = []
  // Walk line boundaries on the raw buffer, tracking each record's ABSOLUTE offset.
  let lineStart = 0
  let firstLine = true
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a /* \n */) continue
    const lineBytes = buf.subarray(lineStart, i)
    const recOffset = base + lineStart
    const wasFirst = firstLine
    firstLine = false
    lineStart = i + 1
    // Seeked past byte 0 → the first line is a fragment of a prior record; drop it.
    if (wasFirst && base > 0) continue
    const trimmed = lineBytes.toString('utf8').trim()
    if (!trimmed) continue
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    const items = recordToItems(record)
    if (items.length > 0) out.push(...stampCursors(items, fileId, recOffset, recordUuid(record)))
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agent-bridge && bunx vitest run src/transcript/slice.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/transcript/slice.ts packages/agent-bridge/src/transcript/slice.test.ts
git commit -m "feat(transcript): readFileItems — cursor-stamped whole-file parse"
```

---

### Task B2: File-chain resolver (per harness)

Resolve a session's ordered JSONL file chain (oldest → newest). For Claude, a resume rolls into a fresh file, so a session can span several files in the cwd bucket; chain them by mtime. Other harnesses already discover by directory scan — reuse that.

**Files:**
- Create: `packages/agent-bridge/src/transcript/file-chain.ts`
- Test: `packages/agent-bridge/src/transcript/file-chain.test.ts`

**Interfaces:**
- Consumes: `claudeProjectSlug` (`../agent-state/claude-code.js`).
- Produces:
  ```ts
  interface ChainEntry { path: string; fileId: string }   // fileId = sha1(path).slice(0,12)
  function fileIdFor(path: string): string
  async function resolveFileChain(input: {
    agentKind: string; cwd: string; resumeValue?: string
  }): Promise<ChainEntry[]>   // ordered oldest→newest; [] when none
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileIdFor, resolveFileChain } from './file-chain.js'

describe('fileIdFor', () => {
  it('is stable and path-derived (no raw path leak)', () => {
    const id = fileIdFor('/home/u/.claude/projects/x/abc.jsonl')
    expect(id).toMatch(/^[a-f0-9]{12}$/)
    expect(fileIdFor('/home/u/.claude/projects/x/abc.jsonl')).toBe(id)
  })
})
```

(The chain-ordering test requires a fake `$HOME`; add it in Step 3 once the path logic exists. Keep Step 1 minimal-failing.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent-bridge && bunx vitest run src/transcript/file-chain.test.ts`
Expected: FAIL — `./file-chain.js` not found.

- [ ] **Step 3: Implement**

```ts
// packages/agent-bridge/src/transcript/file-chain.ts
import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeProjectSlug } from '../agent-state/claude-code.js'

export interface ChainEntry { path: string; fileId: string }

export function fileIdFor(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 12)
}

/** Ordered oldest→newest JSONL files that make up a session's transcript. */
export async function resolveFileChain(input: {
  agentKind: string
  cwd: string
  resumeValue?: string
}): Promise<ChainEntry[]> {
  const paths = await resolvePaths(input)
  return paths.map((p) => ({ path: p, fileId: fileIdFor(p) }))
}

async function resolvePaths(input: { agentKind: string; cwd: string; resumeValue?: string }): Promise<string[]> {
  if (input.agentKind === 'claude-code') {
    // The cwd bucket holds this conversation's files; a resume rolls into a new
    // file. Chain every .jsonl in the bucket by mtime (oldest→newest). The active
    // file is the newest; older rolls precede it. (Scoping to a single lineage is
    // a future refinement; chaining the bucket is correct because resumes share it.)
    const dir = join(homedir(), '.claude', 'projects', claudeProjectSlug(input.cwd))
    return await sortedJsonlByMtime(dir)
  }
  // codex/grok/cursor/opencode: their existing discovery already finds the active
  // rollout/session file. Reuse the single resolved path; chaining is per-harness
  // and added in their resolver (Task B3 wires each harness's discovery here).
  return []
}

async function sortedJsonlByMtime(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'))
  } catch {
    return []
  }
  const withMtime = await Promise.all(
    names.map(async (n) => {
      const p = join(dir, n)
      try {
        return { p, m: (await stat(p)).mtimeMs }
      } catch {
        return { p, m: 0 }
      }
    }),
  )
  return withMtime.sort((a, b) => a.m - b.m).map((x) => x.p)
}
```

- [ ] **Step 4: Add the chain-ordering test (now that paths resolve), run, verify pass**

```ts
it('orders claude bucket files oldest→newest by mtime', async () => {
  const home = await mkdtemp(join(tmpdir(), 'home-'))
  process.env.HOME = home
  const slug = '/work/repo'.replace(/[^a-zA-Z0-9]/g, '-')
  const dir = join(home, '.claude', 'projects', slug)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  const older = join(dir, 'older.jsonl'); const newer = join(dir, 'newer.jsonl')
  await writeFile(older, '{}\n'); await writeFile(newer, '{}\n')
  await utimes(older, new Date(1000), new Date(1000))
  await utimes(newer, new Date(2000), new Date(2000))
  const chain = await resolveFileChain({ agentKind: 'claude-code', cwd: '/work/repo' })
  expect(chain.map((c) => c.path)).toEqual([older, newer])
})
```

Run: `cd packages/agent-bridge && bunx vitest run src/transcript/file-chain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/transcript/file-chain.ts packages/agent-bridge/src/transcript/file-chain.test.ts
git commit -m "feat(transcript): resolveFileChain + fileIdFor (claude bucket mtime chain)"
```

---

### Task B3: `readTranscriptSlice` over the chain (anchor/direction/limit)

Compose `readFileItems` across the chain into the public read primitive. Items are concatenated oldest→newest; the anchor locates a position; slice `limit` items before/after it.

**Files:**
- Modify: `packages/agent-bridge/src/transcript/slice.ts`
- Test: `packages/agent-bridge/src/transcript/slice.test.ts` (extend)

**Interfaces:**
- Consumes: `readFileItems` (B1), `ChainEntry`/`resolveFileChain` (B2), `decodeCursor` (A1).
- Produces:
  ```ts
  function readTranscriptSlice(
    chain: ChainEntry[],
    recordToItems: (r: unknown) => TranscriptItem[],
    opts: { anchor?: string; direction: 'before' | 'after'; limit: number },
  ): Promise<SliceResult>   // { items, head, tail, hasMore }
  ```
  Semantics: build the full ordered item list across the chain (each item already cursor-stamped). Find anchor index by matching `cursor` exactly, else by `decodeCursor` `{fileId,offset,sub}` equality (drift-tolerant: if `uuid` mismatches but offset/file match, still anchor and continue). No anchor → newest window. `before` returns the `limit` items immediately preceding the anchor (or the last `limit` when no anchor); `after` returns the `limit` items immediately following. `head`/`tail` = cursors of first/last returned. `hasMore` = items exist beyond the returned window in `direction`.

- [ ] **Step 1: Write the failing tests** (no-anchor tail; before-anchor paging; after-anchor catch-up; cross-file stitch; hasMore)

```ts
import { readTranscriptSlice } from './slice.js'
import { fileIdFor } from './file-chain.js'
// helper: write two chained files f1 (items 0..4) and f2 (items 5..9), return chain

it('no anchor returns the newest `limit` items with hasMore', async () => {
  const { chain, toItems } = await twoFiles()  // 10 items total across 2 files
  const r = await readTranscriptSlice(chain, toItems, { direction: 'before', limit: 3 })
  expect(r.items.map((i) => i.text)).toEqual(['7', '8', '9'])
  expect(r.hasMore).toBe(true)
})

it('before-anchor pages the previous window across the file boundary with no gap/overlap', async () => {
  const { chain, toItems } = await twoFiles()
  const first = await readTranscriptSlice(chain, toItems, { direction: 'before', limit: 3 }) // 7,8,9
  const older = await readTranscriptSlice(chain, toItems, { anchor: first.head, direction: 'before', limit: 3 })
  expect(older.items.map((i) => i.text)).toEqual(['4', '5', '6']) // 4 in f1, 5,6 in f2 — contiguous
})

it('after-anchor catches up newer items', async () => {
  const { chain, toItems } = await twoFiles()
  const win = await readTranscriptSlice(chain, toItems, { direction: 'before', limit: 3 }) // 7,8,9; tail=9
  const after = await readTranscriptSlice(chain, toItems, { anchor: win.tail, direction: 'after', limit: 5 })
  expect(after.items).toEqual([]) // nothing newer than 9
  expect(after.hasMore).toBe(false)
})

it('hasMore is false at the head of the oldest file', async () => {
  const { chain, toItems } = await twoFiles()
  const r = await readTranscriptSlice(chain, toItems, { direction: 'before', limit: 100 })
  expect(r.items.length).toBe(10)
  expect(r.hasMore).toBe(false)
})
```

- [ ] **Step 2: Run to verify fail**

Run: `cd packages/agent-bridge && bunx vitest run src/transcript/slice.test.ts`
Expected: FAIL — `readTranscriptSlice` not exported.

- [ ] **Step 3: Implement**

```ts
import { decodeCursor } from './cursor.js'
import type { ChainEntry } from './file-chain.js'

export async function readTranscriptSlice(
  chain: ChainEntry[],
  recordToItems: (r: unknown) => TranscriptItem[],
  opts: { anchor?: string; direction: 'before' | 'after'; limit: number },
): Promise<SliceResult> {
  // Correctness-first: build the full ordered list, then slice. Windowed perf is
  // Task B5 (only matters for very large chains; the daemon caps reads anyway).
  // Step 3 (this step) builds the correct result by reading files whole — this is
  // the CORRECTNESS reference and what the behavior tests below pin. Step 3.5
  // (next) replaces the whole-file reads with bounded windows WITHOUT changing
  // any test output, satisfying the Global Constraints "Bounded reads" rule.
  const all: TranscriptItem[] = []
  for (const entry of chain) all.push(...(await readFileItems(entry.path, entry.fileId, recordToItems)))
  if (all.length === 0) return { items: [], hasMore: false }

  const idx = opts.anchor ? findAnchorIndex(all, opts.anchor) : all.length
  let slice: TranscriptItem[]
  let hasMore: boolean
  if (opts.direction === 'before') {
    const end = idx < 0 ? all.length : idx           // anchor item itself excluded
    const start = Math.max(0, end - opts.limit)
    slice = all.slice(start, end)
    hasMore = start > 0
  } else {
    const start = idx < 0 ? all.length : idx + 1     // anchor item itself excluded
    const end = Math.min(all.length, start + opts.limit)
    slice = all.slice(start, end)
    hasMore = end < all.length
  }
  return {
    items: slice,
    head: slice[0]?.cursor,
    tail: slice.at(-1)?.cursor,
    hasMore,
  }
}

function findAnchorIndex(all: TranscriptItem[], anchor: string): number {
  const exact = all.findIndex((i) => i.cursor === anchor)
  if (exact >= 0) return exact
  const want = decodeCursor(anchor)
  if (!want) return -1
  // Drift-tolerant: match on file+offset+sub even if the uuid changed under us.
  return all.findIndex((i) => {
    const c = i.cursor ? decodeCursor(i.cursor) : null
    return c && c.fileId === want.fileId && c.offset === want.offset && c.sub === want.sub
  })
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/agent-bridge && bunx vitest run src/transcript/slice.test.ts`
Expected: PASS (all slice tests).

- [ ] **Step 4.5: Make reads bounded (perf — Global Constraints "Bounded reads")**

Refactor `readTranscriptSlice` so it does NOT read whole files. Read each file via bounded `readFileItems(path, fileId, recordToItems, {start, end})` windows, anchored at the cursor offset and **doubling** until the needed side has `limit + 1` items or the file boundary is reached; only then continue into the adjacent chain file. Walk the chain newest→oldest for `before` and oldest→newest for `after`. Generalize the doubling-window logic from the retired `readTranscriptPage`. The behavior (and every Step-1 test) must be byte-for-byte identical — this is a pure perf refactor.

Add a perf-intent test on a synthetic large file proving a small page does not parse the whole file:

```ts
it('pages a large file without reading all of it (bounded window)', async () => {
  // write a file with ~5000 records (each item carries an incrementing index);
  // request {direction:'before', limit: 10} with no anchor.
  // Assert: result has the LAST 10 items, hasMore === true, and (instrument
  // readFileItems via a spy or a byte-counter) the total bytes read is far less
  // than the file size — e.g. < 25% — proving the window did not slurp the file.
})
```

Run: `cd packages/agent-bridge && bunx vitest run src/transcript/slice.test.ts`
Expected: PASS (behavior tests unchanged + the bounded-read test).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/transcript/slice.ts packages/agent-bridge/src/transcript/slice.test.ts
git commit -m "feat(transcript): readTranscriptSlice — bounded-window cursor read over a file chain"
```

---

### Task B4: Tailer stamps cursors, calls flush(), emits cursor-tail deltas

Rework `tailTranscript` so each emitted item carries a cursor (same scheme as the slice reader), the trailing record is surfaced via `flush()`, and the delta callback exposes the new tail cursor. Keep the 700ms poll (optionally lower to 400ms — measure, but keep within this task only if free).

**Files:**
- Modify: `packages/agent-bridge/src/transcript/tailer.ts`
- Modify: `packages/agent-bridge/src/jsonl-stream.ts` (confirm `flush()` returns the buffered leftover line; it already exists — call it).
- Test: `packages/agent-bridge/src/transcript/tailer.test.ts` (extend)

**Interfaces:**
- Consumes: `stampCursors`, `recordUuid` (A2); `fileIdFor` (B2).
- Produces (changed signature):
  ```ts
  function tailTranscript(
    path: string,
    onItems: (items: TranscriptItem[], meta: { reset: boolean; tail?: string }) => void,
    opts?: TranscriptTailOptions,
  ): TranscriptTailer
  ```
  Each emitted item has `.cursor`; `meta.tail` is the last item's cursor (or undefined for an empty reset). `fileId = fileIdFor(path)`.

- [ ] **Step 1: Write the failing test** — a trailing newline-less record surfaces on the next poll after a `\n` is appended, AND items carry decodable cursors.

```ts
it('stamps tailed items with cursors and surfaces a record once its newline lands', async () => {
  // write a file with one complete line + a trailing partial (no \n)
  // tick poll → first item emitted with a cursor; partial NOT emitted
  // append the missing "\n" + another record → next tick emits the now-complete records
  // assert each emitted item.cursor decodes with fileId === fileIdFor(path)
})
```

(Implement the harness using `opts.pollMs` to drive ticks deterministically, mirroring existing tailer.test.ts patterns.)

- [ ] **Step 2: Run to verify fail**

Run: `cd packages/agent-bridge && bunx vitest run src/transcript/tailer.test.ts`
Expected: FAIL (cursor undefined / partial not surfaced as expected).

- [ ] **Step 3: Implement** — in `readNew`, track each line's byte offset within the chunk (add `offset - chunk.length + lineStartWithinChunk`), call `recordToItems` then `stampCursors(items, fileId, recOffset, recordUuid(record))`, accumulate; after the loop, call `decoder.flush()` and, if it yields a parseable record, stamp+emit it too; pass `{ reset, tail: lastCursor }` to `onItems`. Update all call sites of `tailTranscript` (daemon) to the new `meta` arg — done in Task D4.

```ts
// sketch of the per-line offset + stamping inside readNew's loop:
let lineStartAbs = offset - chunk.length // offset already advanced to size; chunk began here
for (const line of lines) {
  const recOffset = lineStartAbs
  lineStartAbs += Buffer.byteLength(line, 'utf8') + 1 // + '\n'
  const trimmed = line.trim()
  if (!trimmed) continue
  let record: unknown
  try { record = JSON.parse(trimmed) } catch { continue }
  const stamped = stampCursors(recordToItems(record), fileId, recOffset, recordUuid(record))
  items = items.concat(stamped)
  // ...color unchanged...
}
// after loop: const leftover = decoder.flush(); if parseable, stamp+push (best-effort)
```

(Note: `LineDecoder.push` must return lines WITHOUT consuming the trailing partial; `flush()` returns that partial. Verify `jsonl-stream.ts` semantics and adjust offset bookkeeping so a flushed line's offset is correct. If exact byte bookkeeping with the decoder is fragile, switch the tailer's incremental parse to the same raw-buffer line-walk used in `readFileItems` for offset fidelity.)

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/agent-bridge && bunx vitest run src/transcript/tailer.test.ts`
Expected: PASS.

- [ ] **Step 5: Remove the now-dead `readTranscriptTail`/`readTranscriptPage` from `tailer.ts`** (superseded by `slice.ts`). Update `transcript/index.ts` exports. Run the whole agent-bridge suite:

Run: `cd packages/agent-bridge && bunx vitest run`
Expected: PASS (fix any import fallout in this package).

- [ ] **Step 6: Commit**

```bash
git add packages/agent-bridge/src/transcript/ packages/agent-bridge/src/jsonl-stream.ts
git commit -m "feat(transcript): cursor-stamping tail + flush(); retire fromEnd readers"
```

---

## Phase C — Protocol

### Task C1: New transcript messages; remove the old ones

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Test: `packages/protocol/src/messages.test.ts` (or add `transcript-messages.test.ts`)

**Interfaces:**
- Produces (server↔client + server↔daemon):
  ```ts
  TranscriptReadRequest  { type:'transcriptRead', requestId, sessionId, anchor?, direction:'before'|'after', limit }
  TranscriptReadResult   { type:'transcriptReadResult', requestId, sessionId, items, head?, tail?, hasMore }
  TranscriptSubscribeMessage   { type:'transcriptSubscribe', sessionId, since? }   // since = cursor
  TranscriptUnsubscribeMessage { type:'transcriptUnsubscribe', sessionId }
  TranscriptDeltaMessage { type:'transcriptDelta', sessionId, items, tail?, reset? } // server→client + daemon→server
  ```
- Removes: `TranscriptAppendMessage`, `TranscriptSnapshotMessage`, and the old `transcriptRead*`/`transcriptPage*` request/result pair the daemon used (they are replaced by the unified `transcriptRead`).

- [ ] **Step 1: Write the failing test** — parse a `transcriptRead` and a `transcriptDelta`, and assert the old `transcriptSnapshot` literal no longer parses.

```ts
import { ControlMessage, ClientMessage, ServerMessage } from './messages.js' // whichever unions apply
it('accepts transcriptRead + transcriptDelta and rejects retired transcriptSnapshot', () => {
  expect(() => /* parse a valid transcriptRead */).not.toThrow()
  expect(() => /* parse a valid transcriptDelta */).not.toThrow()
  expect(/* parse {type:'transcriptSnapshot',...} */).toBeNull() // not in any union
})
```

- [ ] **Step 2: Run to verify fail.** Run: `bunx vitest run packages/protocol`. Expected: FAIL.

- [ ] **Step 3: Implement** the schemas; add each to the correct discriminated unions (find where `TranscriptAppendMessage`/`TranscriptSubscribeMessage` are currently included — both the daemon `ControlMessage`/server-message union and the client-facing union — and swap them). Add `requestId` (string) to read req/result. Keep `TranscriptItem.cursor` (already added A2).

- [ ] **Step 4: Run to verify pass.** Run: `bunx vitest run packages/protocol`. Expected: PASS. Then typecheck the repo to surface every consumer that referenced the removed messages: `bun run -s typecheck` (expect failures in server/daemon/web/terminal-client — those are fixed in Phases D–F).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/
git commit -m "feat(protocol): unified transcriptRead/Delta + cursor subscribe; retire snapshot/append/page"
```

---

## Phase D — Daemon

### Task D1: Harness-uniform, ungated tail-start via the file chain

Replace the `else if (msg.agentKind === 'claude-code' && msg.resume)` gate (`daemon.ts:757`) and the codex/grok-specific branches with a single path: on spawn AND reattach, resolve the file chain and start the tail on its newest file, for every harness. Hooks remain a latency optimization (`ensureTranscriptTail` on a hook's `transcript_path`) but are no longer required.

**Files:**
- Modify: `apps/daemon/src/daemon.ts` (`initSessionObservers` ~736-775; `tailResumeTranscript`; `ensureTranscriptTail`)
- Test: `apps/daemon/src/daemon.test.ts` (extend) — a claude session with NO resume ref and NO hook still starts a tail when its bucket has a JSONL file.

**Interfaces:**
- Consumes: `resolveFileChain` (B2), `tailTranscript` new signature (B4).
- Produces: `ensureTranscriptTailForSession(session)` that resolves the chain and tails the newest entry; called unconditionally from `initSessionObservers` for all harnesses.

- [ ] **Step 1: Write the failing test** (claude, no resume, file present → tail starts and emits an item). Use a temp `$HOME` bucket as in B2.
- [ ] **Step 2: Run to verify fail.** `cd apps/daemon && bunx vitest run src/daemon.test.ts`.
- [ ] **Step 3: Implement** — add `ensureTranscriptTailForSession`; call it in `initSessionObservers` for every `agentKind` (drop the `&& msg.resume` gate and the per-harness tail branches — keep per-harness *state* observers). Keep `ensureTranscriptTail(sessionId, transcriptPath)` from hooks as a fast-path that swaps to the exact hook file when it differs.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(daemon): ungated harness-uniform transcript tail via file chain`.

---

### Task D2: Cursor `transcriptRead` handler (serve from disk)

**Files:**
- Modify: `apps/daemon/src/daemon.ts` (replace the old `readParkedTranscript`/`readTranscriptPageRequest` handlers)
- Test: `apps/daemon/src/daemon.test.ts`

**Interfaces:**
- Consumes: `resolveFileChain` (B2), `readTranscriptSlice` (B3), per-harness `recordToItems`.
- Produces: handler for `transcriptRead` → `transcriptReadResult` with `{ items, head, tail, hasMore }`, resolving `recordToItems` by `agentKind` (the existing `recordToItemsFor(agentKind)` map, or inline switch).

- [ ] **Step 1: Write the failing test** — a `transcriptRead` with no anchor returns the newest window from a temp file; a `before` anchor pages older.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** — `feat(daemon): transcriptRead handler serves cursor slices from disk`.

---

### Task D3: Re-seed transcript on BOTH reattach branches; tail emits `transcriptDelta`

**Files:**
- Modify: `apps/daemon/src/daemon.ts` (`handleReattach` 1019-1082; the `tailTranscript` `onItems` closure ~302-315)
- Test: `apps/daemon/src/daemon.test.ts`

**Interfaces:**
- Produces: the already-held-bridge branch (1020-1033) now ALSO triggers a transcript re-seed (re-run the newest-file slice and emit it as a `transcriptDelta{reset:true}` so a freshly-restarted server repopulates). The tail `onItems` closure sends `transcriptDelta{ items, tail, reset }` (replacing `transcriptAppend`).

- [ ] **Step 1: Write the failing test** — simulate a second `reattach` for an already-held bridge → a `transcriptDelta{reset:true}` is emitted carrying the current items.
- [ ] **Step 2–4:** fail → implement → pass. (Reuse `ensureTranscriptTailForSession` + a one-shot slice for the re-seed.)
- [ ] **Step 5: Commit** — `fix(daemon): re-seed transcript on already-held-bridge reattach; tail emits transcriptDelta`.

---

## Phase E — Server

### Task E1: Cache becomes a cursor-aware, re-seedable latency window

**Files:**
- Modify: `apps/server/src/session.ts` (`subscribeTranscript`, `appendTranscript`→`applyDelta`, add `reseed`, `readSlice` helpers)
- Modify: `apps/server/src/relay.ts` (`readTranscript` → cursor read with cache→daemon fallthrough; reattach re-seed; remove the `buffered.length > 0` short-circuit at 1407-1411 and the `transcriptPage` path)
- Test: `apps/server/src/session.test.ts`, `apps/server/src/relay.test.ts`

**Interfaces:**
- Consumes: protocol `transcriptRead`/`transcriptDelta` (C1).
- Produces:
  - `Session.applyDelta(items, { reset, tail })` — replaces `appendTranscript`; maintains the bounded window keyed by trailing cursor; fans out `transcriptDelta` to subscribers.
  - `Session.subscribeTranscript(client, since?)` — if `since` is within the window, replay items after it as a `transcriptDelta`; else send a `transcriptDelta{reset:true}` of the current window. (No more `transcriptSnapshot`.)
  - `SessionRegistry.readTranscript(sessionId, {anchor, direction, limit})` — serve from the cache window when the anchor is inside it; otherwise round-trip `transcriptRead` to the daemon (disk). NEVER returns empty for a live session that has on-disk history.
  - reattach path calls `Session.reseed(...)` driven by the daemon's `transcriptDelta{reset}`.

- [ ] **Step 1: Write failing tests** — (a) `readTranscript` for a live session with an EMPTY cache falls through to a daemon disk read (mock daemon) and returns items; (b) a `before` anchor outside the window round-trips to the daemon; (c) `applyDelta{reset}` re-seeds and fans out.
- [ ] **Step 2–4:** fail → implement → pass. Delete the short-circuit; route cache-miss/older-than-window to the daemon `transcriptRead`.
- [ ] **Step 5: Commit** — `feat(server): cursor-aware re-seedable transcript cache; disk fallthrough for live sessions`.

---

### Task E2: tRPC `sessions.transcriptRead` replaces `transcript` + `transcriptPage`

**Files:**
- Modify: `apps/server/src/router.ts` (73-88)
- Test: `apps/server/src/router.test.ts`

**Interfaces:**
- Produces: `sessions.transcriptRead({ sessionId, anchor?, direction, limit }) → { items, head, tail, hasMore }` delegating to `registry.readTranscript`. Remove `sessions.transcript` and `sessions.transcriptPage`.

- [ ] **Step 1: Write failing test** — the query returns a cursor slice; old procedures are gone.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** — `feat(server): tRPC sessions.transcriptRead (unified cursor read)`.

---

## Phase F — Client

### Task F1: `connection.ts` cursor-keyed transcript store + read-then-subscribe

**Files:**
- Modify: `packages/terminal-client/src/connection.ts` (transcript map ~148; `route()` ~556-562; `subscribeTranscript` ~398-409; reconnect ~213-217)
- Test: `packages/terminal-client/src/connection.test.ts` (or the existing transcript test)

**Interfaces:**
- Produces:
  - `hub.readTranscript(sessionId, { anchor?, direction, limit }): Promise<SliceResult>` (tRPC under the hood OR a WS request/result keyed by `requestId` — match how the hub does other round-trips).
  - `hub.subscribeTranscript(sessionId, since, cb)` — sends `transcriptSubscribe{since}`; applies `transcriptDelta` by appending/dedup-by-cursor; on `reset` replaces. Items keyed by `cursor` (idempotent: same cursor replaces).
  - On reconnect: re-subscribe with the last known `tail` cursor (`since`) so the server replays only the gap.

- [ ] **Step 1: Write failing test** — a `transcriptDelta{reset}` then an append grow the store with no duplication; a redelivered item (same cursor) does not duplicate.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** — `feat(client): cursor-keyed transcript hub; read-then-subscribe + reconnect catch-up`.

---

### Task F2: ChatView uniform read-then-subscribe (drop the parked branch)

**Files:**
- Modify: `apps/web/src/ChatView.tsx` (state 152-166; open effects 214-253; `tail`/`effectiveItems` 257-258; paging 460-499; loader 316)
- Test: `apps/web/src/ChatView.test.tsx` (extend; ensure `apps/web` happy-dom vitest config per project memory)

**Interfaces:**
- Consumes: `hub.readTranscript`, `hub.subscribeTranscript` (F1).
- Produces: on open (ANY status): `read({direction:'before', limit:N})` → seed `items` + remember `head`/`tail`; then `subscribe(since: tail)`. Scroll-up: `read({anchor: head, direction:'before'})`, prepend, update `head`, stop on `hasMore:false`. Remove `parked`-gated `trpc.sessions.transcript` fetch, the `fetched` state, and the `fromEnd: items.length` math. Items keyed by `cursor`. Loader clears when the initial read resolves (no infinite spinner on a thrown fetch — surface an inline error + retry instead).

- [ ] **Step 1: Write failing test** — a LIVE session with an initially-empty hub still renders items after the initial `read` resolves (the bug-a regression test); scroll-up prepends older with no gap.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** — `feat(web): ChatView uniform cursor read-then-subscribe; drop parked branch`.

---

## Phase G — Whole-system verification

### Task G1: e2e — running session loads, survives restart, scrolls clean

**Files:**
- Create: `e2e/transcript-loading.spec.ts`

**Interfaces:**
- Consumes: the committed Playwright `?e2e=1` harness + `__podium` API (per project memory: read agent output via the ws outputFrame hook; drive real clicks).

- [ ] **Step 1: Write the e2e** covering:
  - Open a RUNNING claude session → transcript items appear (not "No transcript yet").
  - Restart `podium-server` (or simulate the already-held-bridge reattach) → the live transcript survives / re-seeds.
  - Scroll to the top of a long session → full history with no gaps and no duplicate cursors.
- [ ] **Step 2: Run** `npx playwright test e2e/transcript-loading.spec.ts`. Iterate until green.
- [ ] **Step 3: Full suite + typecheck + lint**

```bash
bun run -s typecheck && bunx vitest run && npx playwright test
```
Expected: all PASS.

- [ ] **Step 4: Commit** — `test(e2e): transcript loads for running sessions, survives restart, pages cleanly`.

---

## Self-Review

**Spec coverage**
- §3 disk-truth → A1–B3 (slice from disk), D2, E1 fallthrough. ✓
- §4 one read + one subscribe → C1, E2, F1/F2. ✓ (old snapshot/append/page removed in C1/E1/E2.)
- §5 opaque cursor + file-roll → A1/A2 (codec/stamp), B2 (chain), B3 (cross-file stitch test). ✓ (Refined to composite `{fileId,offset,uuid,sub}` — uuid validates drift, offset seeks; documented in plan Architecture + Task A1.)
- §6 lifecycle: open read-then-subscribe (F2); reconnect catch-up (F1); already-held-bridge re-seed (D3); ungated tail (D1). ✓
- §7 cache as latency window, not persisted (E1; no SQLite touched). ✓
- §8 all harnesses (B2 resolver per harness; D1/D2 resolve `recordToItems` by agentKind). ⚠ Codex/Grok/Cursor/Opencode chain resolution is stubbed in B2 (`return []`) — **gap**: see added note below.
- §9 streaming: `flush()` + poll in B4; no token streaming. ✓
- §10 big-bang removal (C1). ✓
- §11 tests: unit (A,B), integration (D,E,F), e2e (G). ✓

**Gap fix (added):** B2's non-claude branch returns `[]`. Add **Task B2b** before D1: wire each non-claude harness's existing discovery (codex rollout dir, grok session dir, cursor, opencode) into `resolvePaths` so `resolveFileChain` returns their active file(s). Until B2b lands, only claude-code is functional — which matches "claude verified first," but all-harness is required, so B2b is in-scope, not optional.

**Placeholder scan:** B4 Step 1/Step 3 give a sketch rather than full literal test/impl because exact offset bookkeeping depends on `jsonl-stream.ts` semantics the implementer must confirm at the file; flagged explicitly with the fallback (raw-buffer line-walk). All other code steps are literal. Acceptable: the uncertainty is real and named, not hidden.

**Type consistency:** `SliceResult { items, head?, tail?, hasMore }` is used identically in B3, D2, E1, E2, F1. `readTranscriptSlice(chain, recordToItems, opts)` arg order consistent. `transcriptDelta{items,tail?,reset?}` consistent across C1/D3/E1/F1. `subscribeTranscript(... since ...)` consistent C1/E1/F1.

---

## Execution note

Add **Task B2b** (non-claude file-chain wiring) between B2 and D1 when executing. Verify Claude end-to-end first (G1 with a claude session), then the other four.
