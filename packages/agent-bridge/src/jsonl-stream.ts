/**
 * Incremental newline splitter for byte streams. Decodes only up to the last
 * newline in each chunk and keeps the trailing bytes as a Buffer, so a
 * multi-byte UTF-8 character that straddles a read/chunk boundary is reassembled
 * instead of being split into two replacement characters.
 *
 * (Safe because 0x0A only ever appears as a standalone line feed in UTF-8 —
 * lead and continuation bytes are all >= 0x80 — so scanning for the 0x0A byte
 * never lands inside a multi-byte sequence.)
 */
export class LineDecoder {
  private leftover: Buffer = Buffer.alloc(0)

  /** Feed bytes; returns the complete lines now available (without trailing \n). */
  push(chunk: Buffer): string[] {
    const combined = this.leftover.length > 0 ? Buffer.concat([this.leftover, chunk]) : chunk
    const lastNl = combined.lastIndexOf(0x0a)
    if (lastNl === -1) {
      this.leftover = combined
      return []
    }
    const text = combined.subarray(0, lastNl).toString('utf8')
    this.leftover = combined.subarray(lastNl + 1)
    return text.split('\n')
  }

  /** The final unterminated line once the stream ends (null if none). */
  flush(): string | null {
    if (this.leftover.length === 0) return null
    const s = this.leftover.toString('utf8')
    this.leftover = Buffer.alloc(0)
    return s
  }

  /** Discard any buffered bytes (e.g. the source file was truncated/replaced). */
  reset(): void {
    this.leftover = Buffer.alloc(0)
  }
}
