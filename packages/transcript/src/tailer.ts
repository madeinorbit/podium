import { open } from 'node:fs/promises'
import type { TranscriptItem } from '@podium/protocol'
import { claudeRecordColor, claudeRecordToItems } from './claude'
import { recordUuid, stampCursors } from './cursor-codec'
import { fileIdFor } from './file-chain'

const POLL_MS = 700
// Initial-read cap: a long-running transcript can be hundreds of MB, but the
// chat view only needs the recent tail. Seek to the last TAIL_BYTES on the first
// read instead of slurping the whole file (which spiked daemon memory on every
// live session at reattach). Deltas after the first read are tiny.
//
// 16 MB (was 8 MB, originally 512 KB): the old window dropped the *beginning* of
// any conversation past a few hundred turns, so the chat view opened mid-thread.
// Older items beyond this tail are now reachable on demand via the cursor-anchored
// read source (readTranscriptSlice / scroll-to-top paging), so this is just the
// live seed window — kept generous so the common case loads whole, but still
// bounded to cap the reattach read.
const TAIL_BYTES = 16 * 1024 * 1024
// First read may still surface many items within the tail window; keep the most
// recent so a freshly-mounted chat view isn't handed an unbounded backlog. Kept
// in step with the server's per-session transcript buffer (MAX_TRANSCRIPT_ITEMS).
// Older items are paged in on demand via the read source, so this is a window cap,
// not a hard transcript limit.
const MAX_INITIAL_ITEMS = 12_000

export interface TranscriptTailer {
  /** The file currently tailed. */
  readonly path: string
  stop(): void
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

/** Metadata accompanying each `onItems` delta. */
export interface TranscriptTailMeta {
  /** True when consumers should CLEAR their window and treat `items` as the new
   *  seed (first read, or after a truncation/replacement). */
  reset: boolean
  /** Cursor of the LAST emitted item in this delta, for "subscribe-since" paging.
   *  Undefined when the delta carries no items (e.g. an empty reset). */
  tail?: string
}

/**
 * Poll-tail a harness transcript JSONL file, emitting cursor-stamped
 * TranscriptItems as the agent appends. Polling (not fs.watch) on purpose:
 * editors/agents do atomic-rename writes that confuse watchers, and a 700ms poll
 * of one stat is cheap. Handles truncation (size shrink → start over with
 * reset=true).
 *
 * Cursors use the SAME scheme as the disk slice reader (`readFileItems` in
 * slice.ts): `fileId = fileIdFor(path)`, each record's items stamped with the
 * record line's ABSOLUTE byte offset and `recordUuid(record)`. So a live-tailed
 * cursor is interchangeable with one read off disk — the same record at the same
 * offset yields the same cursor either way.
 *
 * OFFSET FIDELITY: rather than lean on `LineDecoder` (whose `push` prepends
 * leftover from a prior chunk, making the absolute offset of each returned line
 * awkward to recover), this walks newline boundaries on a raw leftover Buffer
 * itself — the same raw-buffer line-walk `readFileItems` uses — so every record's
 * absolute offset is exact: `offset` always points at the byte where the current
 * leftover buffer begins, and each line's offset is `offset + its start in the
 * buffer`.
 *
 * TRAILING PARTIAL (flush): a record written without its terminating `\n` yet sits
 * in the leftover buffer and would otherwise be invisible until the newline lands
 * a poll later. After the per-poll line loop we parse that leftover (best-effort)
 * and emit it too — but we do NOT advance `offset` past it or consume it from the
 * buffer. So on the next poll, when the `\n` (and possibly more) arrives, the
 * now-complete line is re-walked from the SAME absolute offset and re-emitted with
 * the SAME cursor (`{fileId, offset, sub}`), which is idempotent downstream. The
 * flushed item is never duplicated WITHIN a single poll's `items` (it is only ever
 * the leftover, emitted once per poll); across polls the newline-terminated form
 * replaces it by identical cursor.
 */
export function tailTranscript(
  path: string,
  onItems: (items: TranscriptItem[], meta: TranscriptTailMeta) => void,
  opts: TranscriptTailOptions = {},
): TranscriptTailer {
  const recordToItems = opts.recordToItems ?? claudeRecordToItems
  const recordColor = opts.recordColor ?? claudeRecordColor
  const fileId = fileIdFor(path)
  let lastColor: string | undefined
  // Absolute byte position where `leftover` begins (= the start of the next
  // unparsed line). Bytes before this have been parsed into emitted items.
  let offset = 0
  // Raw bytes read past `offset` but not yet terminated by a newline.
  let leftover = Buffer.alloc(0)
  let first = true
  // Set when the first read seeks past byte 0: the bytes before the first
  // newline are a fragment of a prior line and must be dropped once.
  let dropLeadingPartial = false
  // Absolute offset of a trailing partial we already emitted via flush (-1 = none).
  // When that record's terminating '\n' lands next poll, the now-complete line
  // begins at exactly this offset; we skip re-emitting it (it was already shown),
  // so the same record is never delivered twice across polls.
  let flushedOffset = -1
  let stopped = false
  let reading = false

  /** Parse a single line's bytes into stamped items at the given absolute offset.
   *  Skips blank/torn lines (returns []). Also forwards an identity-colour change. */
  const lineToItems = (lineBytes: Buffer, lineOffset: number): TranscriptItem[] => {
    const trimmed = lineBytes.toString('utf8').trim()
    if (!trimmed) return []
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      return [] // torn write — skip the line
    }
    // Identity colour rides the same tail — emit on change (last wins).
    const color = recordColor(record)
    if (color !== undefined && color !== lastColor) {
      lastColor = color
      opts.onColor?.(color)
    }
    return stampCursors(recordToItems(record), fileId, lineOffset, recordUuid(record))
  }

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
          leftover = Buffer.alloc(0)
          dropLeadingPartial = start > 0
          first = false
          reset = true
        }
        // `offset + leftover.length` is the byte position we have already consumed
        // off disk. A shrink below that means the file was truncated/replaced.
        if (size < offset + leftover.length) {
          // Truncated/replaced — re-read from the top and tell consumers to clear.
          offset = 0
          leftover = Buffer.alloc(0)
          dropLeadingPartial = false
          flushedOffset = -1
          reset = true
        }
        const consumed = offset + leftover.length
        if (size === consumed && !reset) return
        let items: TranscriptItem[] = []
        if (size > consumed) {
          const chunk = Buffer.alloc(size - consumed)
          await handle.read(chunk, 0, chunk.length, consumed)
          // Walk newline boundaries on the raw (leftover + chunk) buffer so each
          // record's ABSOLUTE offset is exact. `offset` is buf[0]'s file position.
          const buf = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk
          let lineStart = 0
          for (let i = 0; i < buf.length; i++) {
            if (buf[i] !== 0x0a /* \n */) continue
            const lineBytes = buf.subarray(lineStart, i)
            const lineOffset = offset + lineStart
            const wasFirst = dropLeadingPartial
            lineStart = i + 1
            if (wasFirst) {
              // Seeked past byte 0 → the first line is a fragment of a prior record.
              dropLeadingPartial = false
              continue
            }
            // This is the newline-terminated form of a partial we already flushed
            // last poll (same start offset). Skip it: it was already delivered, and
            // re-emitting would duplicate the record. Clear the guard either way —
            // any later line is genuinely new.
            if (lineOffset === flushedOffset) {
              flushedOffset = -1
              continue
            }
            items = items.concat(lineToItems(lineBytes, lineOffset))
          }
          // Bytes after the last newline are an unterminated trailing record:
          // advance `offset` to its start and keep it as leftover (NOT consumed).
          leftover = buf.subarray(lineStart)
          offset += lineStart
        }
        // Surface the trailing partial (a record whose '\n' has not landed yet) so
        // a final unterminated record isn't stuck invisible. We do NOT consume it:
        // `offset`/`leftover` are unchanged. We remember its offset in
        // `flushedOffset` so that next poll, when the terminating '\n' lands, the
        // now-complete line at this same offset is skipped rather than re-emitted —
        // the record is delivered exactly once across polls.
        if (!dropLeadingPartial && leftover.length > 0) {
          const flushed = lineToItems(leftover, offset)
          if (flushed.length > 0) {
            items = items.concat(flushed)
            flushedOffset = offset
          } else {
            // Leftover is blank/torn (not a real record we showed) — no guard.
            flushedOffset = -1
          }
        } else {
          flushedOffset = -1
        }
        if (reset && items.length > MAX_INITIAL_ITEMS) items = items.slice(-MAX_INITIAL_ITEMS)
        if (items.length > 0 || reset) {
          onItems(items, { reset, tail: items.at(-1)?.cursor })
        }
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
