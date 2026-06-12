import { open } from 'node:fs/promises'
import type { TranscriptItem } from '@podium/protocol'
import { claudeRecordToItems } from './claude.js'

const POLL_MS = 700
// First read of a large transcript: parse everything but emit only the most
// recent items — the chat view doesn't need a 50k-line history dump.
const MAX_INITIAL_ITEMS = 1500

export interface TranscriptTailer {
  /** The file currently tailed. */
  readonly path: string
  stop(): void
}

/**
 * Poll-tail a Claude transcript JSONL file, emitting parsed TranscriptItems as
 * the agent appends. Polling (not fs.watch) on purpose: editors/agents do
 * atomic-rename writes that confuse watchers, and a 700ms poll of one stat is
 * cheap. Handles truncation (size shrink → start over with reset=true).
 */
export function tailTranscript(
  path: string,
  onItems: (items: TranscriptItem[], reset: boolean) => void,
  opts: { pollMs?: number } = {},
): TranscriptTailer {
  let offset = 0
  let partial = ''
  let first = true
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
        if (size < offset) {
          // Truncated/replaced — re-read from the top and tell consumers to clear.
          offset = 0
          partial = ''
          reset = true
        }
        if (size === offset) {
          if (reset) onItems([], true)
          return
        }
        const buffer = Buffer.alloc(size - offset)
        await handle.read(buffer, 0, buffer.length, offset)
        offset = size
        const text = partial + buffer.toString('utf8')
        const lines = text.split('\n')
        partial = lines.pop() ?? '' // trailing partial line waits for its newline
        let items: TranscriptItem[] = []
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            items = items.concat(claudeRecordToItems(JSON.parse(trimmed)))
          } catch {
            // torn write — skip the line
          }
        }
        if (first) {
          reset = true
          if (items.length > MAX_INITIAL_ITEMS) items = items.slice(-MAX_INITIAL_ITEMS)
          first = false
        }
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
