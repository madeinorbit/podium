import { open, stat } from 'node:fs/promises'
import type { TranscriptItem } from '@podium/protocol'
import { decodeCursor, recordUuid, stampCursors } from './cursor-codec.js'
import type { ChainEntry } from './file-chain.js'
// Self-import so the bounded reader routes its file reads through the module's
// `readFileItems` export. Calling the export by namespace (not the local binding)
// keeps it interceptable by tests that spy on `readFileItems` to assert the
// bounded windows do NOT slurp whole files — a direct intra-module call would
// bypass the spy under ESM. See slice.test.ts "bounded window" perf test.
import * as self from './slice.js'

export interface SliceResult {
  items: TranscriptItem[]
  head?: string
  tail?: string
  hasMore: boolean
}

/** Parse a JSONL file into cursor-stamped items, in file order.
 *  Each line's byte offset is tracked so its items anchor to a stable position.
 *
 *  @param window Optional byte window `[start, end)` to read instead of the whole
 *    file. Offsets stamped on items are always FILE-ABSOLUTE (not window-relative),
 *    so cursors are stable regardless of how the window was sized. When `start > 0`
 *    the first line in the window is unconditionally dropped as a partial-record
 *    fragment (the read almost always begins mid-record). Callers that need the
 *    record at `start` MUST size the window to begin INSIDE or BEFORE the prior
 *    record — the established TAIL_BYTES rule — because a `start` landing exactly on
 *    a record boundary would silently lose that record. */
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
  // Items emit only at a `\n`, so a final line without a trailing newline is
  // intentionally dropped as a possible torn write (matches the live tail).
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

export interface SliceOptions {
  /** Cursor of the item to page relative to. Omit for the newest/oldest window. */
  anchor?: string
  /** `before` = the items immediately preceding the anchor (or the last `limit`
   *  when no anchor); `after` = the items immediately following it. */
  direction: 'before' | 'after'
  /** Maximum number of items to return. */
  limit: number
  /** TEST-ONLY seam: override the first bounded-read window size (bytes) so a test
   *  can shrink the doubling window and land its growing edge precisely between two
   *  records — needed to deterministically pin the strict-`>` `usable` invariant on
   *  the `after` path, which the default 256 KB window's overshoot otherwise masks.
   *  Defaults to `INITIAL_WINDOW_BYTES`; production callers never set it. Mirrors the
   *  existing `readFileItems` `window` and tailer `pollMs` test seams. */
  initialWindowBytes?: number
}

// First bounded-read window per file. A page is a small slice near a cursor, so a
// 256 KB window usually covers `limit + 1` records in one read; if a record is
// huge or the page sits far from any boundary, the window doubles until it does or
// it reaches the file edge. Keeps a page O(page size), not O(file size).
const INITIAL_WINDOW_BYTES = 256 * 1024

/**
 * Read a bounded slice of a session's transcript from its file chain.
 *
 * Items are the concatenation of the chain (oldest→newest) as produced by
 * `readFileItems`, each already cursor-stamped. `anchor` locates a position by
 * cursor; the anchor item itself is excluded from the result.
 *   - `before`: the `limit` items immediately preceding the anchor (or the last
 *     `limit` items when no anchor) — the scroll-to-top "load earlier" path.
 *   - `after`: the `limit` items immediately following the anchor — the "catch up
 *     newer" path.
 * `head`/`tail` are the cursors of the first/last returned items. `hasMore` is
 * whether any item exists beyond the returned window in `direction`.
 *
 * Anchor matching is exact (cursor string) first, then drift-tolerant: if the
 * encoded uuid changed under us but `{fileId, offset, sub}` still match, we still
 * anchor — the uuid is only a soft validator, the position is authoritative.
 *
 * PERF (bounded reads): this never slurps whole files on the live path. It reads
 * each chain file via bounded, doubling `readFileItems` windows seeded at the
 * anchor's byte offset, growing until the needed side holds `limit + 1` items or
 * the file boundary is reached, only then continuing into the adjacent chain file
 * (newest→oldest for `before`, oldest→newest for `after`). The result is
 * identical to reading the whole chain and slicing.
 */
export async function readTranscriptSlice(
  chain: ChainEntry[],
  recordToItems: (r: unknown) => TranscriptItem[],
  opts: SliceOptions,
): Promise<SliceResult> {
  if (chain.length === 0 || opts.limit <= 0) return { items: [], hasMore: false }

  const want = opts.anchor ? decodeCursor(opts.anchor) : null
  // Index of the chain file the anchor lives in. -1 when there is no anchor, the
  // cursor is undecodable, or its fileId is not in the chain (rolled away). In the
  // last two cases we fall back to the default window (newest for `before`, oldest
  // for `after`) — losing the position is safe and avoids a broken page.
  const anchorFileIdx = want ? chain.findIndex((e) => e.fileId === want.fileId) : -1
  const haveAnchor = anchorFileIdx >= 0
  const need = opts.limit + 1 // page + one extra to decide hasMore

  if (opts.direction === 'before') {
    // Walk newest→oldest, prepending each older file's contribution, until we hold
    // `need` items strictly before the anchor or we reach the chain head.
    const collected: TranscriptItem[] = []
    const startFileIdx = haveAnchor ? anchorFileIdx : chain.length - 1
    for (let fi = startFileIdx; fi >= 0; fi--) {
      const entry = chain[fi]
      if (!entry) continue
      const isAnchorFile = fi === anchorFileIdx
      const { items: fileItems } = await readFileWindowed(entry, recordToItems, {
        toward: 'older',
        anchorOffset: isAnchorFile && want ? want.offset : undefined,
        need: need - collected.length,
        initialWindowBytes: opts.initialWindowBytes,
      })
      const contribution = isAnchorFile
        ? sliceBeforeAnchor(fileItems, opts.anchor, want)
        : fileItems
      collected.unshift(...contribution)
      if (collected.length >= need) break
    }
    // Keep the last `limit` (closest to the anchor); anything earlier is overflow
    // we read only to decide hasMore.
    const start = Math.max(0, collected.length - opts.limit)
    const items = collected.slice(start)
    // hasMore is exactly `start > 0`: the overflow we already read sits before the
    // page. The only way `start === 0` is to have collected < `need` items, which
    // can only happen by exhausting the chain to its head (we stop early only once
    // we have `need`), so nothing earlier remains on disk either.
    return finalize(items, start > 0)
  }

  // direction === 'after': walk oldest→newest, appending each newer file's
  // contribution, until we hold `need` items strictly after the anchor or reach
  // the chain tail.
  const collected: TranscriptItem[] = []
  const startFileIdx = haveAnchor ? anchorFileIdx : 0
  for (let fi = startFileIdx; fi < chain.length; fi++) {
    const entry = chain[fi]
    if (!entry) continue
    const isAnchorFile = fi === anchorFileIdx
    const { items: fileItems } = await readFileWindowed(entry, recordToItems, {
      toward: 'newer',
      anchorOffset: isAnchorFile && want ? want.offset : undefined,
      need: need - collected.length,
      initialWindowBytes: opts.initialWindowBytes,
    })
    const contribution = isAnchorFile ? sliceAfterAnchor(fileItems, opts.anchor, want) : fileItems
    collected.push(...contribution)
    if (collected.length >= need) break
  }
  // Symmetric to `before`: hasMore iff we read overflow past the page. We stop early
  // only at `need = limit + 1`, so > limit collected ⇔ a later item exists.
  const items = collected.slice(0, opts.limit)
  return finalize(items, collected.length > opts.limit)
}

function finalize(items: TranscriptItem[], hasMore: boolean): SliceResult {
  return { items, head: items[0]?.cursor, tail: items.at(-1)?.cursor, hasMore }
}

interface WindowedResult {
  /** Items parsed from the bounded window, in file order. */
  items: TranscriptItem[]
  /** True when the window reached the relevant file edge (byte 0 for `older`,
   *  EOF for `newer`) — i.e. `items` is the file's complete head/tail run on the
   *  `toward` side and nothing earlier/later remains in THIS file. */
  atBoundary: boolean
}

/**
 * Read ONE chain file via bounded, doubling windows seeded near a byte offset.
 *
 *  - `toward: 'older'` — gather up to `need` items ending at/before `anchorOffset`
 *    (or the file's tail when no offset). The window ends at the anchor record's
 *    line and grows its START backward (doubling) until it holds `need` items or
 *    reaches byte 0.
 *  - `toward: 'newer'` — gather up to `need` items starting at/after `anchorOffset`
 *    (or the file's head when no offset). The window starts before the anchor
 *    record and grows its END forward (doubling) until it holds `need` items or
 *    reaches EOF.
 *
 * LEADING-PARTIAL OVER-READ: `readFileItems` unconditionally drops the first line
 * of any window that starts past byte 0 (it is assumed to be a torn prior record).
 * So to KEEP the record at byte O we must start the window STRICTLY BEFORE O — the
 * dropped line is then the record before O, never O itself. The `'newer'` path
 * seeds `start = O - 1 window` for exactly this reason; the `'older'` path's window
 * end already sits past O, and its growing start only ever drops a record OLDER
 * than what we keep (or reaches byte 0, where nothing is dropped).
 */
async function readFileWindowed(
  entry: ChainEntry,
  recordToItems: (r: unknown) => TranscriptItem[],
  opts: {
    toward: 'older' | 'newer'
    anchorOffset?: number
    need: number
    /** TEST-ONLY override of the first-window size; see SliceOptions. */
    initialWindowBytes?: number
  },
): Promise<WindowedResult> {
  let size: number
  try {
    size = (await stat(entry.path)).size
  } catch {
    return { items: [], atBoundary: true }
  }
  if (size === 0) return { items: [], atBoundary: true }

  const needed = Math.max(1, opts.need)
  const initialWindow = opts.initialWindowBytes ?? INITIAL_WINDOW_BYTES

  if (opts.toward === 'older') {
    // Window ends at the anchor record's start (no anchor → EOF), so it spans only
    // records STRICTLY BEFORE the anchor — the anchor's own line starts at exactly
    // `anchorOffset` and is excluded, and we never read the newer tail past it.
    // Grow START backward by doubling until we hold `need` whole records or hit
    // byte 0. (`readFileItems` only emits a record at its trailing `\n`, so an
    // `end` on a record boundary cleanly excludes the record starting there.)
    const end = opts.anchorOffset ?? size
    if (end === 0) return { items: [], atBoundary: true }
    let windowBytes = Math.min(end, initialWindow)
    for (;;) {
      const start = Math.max(0, end - windowBytes)
      const atBoundary = start === 0
      const items =
        start === 0 && end === size
          ? await self.readFileItems(entry.path, entry.fileId, recordToItems)
          : await self.readFileItems(entry.path, entry.fileId, recordToItems, { start, end })
      if (atBoundary || items.length >= needed) return { items, atBoundary }
      windowBytes = Math.min(end, windowBytes * 2)
    }
  }

  // toward === 'newer': window starts before the anchor record (so it survives the
  // leading-partial drop) or at byte 0 (no anchor → file head); grow END forward.
  const anchorOffset = opts.anchorOffset
  let windowBytes = Math.min(size, initialWindow)
  for (;;) {
    // Seed start strictly before the anchor record. With no anchor we read from 0.
    const start = anchorOffset === undefined ? 0 : Math.max(0, anchorOffset - 1)
    const end = Math.min(size, start + windowBytes)
    const atBoundary = end >= size
    const items =
      start === 0
        ? await self.readFileItems(entry.path, entry.fileId, recordToItems, { start: 0, end })
        : await self.readFileItems(entry.path, entry.fileId, recordToItems, { start, end })
    // Count only items STRICTLY AFTER the anchor — the anchor record (at exactly
    // `anchorOffset`) is excluded by `sliceAfterAnchor`, so counting it would let us
    // stop one item early and wrongly report hasMore=false. No anchor → all count.
    const usable =
      anchorOffset === undefined
        ? items.length
        : items.filter((it) => offsetOf(it) > anchorOffset).length
    if (atBoundary || usable >= needed) return { items, atBoundary }
    windowBytes = Math.min(size, windowBytes * 2)
  }
}

/** Decode an item's cursor to its record byte offset; -1 if missing/undecodable. */
function offsetOf(item: TranscriptItem): number {
  const c = item.cursor ? decodeCursor(item.cursor) : null
  return c ? c.offset : -1
}

/** Items strictly before the anchor within a single file's items. */
function sliceBeforeAnchor(
  items: TranscriptItem[],
  anchor: string | undefined,
  want: ReturnType<typeof decodeCursor>,
): TranscriptItem[] {
  if (!anchor) return items
  // Defensive safety net: on the bounded `before` path the `'older'` window ends at
  // `anchorOffset`, so the anchor record never appears in `items` and this lookup
  // returns -1 (→ keep all items, all of which are strictly older). The `slice(0,
  // idx)` branch only matters if a future/unbounded caller ever passes items that DO
  // include the anchor — then it still correctly trims the anchor and everything after.
  const idx = findAnchorIndex(items, anchor, want)
  return idx < 0 ? items : items.slice(0, idx)
}

/** Items strictly after the anchor within a single file's items. */
function sliceAfterAnchor(
  items: TranscriptItem[],
  anchor: string | undefined,
  want: ReturnType<typeof decodeCursor>,
): TranscriptItem[] {
  if (!anchor) return items
  const idx = findAnchorIndex(items, anchor, want)
  return idx < 0 ? items : items.slice(idx + 1)
}

function findAnchorIndex(
  items: TranscriptItem[],
  anchor: string,
  want: ReturnType<typeof decodeCursor>,
): number {
  const exact = items.findIndex((i) => i.cursor === anchor)
  if (exact >= 0) return exact
  if (!want) return -1
  // Drift-tolerant: match on file+offset+sub even if the uuid changed under us.
  return items.findIndex((i) => {
    const c = i.cursor ? decodeCursor(i.cursor) : null
    return c !== null && c.fileId === want.fileId && c.offset === want.offset && c.sub === want.sub
  })
}
