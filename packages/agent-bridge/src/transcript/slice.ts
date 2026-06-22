import { open } from 'node:fs/promises'
import type { TranscriptItem } from '@podium/protocol'
import { recordUuid, stampCursors } from './cursor-codec.js'

export interface SliceResult {
  items: TranscriptItem[]
  head?: string
  tail?: string
  hasMore: boolean
}

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
