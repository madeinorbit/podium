import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { compareCursorPositions, cursorInsertionIndex, decodeCursorPosition } from './cursor-order'

/** The encoder this decoder must track: packages/transcript/src/cursor-codec.ts
 *  stamps `base64url(JSON([fileId, offset, uuid, sub]))` on every item. */
function encodeCursor(fileId: string, offset: number, uuid: string | null, sub: number): string {
  return Buffer.from(JSON.stringify([fileId, offset, uuid, sub]), 'utf8').toString('base64url')
}

const at = (cursor?: string): TranscriptItem => ({
  id: cursor ?? 'x',
  role: 'assistant',
  text: '',
  ...(cursor ? { cursor } : {}),
})

describe('decodeCursorPosition', () => {
  it('round-trips what the transcript package encodes', () => {
    expect(decodeCursorPosition(encodeCursor('a1b2c3d4e5f6', 4096, 'uuid-1', 2))).toEqual({
      fileId: 'a1b2c3d4e5f6',
      offset: 4096,
      sub: 2,
    })
  })

  // base64 emits 4 chars per 3 bytes and base64url strips the padding, so the
  // decoder has to handle every remainder length. Payload length is driven by the
  // offset digits here.
  it('decodes at every padding remainder', () => {
    for (const offset of [0, 1, 12, 123, 1234, 12345, 123456]) {
      expect(decodeCursorPosition(encodeCursor('f0f0f0f0f0f0', offset, null, 0))?.offset).toBe(
        offset,
      )
    }
  })

  it('returns null for anything that is not a Podium cursor', () => {
    expect(decodeCursorPosition(undefined)).toBeNull()
    expect(decodeCursorPosition('')).toBeNull()
    expect(decodeCursorPosition('c1')).toBeNull() // a synthesized id / test stub
    expect(decodeCursorPosition('!!!not base64!!!')).toBeNull()
    expect(decodeCursorPosition(Buffer.from('not json', 'utf8').toString('base64url'))).toBeNull()
    // Right shape, wrong arity/types → not ours.
    expect(decodeCursorPosition(Buffer.from('[1,2,3]', 'utf8').toString('base64url'))).toBeNull()
    expect(
      decodeCursorPosition(Buffer.from('["f","x",null,0]', 'utf8').toString('base64url')),
    ).toBeNull()
  })
})

describe('compareCursorPositions', () => {
  it('orders by byte offset, then by sub-index within one record', () => {
    const p = (offset: number, sub: number) => ({ fileId: 'f', offset, sub })
    expect(compareCursorPositions(p(10, 0), p(20, 0))).toBeLessThan(0)
    expect(compareCursorPositions(p(20, 0), p(20, 1))).toBeLessThan(0)
    expect(compareCursorPositions(p(20, 1), p(20, 1))).toBe(0)
  })
})

describe('cursorInsertionIndex', () => {
  const c = (offset: number) => encodeCursor('f1', offset, null, 0)

  it('appends (-1) when the item is newer than everything held — the live-tail case', () => {
    expect(cursorInsertionIndex([at(c(100)), at(c(200))], at(c(300)))).toBe(-1)
  })

  it('finds the slot for an item older than the tail', () => {
    expect(cursorInsertionIndex([at(c(100)), at(c(300))], at(c(200)))).toBe(1)
    expect(cursorInsertionIndex([at(c(200)), at(c(300))], at(c(100)))).toBe(0)
  })

  it('appends when the cursors do not decode (opaque ids, stubs)', () => {
    expect(cursorInsertionIndex([at('c1'), at('c2')], at('c3'))).toBe(-1)
    expect(cursorInsertionIndex([at(c(100))], at(undefined))).toBe(-1)
  })

  it('ignores items from other files — a roll makes the new file newer', () => {
    const other = encodeCursor('f2', 0, null, 0)
    expect(cursorInsertionIndex([at(c(100)), at(c(200))], at(other))).toBe(-1)
    // …and an item of the held file still finds its place past the foreign ones.
    expect(cursorInsertionIndex([at(c(100)), at(other), at(c(300))], at(c(200)))).toBe(2)
  })
})
