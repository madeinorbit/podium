import { describe, expect, it } from 'vitest'
import { uploadsToGc } from './uploads-gc'

describe('uploadsToGc', () => {
  it('collects files older than the ttl', () => {
    const now = 1_000_000
    const files = [{ path: 'a', mtimeMs: now - 1000 }, { path: 'b', mtimeMs: now - 90_000_000 }]
    expect(uploadsToGc(files, now, 24 * 3600_000)).toEqual(['b'])
  })

  it('returns empty array when no files exceed ttl', () => {
    const now = 1_000_000
    const files = [{ path: 'a', mtimeMs: now - 1000 }]
    expect(uploadsToGc(files, now, 24 * 3600_000)).toEqual([])
  })

  it('returns all files when all exceed ttl', () => {
    const now = 100_000_000
    const files = [
      { path: 'x', mtimeMs: now - 90_000_000 },
      { path: 'y', mtimeMs: now - 86_400_001 },
    ]
    expect(uploadsToGc(files, now, 24 * 3600_000)).toEqual(['x', 'y'])
  })

  it('treats a file exactly at the ttl boundary as NOT expired', () => {
    const now = 100_000_000
    const ttl = 24 * 3600_000
    const files = [{ path: 'edge', mtimeMs: now - ttl }]
    // now - mtime === ttl → NOT > ttl → not collected
    expect(uploadsToGc(files, now, ttl)).toEqual([])
  })

  it('handles an empty file list', () => {
    expect(uploadsToGc([], 1_000_000, 24 * 3600_000)).toEqual([])
  })
})
