import { describe, expect, it } from 'vitest'
import { parseMeminfo, sampleHostDisk, sampleHostLoad, sampleHostMemory } from './host-metrics'

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

describe('sampleHostLoad', () => {
  it('produces non-negative averages and at least one core', () => {
    const load = sampleHostLoad()
    expect(load.one).toBeGreaterThanOrEqual(0)
    expect(load.five).toBeGreaterThanOrEqual(0)
    expect(load.fifteen).toBeGreaterThanOrEqual(0)
    expect(load.cpuCount).toBeGreaterThanOrEqual(1)
  })
})

describe('sampleHostDisk', () => {
  it('produces a schema-valid sample of the volume a path sits on', () => {
    const d = sampleHostDisk()
    // Every platform CI runs on has statfs; a host without it is the undefined
    // branch below, and there is nothing to assert about the numbers then.
    if (!d) return
    expect(d.totalBytes).toBeGreaterThan(0)
    expect(d.usedBytes).toBeGreaterThanOrEqual(0)
    expect(d.availableBytes).toBeGreaterThanOrEqual(0)
    // used + available may fall SHORT of total (the root reserve) but can never
    // exceed it — the invariant the panel's percentage rests on.
    expect(d.usedBytes + d.availableBytes).toBeLessThanOrEqual(d.totalBytes)
    expect(d.path).toBeTruthy()
  })

  it('falls back to the root volume when the path itself cannot be read', () => {
    const d = sampleHostDisk('/nonexistent/path/for/this/test')
    if (!d) return
    expect(d.path).toBe('/')
    expect(d.totalBytes).toBeGreaterThan(0)
  })
})
