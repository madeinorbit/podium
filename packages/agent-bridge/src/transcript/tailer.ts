import { open } from 'node:fs/promises'
import type { TranscriptItem } from '@podium/protocol'
import { LineDecoder } from '../jsonl-stream.js'
import { claudeRecordColor, claudeRecordToItems } from './claude.js'

const POLL_MS = 700
// Initial-read cap: a long-running transcript can be hundreds of MB, but the
// chat view only needs the recent tail. Seek to the last TAIL_BYTES on the first
// read instead of slurping the whole file (which spiked daemon memory on every
// live session at reattach). Deltas after the first read are tiny.
//
// 16 MB (was 8 MB, originally 512 KB): the old window dropped the *beginning* of
// any conversation past a few hundred turns, so the chat view opened mid-thread.
// Older items beyond this tail are now reachable on demand via readTranscriptPage
// (scroll-to-top paging), so this is just the live seed window — kept generous so
// the common case loads whole, but still bounded to cap the reattach read.
const TAIL_BYTES = 16 * 1024 * 1024
// First read may still surface many items within the tail window; keep the most
// recent so a freshly-mounted chat view isn't handed an unbounded backlog. Kept
// in step with the server's per-session transcript buffer (MAX_TRANSCRIPT_ITEMS).
// Older items are paged in on demand (readTranscriptPage), so this is a window cap,
// not a hard transcript limit.
const MAX_INITIAL_ITEMS = 12_000

// First backward window readTranscriptPage reads from the END of the file when
// paging older items. A page is a small slice near the tail, so a 256 KB window
// usually covers `fromEnd + limit + 1` records in one read; if it doesn't (very
// long records, or paging far back), the window doubles until it does or it
// reaches byte 0. Keeps a scroll-to-top page O(page size), not O(file size).
const INITIAL_PAGE_WINDOW_BYTES = 256 * 1024

export interface TranscriptTailer {
  /** The file currently tailed. */
  readonly path: string
  stop(): void
}

/**
 * One-shot read of a transcript file's recent tail — the same window a live tail
 * seeds with, but without polling. Recovers a parked (hibernated/exited) session's
 * history on demand: its process is gone, so nothing is tailing the file, and the
 * server's in-memory buffer is empty after a restart. Returns [] if the file is
 * missing or unreadable.
 */
export async function readTranscriptTail(
  path: string,
  recordToItems: (record: unknown) => TranscriptItem[] = claudeRecordToItems,
): Promise<TranscriptItem[]> {
  try {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      if (size === 0) return []
      const start = Math.max(0, size - TAIL_BYTES)
      const chunk = Buffer.alloc(size - start)
      await handle.read(chunk, 0, chunk.length, start)
      let lines = new LineDecoder().push(chunk)
      // Seeked past byte 0 → the first line is a fragment of a prior record; drop it.
      if (start > 0 && lines.length > 0) lines = lines.slice(1)
      let items: TranscriptItem[] = []
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          items = items.concat(recordToItems(JSON.parse(trimmed)))
        } catch {
          // torn/partial line — skip
        }
      }
      return items.length > MAX_INITIAL_ITEMS ? items.slice(-MAX_INITIAL_ITEMS) : items
    } finally {
      await handle.close()
    }
  } catch {
    return []
  }
}

/** A page of OLDER transcript items, plus whether earlier items still remain. */
export interface TranscriptPage {
  items: TranscriptItem[]
  /** True when items earlier than this page still exist on disk. */
  hasMore: boolean
}

/**
 * Read the page of transcript items that comes BEFORE the client's current
 * window — the scroll-to-top "load earlier messages" path for arbitrarily long
 * sessions.
 *
 * Cursor: `fromEnd` is the number of items the caller already holds, counted from
 * the END of the full transcript (so fromEnd=0 is the very latest item). We return
 * the `limit` items that sit immediately before that window:
 *   total = full item count; end = total - fromEnd; start = max(0, end - limit)
 *   page = items[start, end)
 * `hasMore` is `start > 0`. The caller's next request passes
 * `fromEnd + page.length` to walk further back.
 *
 * A purely positional cursor (not an item id) is deliberate: several item ids are
 * synthesized per-parse (freshId — tool results without a uuid, attachments) and
 * are NOT stable across separate read calls, so an id cursor couldn't be found
 * reliably. Item *count* and *content* ARE deterministic for the same file bytes,
 * so a from-end index is the stable cursor.
 *
 * PERF: this reads BACKWARD in byte windows from the end of the file instead of
 * slurping + parsing the whole thing on every page request. A page sits near the
 * tail (the caller already holds `fromEnd` items and asks for `limit` more before
 * them), so we only need roughly the last `fromEnd + limit + 1` items' worth of
 * bytes — that "+1" lets us decide `hasMore`. We keep doubling the window
 * backward until we've parsed enough whole records (or reached byte 0). Result is
 * byte-for-byte identical to the old whole-file read for every cursor, including
 * ordering and `hasMore`. Returns an empty, hasMore:false page if the file is
 * missing/unreadable.
 */
export async function readTranscriptPage(
  path: string,
  fromEnd: number,
  limit: number,
  recordToItems: (record: unknown) => TranscriptItem[] = claudeRecordToItems,
): Promise<TranscriptPage> {
  if (limit <= 0) return { items: [], hasMore: fromEnd > 0 }
  try {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      if (size === 0) return { items: [], hasMore: false }

      // We need the page items plus one extra to know if anything precedes the
      // page: end = total - fromEnd, start = end - limit, page = [start, end).
      // Collecting the last (fromEnd + limit + 1) items from the tail is enough
      // to compute both the slice and `hasMore` without reading the whole file.
      const needed = fromEnd + limit + 1

      // Grow the read window backward (doubling) until we've parsed `needed`
      // whole items or reached the head of the file.
      let windowBytes = Math.min(size, INITIAL_PAGE_WINDOW_BYTES)
      let items: TranscriptItem[] = []
      let atHead = false
      for (;;) {
        const start = Math.max(0, size - windowBytes)
        atHead = start === 0
        const chunk = Buffer.alloc(size - start)
        await handle.read(chunk, 0, chunk.length, start)
        let lines = new LineDecoder().push(chunk)
        // Seeked past byte 0 → the first line is the tail of a prior record;
        // drop it (a later, larger window will read that record whole if needed).
        if (!atHead && lines.length > 0) lines = lines.slice(1)
        items = []
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            for (const item of recordToItems(JSON.parse(trimmed))) items.push(item)
          } catch {
            // torn/partial line — skip
          }
        }
        if (atHead || items.length >= needed) break
        windowBytes = Math.min(size, windowBytes * 2)
      }

      // `items` is the suffix of the full item stream (or the whole stream when
      // atHead). Slice using from-end positions so the result matches the
      // whole-file read regardless of how many older items we skipped reading.
      const count = items.length
      const end = Math.max(0, count - fromEnd)
      const start = Math.max(0, end - limit)
      const page = items.slice(start, end)
      // `hasMore` is whether any item precedes the page. atHead: `count` is the
      // true total, so `start > 0` is exact. Otherwise we only stop early once
      // `count >= fromEnd + limit + 1`, which forces `start >= 1` — so `start > 0`
      // is true exactly when earlier items exist (in-window AND on disk). Both
      // branches reduce to the same test.
      return { items: page, hasMore: start > 0 }
    } finally {
      await handle.close()
    }
  } catch {
    return { items: [], hasMore: false }
  }
}

export interface TranscriptTailOptions {
  pollMs?: number
  /** Maps one decoded JSONL record to zero or more normalized chat items. */
  recordToItems?: (record: unknown) => TranscriptItem[]
  /** Extract an agent identity colour (`/color`) from a record, if any. Called
   *  alongside recordToItems; `onColor` fires when the value changes. */
  recordColor?: (record: unknown) => string | undefined
  onColor?: (color: string) => void
}

/**
 * Poll-tail a harness transcript JSONL file, emitting parsed TranscriptItems as
 * the agent appends. Polling (not fs.watch) on purpose: editors/agents do
 * atomic-rename writes that confuse watchers, and a 700ms poll of one stat is
 * cheap. Handles truncation (size shrink → start over with reset=true).
 */
export function tailTranscript(
  path: string,
  onItems: (items: TranscriptItem[], reset: boolean) => void,
  opts: TranscriptTailOptions = {},
): TranscriptTailer {
  const recordToItems = opts.recordToItems ?? claudeRecordToItems
  const recordColor = opts.recordColor ?? claudeRecordColor
  let lastColor: string | undefined
  let offset = 0
  const decoder = new LineDecoder()
  let first = true
  // Set when the first read seeks past byte 0: the bytes before the first
  // newline are a fragment of a prior line and must be dropped once.
  let dropLeadingPartial = false
  let stopped = false
  let reading = false

  const readNew = async (): Promise<void> => {
    if (reading || stopped) return
    reading = true
    try {
      const handle = await open(path, 'r')
      try {
        const { size } = await handle.stat()
        let reset = false
        if (first) {
          const start = Math.max(0, size - TAIL_BYTES)
          offset = start
          dropLeadingPartial = start > 0
          first = false
          reset = true
        }
        if (size < offset) {
          // Truncated/replaced — re-read from the top and tell consumers to clear.
          offset = 0
          decoder.reset()
          dropLeadingPartial = false
          reset = true
        }
        if (size === offset) {
          if (reset) onItems([], true)
          return
        }
        const chunk = Buffer.alloc(size - offset)
        await handle.read(chunk, 0, chunk.length, offset)
        offset = size
        let lines = decoder.push(chunk)
        if (dropLeadingPartial && lines.length > 0) {
          lines = lines.slice(1)
          dropLeadingPartial = false
        }
        let items: TranscriptItem[] = []
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let record: unknown
          try {
            record = JSON.parse(trimmed)
          } catch {
            continue // torn write — skip the line
          }
          items = items.concat(recordToItems(record))
          // Identity colour rides the same tail — emit on change (last wins).
          const color = recordColor(record)
          if (color !== undefined && color !== lastColor) {
            lastColor = color
            opts.onColor?.(color)
          }
        }
        if (reset && items.length > MAX_INITIAL_ITEMS) items = items.slice(-MAX_INITIAL_ITEMS)
        if (items.length > 0 || reset) onItems(items, reset)
      } finally {
        await handle.close()
      }
    } catch {
      // file missing (not created yet / rotated away) — keep polling
    } finally {
      reading = false
    }
  }

  const timer = setInterval(() => void readNew(), opts.pollMs ?? POLL_MS)
  timer.unref?.()
  void readNew()

  return {
    path,
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}
