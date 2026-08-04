import { statSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type { TranscriptItem } from '@podium/model'
import { decodeCursor, recordUuid, stampCursors } from './cursor-codec'
import type { ChainEntry } from './file-chain'
// Self-import so the bounded reader routes its file reads through the module's
// `readFileItems` export. Calling the export by namespace (not the local binding)
// keeps it interceptable by tests that spy on `readFileItems` to assert the
// bounded windows do NOT slurp whole files — a direct intra-module call would
// bypass the spy under ESM. See slice.test.ts "bounded window" perf test.
import * as self from './slice'

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
  // True when `buf` extends to the file's end — only then is a final line without a
  // trailing newline a real (in-flight) record rather than a window-edge fragment.
  let atEof = true // a whole-file read always reaches EOF
  try {
    const handle = await open(path, 'r')
    try {
      if (window) {
        const { size } = await handle.stat()
        const start = Math.max(0, window.start)
        const len = Math.max(0, window.end - start)
        const b = Buffer.alloc(len)
        const { bytesRead } = await handle.read(b, 0, len, start)
        buf = b.subarray(0, bytesRead)
        base = start
        atEof = base + buf.length >= size
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
  // Parse one line's bytes into stamped items at an absolute offset; skip blank/torn.
  const emit = (lineBytes: Buffer, recOffset: number): void => {
    const trimmed = lineBytes.toString('utf8').trim()
    if (!trimmed) return
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      return
    }
    const items = recordToItems(record)
    if (items.length > 0) out.push(...stampCursors(items, fileId, recOffset, recordUuid(record)))
  }
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
    emit(lineBytes, recOffset)
  }
  // Trailing record without its terminating newline yet. Flush it (best-effort) ONLY
  // at EOF and when it begins at a real boundary — a newline was seen (lineStart > 0)
  // or the window started at byte 0. This MATCHES the live tailer, which flushes the
  // same record at the same cursor, so a reset-driven disk re-read no longer drops a
  // message the tail already showed. A non-EOF window's trailing bytes are a fragment
  // continued on disk, and a leading partial (base > 0, no newline) is a prior
  // record's tail — neither is emitted.
  if (atEof && lineStart < buf.length && (lineStart > 0 || base === 0)) {
    emit(buf.subarray(lineStart), base + lineStart)
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
 * EXTENDING, NOT RE-READING (POD-1627): each doubling reads only the region the
 * previous window did NOT cover, and splices onto the items already parsed. The
 * naive form — re-reading `[end - 2w, end)` from scratch each round — read and
 * `JSON.parse`d ~2.37x the bytes the FINAL window spans (measured: a 97.6MB
 * transcript cost 231.5MB of read+parse to return a 0.5MB page). The seam is
 * placed on a RECORD boundary so the splice cannot duplicate or lose a record:
 *   - `older`: the new read ends at the first KEPT record's offset. A record whose
 *     terminating `\n` sits before that offset is emitted by the new read; the one
 *     starting exactly there is already held. `readFileItems`' end-exclusive
 *     boundary (a record is emitted at its trailing `\n`) makes this exact.
 *   - `newer`: the new read STARTS at the last kept record's offset, so the
 *     leading-partial drop consumes exactly that already-held record and emits
 *     only what follows. Skipped when that offset is 0 (nothing is dropped at byte
 *     0, so the record would be emitted twice) — that window is re-read whole.
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
    // Items parsed so far, in file order. Each doubling PREPENDS the newly exposed
    // older region rather than re-parsing everything (see EXTENDING above).
    let items: TranscriptItem[] = []
    for (;;) {
      const start = Math.max(0, end - windowBytes)
      const atBoundary = start === 0
      // Read only what the previous round did not: up to the oldest record we hold.
      // An undecodable cursor (offsetOf → -1) leaves the seam unknown, so fall back
      // to re-reading the whole window rather than guess a boundary.
      const held = items.length > 0 ? offsetOf(items[0] as TranscriptItem) : -1
      const extend = held > 0
      const readEnd = extend ? held : end
      if (readEnd > start) {
        const fresh =
          start === 0 && readEnd === size
            ? await self.readFileItems(entry.path, entry.fileId, recordToItems)
            : await self.readFileItems(entry.path, entry.fileId, recordToItems, {
                start,
                end: readEnd,
              })
        items = extend ? [...fresh, ...items] : fresh
      }
      if (atBoundary || items.length >= needed) return { items, atBoundary }
      windowBytes = Math.min(end, windowBytes * 2)
    }
  }

  // toward === 'newer': window starts before the anchor record (so it survives the
  // leading-partial drop) or at byte 0 (no anchor → file head); grow END forward.
  const anchorOffset = opts.anchorOffset
  let windowBytes = Math.min(size, initialWindow)
  // Seed start strictly before the anchor record. With no anchor we read from 0.
  const start = anchorOffset === undefined ? 0 : Math.max(0, anchorOffset - 1)
  // Items parsed so far, in file order; each doubling APPENDS the newly exposed
  // newer region rather than re-parsing everything (see EXTENDING above).
  let items: TranscriptItem[] = []
  for (;;) {
    const end = Math.min(size, start + windowBytes)
    const atBoundary = end >= size
    // Resume at the last record we hold: `readFileItems` drops the first line of a
    // window starting past byte 0, which is exactly that already-held record. At
    // offset 0 nothing is dropped, so re-read the window whole instead.
    const held = items.length > 0 ? offsetOf(items[items.length - 1] as TranscriptItem) : -1
    const extend = held > 0
    const readStart = extend ? held : start
    if (end > readStart) {
      const fresh = await self.readFileItems(entry.path, entry.fileId, recordToItems, {
        start: readStart,
        end,
      })
      // The prior window's own trailing record was dropped as a non-EOF fragment, so
      // `fresh` begins after the last held record — append, never splice.
      items = extend ? [...items, ...fresh] : fresh
    }
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

// ---------------------------------------------------------------------------
// Parsed-slice cache (POD-724).
//
// Every session switch re-runs `readTranscriptSlice`: it re-opens the JSONL,
// re-reads a bounded doubling byte window, and re-`JSON.parse`s ~700-1000 items —
// per switch, even when the file has not changed (measured p50 458ms / p90 1s in
// POD-701). This cache stores the COMPLETED slice result keyed on the chain's
// on-disk identity (path + size + mtime) plus the read shape (anchor, direction,
// limit), so an unchanged file serves the prior parse instead of re-reading.
//
// FRESHNESS is a per-hit `fs.stat` of each chain file (~10µs, vs ~500ms to
// re-parse). An APPEND — the only mutation transcript files take by contract
// (append-only; the live tailer only ever grows them) — changes size and mtime,
// so the key changes and the read naturally misses and re-parses. This covers the
// hot "newest window" case (`direction: 'before'`, no anchor = tail): a grown file
// has a new size, so a tail read of it MUST miss. Truncation / whole-file rewrite
// also changes size (or mtime) → miss. RESIDUAL RISK: a same-size, same-mtime-ms
// rewrite (a rewrite within the filesystem's mtime granularity that preserves byte
// length) would serve a stale slice — accepted, as it cannot arise from the
// append-only contract.
//
// IMMUTABILITY: a hit returns the SAME `SliceResult` object (and its `items`
// array) that was parsed on the miss. Consumers MUST treat items as immutable —
// both production callers (the daemon `transcriptRead` handler and the server's
// lake fallback) only serialize the result over the wire, never mutate it. A
// mutating consumer would corrupt every later hit; add a defensive copy at that
// call site if one is ever introduced, not here.
//
// This is opt-in (`readTranscriptSliceCached`, wired by `fileChainSource` when the
// caller passes `cached: true`) so the indexer, boot re-seed, and tests keep the
// uncached path and never accidentally retain memory.
// ---------------------------------------------------------------------------

interface SliceCacheEntry {
  result: SliceResult
  /** Approximate retained bytes for the byte-bound accounting. */
  bytes: number
}

/** Max distinct cached slices. */
const SLICE_CACHE_MAX_ENTRIES = 64
/** Max approximate retained bytes across all cached slices. */
const SLICE_CACHE_MAX_BYTES = 64 * 1024 * 1024

// Insertion-ordered map == the LRU queue: front is oldest, back is most-recent. A
// hit re-inserts its key to the back; eviction drops from the front.
const sliceCache = new Map<string, SliceCacheEntry>()
let sliceCacheBytes = 0
let sliceCacheHits = 0
let sliceCacheMisses = 0
let sliceTailContinuations = 0

/** Cache counters + current occupancy. Exported for tests (hit/miss assertions).
 *  `tailContinuations` counts misses served incrementally from the appended bytes
 *  (POD-1623) rather than by re-reading the file — the property the perf fix rests
 *  on, so it is asserted directly instead of inferred from a duration. */
export function sliceCacheStats(): {
  hits: number
  misses: number
  entries: number
  bytes: number
  tailContinuations: number
} {
  return {
    hits: sliceCacheHits,
    misses: sliceCacheMisses,
    entries: sliceCache.size,
    bytes: sliceCacheBytes,
    tailContinuations: sliceTailContinuations,
  }
}

/** Drop all cached slices and zero the counters. Exported for test isolation. */
export function resetSliceCache(): void {
  sliceCache.clear()
  tailCache.clear()
  sliceCacheBytes = 0
  sliceCacheHits = 0
  sliceCacheMisses = 0
  sliceTailContinuations = 0
}

/** Cheap approximate byte size of a parsed slice — the large fields only, plus a
 *  fixed per-item overhead for cursor/id/small fields. Only ever run once, on a
 *  miss (we already hold the parsed items), so it never touches the hit path. */
function estimateSliceBytes(items: TranscriptItem[]): number {
  let bytes = 0
  for (const it of items) {
    bytes +=
      200 +
      (it.text?.length ?? 0) +
      (it.toolResult?.length ?? 0) +
      (it.toolInput?.length ?? 0) +
      (it.toolInputJson?.length ?? 0)
  }
  return bytes
}

/** Build the freshness-bearing cache key by stat-ing every chain file. Returns
 *  null when any file is missing/unstattable — the caller then serves uncached
 *  (we never cache against an absent file, whose read result is a degenerate
 *  empty/partial). */
async function sliceCacheKey(chain: ChainEntry[], opts: SliceOptions): Promise<string | null> {
  const parts: string[] = []
  for (const entry of chain) {
    try {
      const st = await stat(entry.path)
      parts.push(`${entry.path}#${st.size}#${st.mtimeMs}`)
    } catch {
      return null
    }
  }
  const initial = opts.initialWindowBytes ?? ''
  return `${opts.direction}|${opts.limit}|${opts.anchor ?? ''}|${initial}|${parts.join(',')}`
}

/** Evict oldest entries until both the entry-count and byte bounds hold. */
function evictSliceCache(): void {
  while (
    sliceCache.size > 0 &&
    (sliceCache.size > SLICE_CACHE_MAX_ENTRIES || sliceCacheBytes > SLICE_CACHE_MAX_BYTES)
  ) {
    const oldest = sliceCache.keys().next()
    if (oldest.done) break
    const entry = sliceCache.get(oldest.value)
    sliceCache.delete(oldest.value)
    if (entry) sliceCacheBytes -= entry.bytes
  }
}

/**
 * Cached wrapper over {@link readTranscriptSlice}. Byte-identical results (the same
 * completed `SliceResult`), only faster on a repeat read of an unchanged file. See
 * the "Parsed-slice cache" block above for the freshness, immutability, and bounds
 * contract. Wired by `fileChainSource` when a caller opts in with `cached: true`.
 */
export async function readTranscriptSliceCached(
  chain: ChainEntry[],
  recordToItems: (r: unknown) => TranscriptItem[],
  opts: SliceOptions,
): Promise<SliceResult> {
  // Degenerate reads have nothing to cache and the underlying reader already
  // short-circuits them cheaply.
  if (chain.length === 0 || opts.limit <= 0) return readTranscriptSlice(chain, recordToItems, opts)

  const key = await sliceCacheKey(chain, opts)
  if (key === null) return readTranscriptSlice(chain, recordToItems, opts)

  const hit = sliceCache.get(key)
  if (hit) {
    sliceCacheHits++
    // LRU touch: re-insert at the back so it is the most-recent.
    sliceCache.delete(key)
    sliceCache.set(key, hit)
    return hit.result
  }

  sliceCacheMisses++
  // POD-1623: a miss caused purely by an APPEND continues the prior parse from the
  // last record instead of re-reading the file. Falls back to the full read when it
  // cannot prove continuity.
  const continued = await continueTailRead(chain, recordToItems, opts)
  if (continued) sliceTailContinuations++
  const result = continued ?? (await readTranscriptSlice(chain, recordToItems, opts))
  rememberTail(chain, opts, result)
  const bytes = estimateSliceBytes(result.items)
  sliceCache.set(key, { result, bytes })
  sliceCacheBytes += bytes
  evictSliceCache()
  return result
}

// ---------------------------------------------------------------------------
// Append-incremental tail reads (POD-1623).
//
// The cache above is keyed on file size+mtime, so an APPEND — the only mutation a
// transcript takes under the append-only contract — always misses, and the miss
// re-read and re-`JSON.parse`d the WHOLE file. Measured on the live lake, one
// appended record on a 97.6MB transcript cost 837ms of straight-line CPU. That is
// paid once per incoming message per open chat, on the server/daemon event loop,
// so it froze every session rather than only the one being read.
//
// A grown file's tail is the OLD tail plus the appended records, so the new answer
// is computable from the appended bytes alone. This keeps, per (file, limit), the
// page it last served plus the byte offset of its last record; a later read
// re-parses only `[lastRecordOffset, size)` and splices.
//
// Re-parsing FROM the last record (not from the old EOF) is deliberate: the live
// tailer flushes a trailing record before its newline arrives, so that record's
// content can still grow. Re-reading it means the completed version replaces the
// partial one instead of being emitted twice.
//
// SCOPE: single-file chains reading the newest window (`before`, no anchor) — the
// chat-open and live-tail read, and the only shape that grows at a known end.
// Everything else falls through to the full read unchanged.
//
// SAFETY: continuity is proven, never assumed. The file must not have shrunk, and
// the record re-parsed at `lastRecordOffset` must carry the SAME cursor as the one
// remembered there (the cursor encodes the record's uuid, so a rewrite that
// preserves byte length is still caught, while an in-flight record that merely grew
// keeps its uuid and matches). Any mismatch → full re-parse.
// ---------------------------------------------------------------------------

interface TailEntry {
  /** The page last served for this (file, limit). */
  items: TranscriptItem[]
  /** Byte offset of the last record contributing to `items`. */
  lastRecordOffset: number
  /** How many trailing `items` came from that record — the splice index. */
  trailingCount: number
  /** File size when `items` was parsed — a shrink disproves append-only. */
  size: number
  /** `hasMore` of the remembered page: true ⇒ older items remain on disk. */
  hasMore: boolean
}

const TAIL_CACHE_MAX_ENTRIES = 64
const tailCache = new Map<string, TailEntry>()

/** The incremental path applies only to a single-file newest-window read. */
function tailKey(chain: ChainEntry[], opts: SliceOptions): string | null {
  if (chain.length !== 1 || opts.direction !== 'before' || opts.anchor !== undefined) return null
  const entry = chain[0]
  if (!entry) return null
  return `${entry.path}|${entry.fileId}|${opts.limit}|${opts.initialWindowBytes ?? ''}`
}

function rememberTail(chain: ChainEntry[], opts: SliceOptions, result: SliceResult): void {
  const key = tailKey(chain, opts)
  const entry = chain[0]
  if (key === null || !entry) return
  const last = result.items[result.items.length - 1]
  const lastRecordOffset = last ? offsetOf(last) : -1
  if (lastRecordOffset < 0) {
    tailCache.delete(key)
    return
  }
  // How many trailing items came from that last record (a record can map to several
  // items). Counted backwards from the end, so it costs a handful of cursor decodes
  // rather than one per page item — the continuation then splices by INDEX and never
  // decodes the page again.
  let trailingCount = 0
  for (let i = result.items.length - 1; i >= 0; i--) {
    if (offsetOf(result.items[i] as TranscriptItem) !== lastRecordOffset) break
    trailingCount++
  }
  let size: number
  try {
    size = statSync(entry.path).size
  } catch {
    return
  }
  tailCache.delete(key)
  tailCache.set(key, {
    items: result.items,
    lastRecordOffset,
    trailingCount,
    size,
    hasMore: result.hasMore,
  })
  while (tailCache.size > TAIL_CACHE_MAX_ENTRIES) {
    const oldest = tailCache.keys().next()
    if (oldest.done) break
    tailCache.delete(oldest.value)
  }
}

/** Serve a grown file's newest window from the remembered page plus the appended
 *  bytes. Returns null when the incremental path does not apply or cannot be
 *  proven safe — the caller then does the full read. */
async function continueTailRead(
  chain: ChainEntry[],
  recordToItems: (r: unknown) => TranscriptItem[],
  opts: SliceOptions,
): Promise<SliceResult | null> {
  const key = tailKey(chain, opts)
  const entry = chain[0]
  if (key === null || !entry) return null
  const prior = tailCache.get(key)
  if (!prior) return null

  let size: number
  try {
    size = (await stat(entry.path)).size
  } catch {
    return null
  }
  // Shrink ⇒ not an append. Also nothing to do if the last record's offset is no
  // longer inside the file.
  if (size < prior.size || prior.lastRecordOffset >= size) return null

  // Start STRICTLY before the last record so `readFileItems`' leading-partial drop
  // consumes the previous record's terminating newline and not the record we want.
  const start = Math.max(0, prior.lastRecordOffset - 1)
  const fresh = await self.readFileItems(entry.path, entry.fileId, recordToItems, {
    start,
    end: size,
  })

  // Continuity proof, in O(1) cursor decodes: the re-read must BEGIN at the record we
  // remembered, and that record must be the same one (the cursor encodes its uuid, so
  // a same-length rewrite is caught, while an in-flight record that merely grew keeps
  // its uuid and matches).
  const keep = prior.items.length - prior.trailingCount
  const priorAtOffset = prior.items[keep]
  const freshAtOffset = fresh[0]
  if (!priorAtOffset || !freshAtOffset) return null
  if (offsetOf(freshAtOffset) !== prior.lastRecordOffset) return null
  if (priorAtOffset.cursor !== freshAtOffset.cursor) return null

  // Splice: the remembered page minus the re-read record, plus everything re-parsed.
  const merged = [...prior.items.slice(0, keep), ...fresh]
  // Fewer items than asked for while older ones remain on disk means the splice lost
  // context the page needs — fall back rather than serve a short page.
  if (merged.length < opts.limit && prior.hasMore) return null

  const items = merged.slice(Math.max(0, merged.length - opts.limit))
  const hasMore = prior.hasMore || merged.length > opts.limit
  return finalize(items, hasMore)
}
