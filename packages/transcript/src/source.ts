import type { TranscriptItem } from '@podium/protocol'
import { claudeRecordToItems } from './claude.js'
import { codexRecordToItems } from './codex.js'
import { cursorRecordToItems } from './cursor.js'
import { decodeCursor, encodeCursor } from './cursor-codec.js'
import type { ChainEntry } from './file-chain.js'
import { grokRecordToItems } from './grok.js'
import { type OpencodeMessagePartRow, opencodePartToItems } from './opencode.js'
import { readTranscriptSlice, type SliceResult } from './slice.js'

/**
 * A read strategy for a single session's transcript. Storage varies wildly
 * between harnesses (JSONL files vs a SQLite store), so the read layer is an
 * adaptable strategy: every implementation serves the SAME cursor-anchored
 * `SliceResult` over the SAME opaque cursor contract, so cursors interoperate
 * and callers never branch on the harness. A NEW harness is added as a new
 * `TranscriptSource` implementation — no change to callers. The per-kind
 * resolution (file locators, the opencode SQLite source) lives in
 * @podium/agent-bridge's `transcriptSourceFor`; this package holds only the
 * storage-neutral parts.
 */
export interface TranscriptSource {
  /** Cursor-anchored read; SAME contract as `readTranscriptSlice`. */
  readSlice(opts: {
    anchor?: string
    direction: 'before' | 'after'
    limit: number
  }): Promise<SliceResult>
}

// ---------------------------------------------------------------------------
// File-chain source — the file-based harnesses (claude/codex/grok/cursor).
// ---------------------------------------------------------------------------

/**
 * Source for file-based harnesses: a thin wrapper over the bounded-window chain
 * reader. All the paging/anchoring/bounded-read logic already lives in
 * `readTranscriptSlice`; this just binds it to a resolved chain + mapper.
 */
export function fileChainSource(
  chain: ChainEntry[],
  recordToItems: (r: unknown) => TranscriptItem[],
): TranscriptSource {
  return {
    readSlice: (opts) => readTranscriptSlice(chain, recordToItems, opts),
  }
}

// ---------------------------------------------------------------------------
// opencode cursor stamping + in-memory slicing (the SQLite source's pure half).
// ---------------------------------------------------------------------------

/** Stable file-id tag for an opencode session's cursor namespace. */
function opencodeFileId(sessionId: string): string {
  return `opencode:${sessionId}`
}

/**
 * Map opencode part rows to cursor-stamped items, stamping each item with a
 * cursor that encodes the part's position in the session's total
 * `(time_updated, id, sub)` order. One part → 0..N items (a tool part is a call +
 * a result), so each item gets its own `sub` index within the part. We can't
 * reuse `stampCursors` directly: every row is its own sub-sequence keyed by the
 * row's `timeUpdated` and `partId`, not a single shared `(offset, uuid)`.
 *
 *   - `offset` = `row.timeUpdated` (the DB's primary order key)
 *   - `uuid`   = `row.partId`      (disambiguates same-`time_updated` ties; the
 *                                   secondary `id` order key)
 *   - `sub`    = item index within the part
 *
 * The triple is the part-position analog of the file `(offset, uuid, sub)` and
 * yields a total order matching the DB's `(time_updated, id, sub)`.
 *
 * Shared so the daemon's live opencode observer stamps emitted items with the
 * EXACT SAME cursor scheme as `opencodeDbSource`'s on-demand read — live deltas
 * and read pages then interoperate (the client can dedup/subscribe-from-cursor).
 * The cursor namespace (`fileId`) is derived from `sessionId` here so callers
 * pass only `(rows, sessionId)` — they never construct the fileId themselves.
 */
export function stampOpencodeItems(
  rows: OpencodeMessagePartRow[],
  sessionId: string,
): TranscriptItem[] {
  const fileId = opencodeFileId(sessionId)
  const out: TranscriptItem[] = []
  for (const row of rows) {
    const items = opencodePartToItems(row)
    for (let sub = 0; sub < items.length; sub++) {
      const item = items[sub]
      if (!item) continue
      out.push({
        ...item,
        cursor: encodeCursor({ fileId, offset: row.timeUpdated, uuid: row.partId, sub }),
      })
    }
  }
  return out
}

/**
 * Index-slice a fully-ordered, in-memory item list around an anchor — the
 * SliceResult contract over a list rather than a file chain. Kept a SMALL
 * copy of `readTranscriptSlice`'s slice arithmetic rather than merged into it:
 * `readTranscriptSlice` has no full-list in-memory path to share — it reads
 * bounded, doubling windows per file and never materializes the whole chain.
 * opencode's parts ARE a bounded list, so an honest in-memory slice is the
 * right shape here. Exported for @podium/agent-bridge's `opencodeDbSource`.
 *
 * Anchor matching is exact (cursor string) first, then drift-tolerant on the FULL
 * `{fileId, offset, uuid, sub}` — opencode `time_updated` ties are common, so the
 * partId (`uuid`) is load-bearing for disambiguation, unlike the file source which
 * may drift on `{fileId, offset, sub}` alone. A missing/undecodable/not-found
 * anchor falls back to the default window (newest for `before`, oldest for
 * `after`), matching `readTranscriptSlice`.
 */
export function sliceItemsByAnchor(
  all: TranscriptItem[],
  opts: { anchor?: string; direction: 'before' | 'after'; limit: number },
): SliceResult {
  if (all.length === 0 || opts.limit <= 0) return { items: [], hasMore: false }

  const anchorIdx = opts.anchor ? findOpencodeAnchorIndex(all, opts.anchor) : -1
  // No anchor (or it drifted away): page from the appropriate end.
  const haveAnchor = anchorIdx >= 0

  if (opts.direction === 'before') {
    // Items strictly before the anchor (all of them when no anchor).
    const before = haveAnchor ? all.slice(0, anchorIdx) : all
    const start = Math.max(0, before.length - opts.limit)
    const items = before.slice(start)
    // hasMore iff older items remain before the page (we trimmed some off the front).
    return finalize(items, start > 0)
  }

  // direction === 'after': items strictly after the anchor (all when no anchor).
  const after = haveAnchor ? all.slice(anchorIdx + 1) : all
  const items = after.slice(0, opts.limit)
  // hasMore iff newer items remain past the page.
  return finalize(items, after.length > opts.limit)
}

function finalize(items: TranscriptItem[], hasMore: boolean): SliceResult {
  return { items, head: items[0]?.cursor, tail: items.at(-1)?.cursor, hasMore }
}

/** Locate the anchor item: exact cursor first, then full `{fileId,offset,uuid,sub}`. */
function findOpencodeAnchorIndex(items: TranscriptItem[], anchor: string): number {
  const exact = items.findIndex((i) => i.cursor === anchor)
  if (exact >= 0) return exact
  const want = decodeCursor(anchor)
  if (!want) return -1
  return items.findIndex((i) => {
    const c = i.cursor ? decodeCursor(i.cursor) : null
    return (
      c !== null &&
      c.fileId === want.fileId &&
      c.offset === want.offset &&
      c.uuid === want.uuid &&
      c.sub === want.sub
    )
  })
}

// ---------------------------------------------------------------------------
// Per-kind record mapper.
// ---------------------------------------------------------------------------

/** The per-kind record→items mapper registry. Seeded with the built-in
 *  harnesses; `registerTranscriptRecordMapper` is the extension seam a new
 *  harness's adapter uses to plug its parser in (this package stays a
 *  near-leaf — implementations register from outside, it imports nothing). */
const RECORD_MAPPERS: Record<string, (r: unknown) => TranscriptItem[]> = {
  'claude-code': claudeRecordToItems,
  codex: codexRecordToItems,
  cursor: cursorRecordToItems,
  grok: grokRecordToItems,
}

/** Register (or override) the record→items mapper for an agent kind. */
export function registerTranscriptRecordMapper(
  agentKind: string,
  mapper: (r: unknown) => TranscriptItem[],
): void {
  RECORD_MAPPERS[agentKind] = mapper
}

/** Per-harness record→items mapper, mirroring the daemon's `resolveTranscriptSource`.
 *  Exported for the server's lake-fallback read (docs/spec/search-v1.md §2.2): the
 *  lake file is the native JSONL byte-verbatim, so the same mapper applies.
 *  Unknown kinds fall back to the claude mapper (historical behavior). */
export function recordToItemsForKind(agentKind: string): (r: unknown) => TranscriptItem[] {
  return RECORD_MAPPERS[agentKind] ?? claudeRecordToItems
}
