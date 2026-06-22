import type { TranscriptItem } from '@podium/protocol'

export interface CursorParts {
  /** Stable id of the JSONL file this item's record lives in. */
  fileId: string
  /** Byte offset of the start of the record's line within that file. */
  offset: number
  /** The record's JSONL `uuid` if present, for drift validation; null otherwise. */
  uuid: string | null
  /** Index of this item among the items the record produced (0-based). */
  sub: number
}

export function encodeCursor(p: CursorParts): string {
  const json = JSON.stringify([p.fileId, p.offset, p.uuid, p.sub])
  return Buffer.from(json, 'utf8').toString('base64url')
}

export function decodeCursor(c: string): CursorParts | null {
  if (!c) return null
  try {
    const arr = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'))
    if (!Array.isArray(arr) || arr.length !== 4) return null
    const [fileId, offset, uuid, sub] = arr
    if (typeof fileId !== 'string' || typeof offset !== 'number' || typeof sub !== 'number')
      return null
    if (uuid !== null && typeof uuid !== 'string') return null
    return { fileId, offset, uuid, sub }
  } catch {
    return null
  }
}

export function stampCursors(
  items: TranscriptItem[],
  fileId: string,
  offset: number,
  uuid: string | null,
): TranscriptItem[] {
  return items.map((item, sub) => ({
    ...item,
    cursor: encodeCursor({ fileId, offset, uuid, sub }),
  }))
}

export function recordUuid(record: unknown): string | null {
  if (
    record &&
    typeof record === 'object' &&
    typeof (record as { uuid?: unknown }).uuid === 'string'
  ) {
    return (record as { uuid: string }).uuid
  }
  return null
}
