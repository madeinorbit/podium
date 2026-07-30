import type { TranscriptItem } from '@podium/model'

/**
 * Transcript order from cursors alone [POD-341/POD-343].
 *
 * A live transcript frame is NOT always newer than what a client already holds:
 * the server replays its whole per-session transcript cache to a (re)subscribing
 * client whose `since` cursor it can't find — routine after a transcript file
 * roll or a dropped socket — so a frame can carry items that belong ABOVE the
 * held tail. A client that appends whatever it hasn't seen renders a reply above
 * the message that produced it.
 *
 * Every item the readers and the live tailer emit is stamped with a cursor
 * encoding `[fileId, offset, uuid, sub]` (packages/transcript/src/cursor-codec.ts),
 * so within one transcript FILE `(offset, sub)` is a total order — the same order
 * the disk reader emits. That is enough to place an item without asking the
 * server anything.
 *
 * Shared by every client that merges deltas (web chat, mobile session chat), so
 * the decoder is dependency-free: no node Buffer, no `atob` (React Native's
 * runtime has neither reliably).
 */

/** Where one item sits in its transcript file. */
export interface CursorPosition {
  fileId: string
  offset: number
  sub: number
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** base64url → the ASCII text it encodes, or null if it isn't valid base64url.
 *  Cursor payloads are pure ASCII JSON, so bytes map straight to characters. */
function decodeBase64Url(value: string): string | null {
  let out = ''
  let bits = 0
  let bitCount = 0
  for (const ch of value) {
    if (ch === '=') break
    const index = B64_ALPHABET.indexOf(ch === '-' ? '+' : ch === '_' ? '/' : ch)
    if (index < 0) return null
    bits = (bits << 6) | index
    bitCount += 6
    if (bitCount >= 8) {
      bitCount -= 8
      const byte = (bits >> bitCount) & 0xff
      if (byte > 0x7f) return null // non-ASCII → not one of our cursors
      out += String.fromCharCode(byte)
    }
  }
  return out
}

/** An item's position, or null when its cursor isn't a Podium cursor (a
 *  synthesized id, a test stub, a future encoding) — callers then fall back to
 *  their append behaviour. */
export function decodeCursorPosition(cursor: string | undefined): CursorPosition | null {
  if (!cursor) return null
  const json = decodeBase64Url(cursor)
  if (json === null || json === '') return null
  let parts: unknown
  try {
    parts = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(parts) || parts.length !== 4) return null
  const [fileId, offset, , sub] = parts as [unknown, unknown, unknown, unknown]
  if (typeof fileId !== 'string' || typeof offset !== 'number' || typeof sub !== 'number')
    return null
  return { fileId, offset, sub }
}

/** Negative when `a` precedes `b` within their (shared) file. */
export function compareCursorPositions(a: CursorPosition, b: CursorPosition): number {
  return a.offset - b.offset || a.sub - b.sub
}

/**
 * Index a NEW item belongs at in `list`, or -1 for "append" — the normal
 * live-tail case, and the fallback whenever the cursors don't decode or the item
 * comes from a file the list doesn't hold yet (a roll: the new file is newer,
 * whatever its offsets). Scans from the tail and stops at the first same-file
 * item that precedes the addition, so an ordinary append costs one comparison.
 */
export function cursorInsertionIndex(list: TranscriptItem[], item: TranscriptItem): number {
  const pos = decodeCursorPosition(item.cursor)
  if (!pos) return -1
  let insertAt = -1
  for (let i = list.length - 1; i >= 0; i--) {
    const other = decodeCursorPosition(list[i]?.cursor)
    if (!other || other.fileId !== pos.fileId) continue
    if (compareCursorPositions(other, pos) < 0) return insertAt // everything earlier is older too
    insertAt = i // this held item is NEWER — the addition goes above it
  }
  return insertAt
}

/** Place `item` in `list` at its cursor position (mutates `list`, which callers
 *  own — both merges build a fresh array first). */
export function insertInCursorOrder(list: TranscriptItem[], item: TranscriptItem): void {
  const at = cursorInsertionIndex(list, item)
  if (at < 0) list.push(item)
  else list.splice(at, 0, item)
}
