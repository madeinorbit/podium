import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor } from './cursor-codec.js'

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
