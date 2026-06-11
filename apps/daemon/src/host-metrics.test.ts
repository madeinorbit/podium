import { describe, expect, it } from 'vitest'
import { parseMeminfo, sampleHostMemory } from './host-metrics'

const MEMINFO = `MemTotal:       24608580 kB
MemFree:         1360324 kB
MemAvailable:    4418512 kB
Buffers:          123380 kB
Cached:          3023512 kB
SwapCached:        81608 kB
SwapTotal:      25165812 kB
SwapFree:        5448256 kB
`

describe('parseMeminfo', () => {
  it('extracts total/available/swap as bytes (fields are kB)', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      totalBytes: 24608580 * 1024,
      availableBytes: 4418512 * 1024,
      swapTotalBytes: 25165812 * 1024,
      swapFreeBytes: 5448256 * 1024,
    })
  })

  it('returns undefined when MemAvailable is missing (pre-3.14 kernels / garbage)', () => {
    expect(parseMeminfo('MemTotal: 1024 kB\nMemFree: 512 kB\n')).toBeUndefined()
    expect(parseMeminfo('')).toBeUndefined()
  })

  it('treats absent swap lines as zero swap', () => {
    expect(parseMeminfo('MemTotal: 2048 kB\nMemAvailable: 1024 kB\n')).toEqual({
      totalBytes: 2048 * 1024,
      availableBytes: 1024 * 1024,
      swapTotalBytes: 0,
      swapFreeBytes: 0,
    })
  })
})

describe('sampleHostMemory', () => {
  it('produces a schema-valid sample on this machine (proc or os fallback)', () => {
    const m = sampleHostMemory()
    expect(m.totalBytes).toBeGreaterThan(0)
    expect(m.availableBytes).toBeGreaterThan(0)
    expect(m.availableBytes).toBeLessThanOrEqual(m.totalBytes)
    expect(m.swapFreeBytes).toBeLessThanOrEqual(m.swapTotalBytes)
  })

  it('falls back to os totals when meminfo is unreadable', () => {
    const m = sampleHostMemory('/nonexistent/meminfo')
    expect(m.totalBytes).toBeGreaterThan(0)
    expect(m.swapTotalBytes).toBe(0)
  })
})
