import type { TranscriptItem } from '@podium/model'
import { decodeCursor } from './cursor-codec'
import type { ChainEntry } from './file-chain'
import { readTranscriptSlice, readTranscriptSliceCached, type SliceResult } from './slice'

/**
 * A read strategy for a single session's transcript. Storage varies wildly
 * between harnesses (JSONL files vs a SQLite store), so the read layer is an
 * adaptable strategy: every implementation serves the SAME cursor-anchored
 * `SliceResult` over the SAME opaque cursor contract, so cursors interoperate
 * and callers never branch on the harness. A NEW harness is added as a new
 * `TranscriptSource` implementation — no change to callers. The per-harness
 * grammar (file locators, the opencode SQLite source) lives in that harness's
 * `adapters/<h>/transcript.ts`; the Store takes it as a parameter (see
 * `./store.ts`) and holds only the storage-neutral parts here.
 */
export interface TranscriptSource {
  /** Cursor-anchored read; SAME contract as `readTranscriptSlice`. */
  readSlice(opts: {
    anchor?: string
    direction: 'before' | 'after'
    limit: number
    /** Opt-in parsed-slice cache (POD-724): serve an unchanged file's prior parse
     *  instead of re-reading. Byte-identical result, keyed on file size/mtime +
     *  read shape. Only the hot on-switch legs (the daemon `transcriptRead` handler
     *  and the server lake fallback) set this; the boot re-seed and indexer leave it
     *  false so they never retain memory. File-chain sources honor it; the opencode
     *  source is already in-memory and ignores it. */
    cached?: boolean
  }): Promise<SliceResult>
}

/** Pure parser from one harness-native record to neutral transcript items. The
 * implementations live in this package; selection belongs to the harness
 * manifest so adding a CLI never mutates a second registry here. */
export type TranscriptRecordMapper = (record: unknown) => TranscriptItem[]

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
    readSlice: ({ cached, ...opts }) =>
      cached
        ? readTranscriptSliceCached(chain, recordToItems, opts)
        : readTranscriptSlice(chain, recordToItems, opts),
  }
}

/**
 * Index-slice a fully-ordered, in-memory item list around an anchor — the
 * SliceResult contract over a list rather than a file chain. The opencode
 * SQLite source (adapters/opencode/transcript.ts) builds its full ordered item
 * list and slices it here, exactly matching `readTranscriptSlice`'s semantics.
 *
 * Anchor matching uses UUID + sub within the session namespace, even when the
 * position changes. UUID-less anchors use position + sub. Missing anchors fall
 * back to the default window (newest for `before`, oldest for `after`).
 */
export function sliceItemsByAnchor(
  all: TranscriptItem[],
  opts: { anchor?: string; direction: 'before' | 'after'; limit: number },
): SliceResult {
  if (all.length === 0 || opts.limit <= 0) return { items: [], hasMore: false }

  const anchorIdx = opts.anchor ? findAnchorIndex(all, opts.anchor) : -1
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

/** Locate the anchor item: exact cursor first, then UUID + sub (position only for UUID-less anchors). */
function findAnchorIndex(items: TranscriptItem[], anchor: string): number {
  const exact = items.findIndex((i) => i.cursor === anchor)
  if (exact >= 0) return exact
  const want = decodeCursor(anchor)
  if (!want) return -1
  return items.findIndex((i) => {
    const c = i.cursor ? decodeCursor(i.cursor) : null
    return (
      c !== null &&
      c.fileId === want.fileId &&
      (want.uuid === null ? c.offset === want.offset : c.uuid === want.uuid) &&
      c.sub === want.sub
    )
  })
}
