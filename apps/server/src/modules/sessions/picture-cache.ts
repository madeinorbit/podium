/**
 * THE LATEST PICTURE AND THE BYTES AFTER IT — one session's catch-up cache
 * (POD-4912, POD-3190 design rev 5).
 *
 * The host puts pictures of its screen into its own output stream. The server
 * keeps the latest one and the output after it: a viewer that missed anything
 * gets exactly that, never history.
 *
 * EVERY BYTE HAS AN ABSOLUTE OFFSET in the session's output stream, and a
 * picture sits at the offset it was taken at. A serve in flight reads its tail
 * by offset (E5), so a cut that replaces the picture mid-serve neither skips
 * nor repeats a byte: the chunks such a reader still needs stay until it has
 * read them, or until the cap takes them.
 *
 * THE CAP. The tail after the picture is bounded by max(256 KiB, 2x the
 * picture); past it the picture is useless (a fresh one is cheaper than the
 * tail) and the whole cache is dropped. What readers still hold before the
 * picture counts against the same bound, so memory is at most the picture
 * plus one cap per session.
 */

import { createLogger } from '@podium/logger'

const log = createLogger('server:sessions:pictures')

/** The floor of the tail cap: several screens of a TUI's output. */
export const PICTURE_TAIL_FLOOR_BYTES = 256 * 1024

export interface CachedPicture {
  /** The server sequence number this picture was given. */
  readonly seq: number
  /** Where in the output stream it was taken: the first tail byte's offset. */
  readonly at: number
  readonly cols: number
  readonly rows: number
  readonly bytes: Buffer
}

interface TailChunk {
  readonly at: number
  readonly seq: number
  readonly bytes: Buffer
}

/** A serve in flight: where it has read the tail up to. */
export interface TailReader {
  pos: number
}

/** What the tail holds at a reader's position. */
export type TailRead =
  | { kind: 'bytes'; seq: number; bytes: Buffer }
  | { kind: 'end' }
  | { kind: 'evicted' }

/** Largest tail slice one read hands back: one client frame. */
const MAX_READ_BYTES = 64 * 1024

export class PictureCache {
  private current: CachedPicture | undefined
  private chunks: TailChunk[] = []
  /** Offset of the end of the output stream: every byte ever accepted. */
  private end = 0
  private readonly readers = new Set<TailReader>()

  constructor(private readonly sessionId: string) {}

  get picture(): CachedPicture | undefined {
    return this.current
  }

  /** The cap for the current picture's tail. */
  private cap(): number {
    return Math.max(PICTURE_TAIL_FLOOR_BYTES, 2 * (this.current?.bytes.byteLength ?? 0))
  }

  /** Output the server accepted, in stream order. */
  appendData(seq: number, bytes: Uint8Array): void {
    const at = this.end
    this.end += bytes.byteLength
    // Nothing to serve from and nobody reading: keep nothing.
    if (!this.current && this.readers.size === 0) return
    // Own the payload: a decoded envelope is a view into the whole frame.
    this.chunks.push({ at, seq, bytes: Buffer.from(bytes) })
    this.trim()
  }

  /** A picture from the host, at the current end of the stream. */
  putPicture(seq: number, cols: number, rows: number, bytes: Uint8Array): CachedPicture {
    const picture: CachedPicture = { seq, at: this.end, cols, rows, bytes: Buffer.from(bytes) }
    this.current = picture
    this.trim()
    return picture
  }

  /** Drop the picture and every byte nobody is reading. */
  drop(reason: 'detach' | 'unbound' | 'cap'): void {
    if (this.current || this.chunks.length > 0)
      log.debug('cache dropped', { sessionId: this.sessionId, reason })
    this.current = undefined
    this.chunks = []
  }

  /** Start reading the tail of `picture` (which must be the current one). */
  openReader(picture: CachedPicture): TailReader {
    const reader = { pos: picture.at }
    this.readers.add(reader)
    return reader
  }

  closeReader(reader: TailReader): void {
    this.readers.delete(reader)
    this.trim()
  }

  /** The next slice of the tail at this reader's position. */
  read(reader: TailReader): TailRead {
    if (reader.pos === this.end) return { kind: 'end' }
    const first = this.chunks[0]
    if (!first || reader.pos < first.at) return { kind: 'evicted' }
    // Chunks are contiguous and a reader always stops on a chunk boundary.
    let index = 0
    while (index < this.chunks.length && (this.chunks[index] as TailChunk).at < reader.pos) index++
    const parts: Buffer[] = []
    let bytes = 0
    let seq = 0
    for (; index < this.chunks.length; index++) {
      const chunk = this.chunks[index] as TailChunk
      if (parts.length > 0 && bytes + chunk.bytes.byteLength > MAX_READ_BYTES) break
      parts.push(chunk.bytes)
      bytes += chunk.bytes.byteLength
      seq = chunk.seq
    }
    reader.pos += bytes
    return {
      kind: 'bytes',
      seq,
      bytes: parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, bytes),
    }
  }

  /**
   * Keep what a reader still needs and what the current picture's tail is;
   * bound it all by the cap. A picture whose tail no longer fits is dropped.
   */
  private trim(): void {
    let keepFrom = this.current?.at ?? this.end
    for (const reader of this.readers) keepFrom = Math.min(keepFrom, reader.pos)
    while (this.chunks.length > 0) {
      const head = this.chunks[0] as TailChunk
      const over = this.end - head.at > this.cap()
      if (head.at + head.bytes.byteLength > keepFrom && !over) break
      this.chunks.shift()
    }
    const retainedFrom = this.chunks[0]?.at ?? this.end
    if (this.current && this.current.at < retainedFrom) {
      log.debug('cache dropped', {
        sessionId: this.sessionId,
        reason: 'cap',
        tailBytes: this.end - this.current.at,
        pictureBytes: this.current.bytes.byteLength,
      })
      this.current = undefined
      if (this.readers.size === 0) this.chunks = []
    }
  }
}
