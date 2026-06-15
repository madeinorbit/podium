import { open } from 'node:fs/promises'
import type { TranscriptItem } from '@podium/protocol'
import { LineDecoder } from '../jsonl-stream.js'
import { claudeRecordToItems } from './claude.js'

const POLL_MS = 700
// Initial-read cap: a long-running transcript can be hundreds of MB, but the
// chat view only needs the recent tail. Seek to the last TAIL_BYTES on the first
// read instead of slurping the whole file (which spiked daemon memory on every
// live session at reattach). Deltas after the first read are tiny.
//
// 8 MB (was 512 KB): the old window dropped the *beginning* of any conversation
// past a few hundred turns, so the chat view opened mid-thread. 8 MB covers all
// but the most marathon sessions whole, while still bounding the reattach read.
const TAIL_BYTES = 8 * 1024 * 1024
// First read may still surface many items within the tail window; keep the most
// recent so a freshly-mounted chat view isn't handed an unbounded backlog. Kept
// in step with the server's per-session transcript buffer (MAX_TRANSCRIPT_ITEMS).
const MAX_INITIAL_ITEMS = 8000

export interface TranscriptTailer {
  /** The file currently tailed. */
  readonly path: string
  stop(): void
}

export interface TranscriptTailOptions {
  pollMs?: number
  /** Maps one decoded JSONL record to zero or more normalized chat items. */
  recordToItems?: (record: unknown) => TranscriptItem[]
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
          try {
            items = items.concat(recordToItems(JSON.parse(trimmed)))
          } catch {
            // torn write — skip the line
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
