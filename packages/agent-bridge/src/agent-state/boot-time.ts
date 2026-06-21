import { open, stat } from 'node:fs/promises'

/**
 * A file's mtime as an ISO string — a coarse event-time for boot classification.
 * CAUTION: mtime is unreliable for harnesses that append timestamp-less metadata on
 * resume/reattach (e.g. Claude's `bridge-session`/`mode` markers bump the mtime to
 * "now" without being activity). Prefer `lastTimestampedRecordIso` for JSONL whose
 * records carry timestamps; mtime is the fallback only where they don't (Grok,
 * Cursor). Returns undefined when the file is missing/unreadable.
 */
export async function fileMtimeIso(path: string): Promise<string | undefined> {
  try {
    return (await stat(path)).mtime.toISOString()
  } catch {
    return undefined
  }
}

const TAIL_BYTES = 256 * 1024

/**
 * The `timestamp` of the last JSONL record that actually carries one, scanning from
 * the end of the file. This is the true last-activity time even when the harness has
 * appended timestamp-less metadata records afterward (which bump the file mtime but
 * are not activity). Reads only the tail. Undefined if none found / unreadable.
 */
export async function lastTimestampedRecordIso(path: string): Promise<string | undefined> {
  try {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      if (size === 0) return undefined
      const start = Math.max(0, size - TAIL_BYTES)
      const buf = Buffer.alloc(size - start)
      await handle.read(buf, 0, buf.length, start)
      const lines = buf.toString('utf8').split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim()
        if (!line) continue
        try {
          const ts = (JSON.parse(line) as { timestamp?: unknown }).timestamp
          if (typeof ts === 'string' && ts.length > 0) return ts
        } catch {
          // Torn first line (we seeked mid-file) or non-JSON — skip.
        }
      }
      return undefined
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}
