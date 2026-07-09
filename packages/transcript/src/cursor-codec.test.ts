import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, recordUuid, stampCursors } from './cursor-codec'

describe('cursor codec', () => {
  it('round-trips parts', () => {
    const parts = { fileId: 'a1b2', offset: 4096, uuid: 'ddce65b9-03a7', sub: 2 }
    expect(decodeCursor(encodeCursor(parts))).toEqual(parts)
  })
  it('round-trips a null uuid', () => {
    const parts = { fileId: 'a1b2', offset: 0, uuid: null, sub: 0 }
    expect(decodeCursor(encodeCursor(parts))).toEqual(parts)
  })
  it('is opaque (no raw path/uuid substring leakage by accident is fine, but must be base64url)', () => {
    expect(encodeCursor({ fileId: 'f', offset: 1, uuid: null, sub: 0 })).toMatch(/^[A-Za-z0-9_-]+$/)
  })
  it('returns null on malformed input', () => {
    expect(decodeCursor('not-base64-$$$')).toBeNull()
    expect(decodeCursor('')).toBeNull()
  })
})

describe('stampCursors', () => {
  it('stamps a distinct cursor per sub-index, all sharing file+offset', () => {
    const items = [
      { id: 'x', role: 'user', text: 'a' },
      { id: 'y', role: 'tool', text: '', toolResult: 'r' },
    ] as unknown as TranscriptItem[]
    const out = stampCursors(items, 'file1', 100, 'uuid-1')
    const [a, b] = out as [TranscriptItem, TranscriptItem]
    expect(a.cursor).not.toEqual(b.cursor)
    expect(decodeCursor(a.cursor as string)).toEqual({
      fileId: 'file1',
      offset: 100,
      uuid: 'uuid-1',
      sub: 0,
    })
    expect(decodeCursor(b.cursor as string)).toEqual({
      fileId: 'file1',
      offset: 100,
      uuid: 'uuid-1',
      sub: 1,
    })
  })
  it('does not mutate input items', () => {
    const items = [{ id: 'x', role: 'user', text: 'a' }] as unknown as TranscriptItem[]
    stampCursors(items, 'f', 0, null)
    expect(items[0]?.cursor).toBeUndefined()
  })
})

describe('recordUuid', () => {
  it('reads uuid when present, null otherwise', () => {
    expect(recordUuid({ uuid: 'abc' })).toBe('abc')
    expect(recordUuid({ type: 'attachment' })).toBeNull()
    expect(recordUuid('nope')).toBeNull()
  })
})
