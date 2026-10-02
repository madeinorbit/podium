import { describe, expect, it, vi } from 'vitest'
import { createHostDiskSampler, parseMeminfo, sampleHostDisk, sampleHostLoad, sampleHostMemory } from './host-metrics'

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

describe('heartbeat disk sampling budget', () => {
  it('reuses one reading across heartbeats and refreshes it after a minute', () => {
    let now = 0
    const first = { path: '/synthetic', totalBytes: 100, usedBytes: 54, availableBytes: 36 }
    const second = { ...first, usedBytes: 63, availableBytes: 27 }
    const sample = vi.fn().mockReturnValueOnce(first).mockReturnValue(second)
    const read = createHostDiskSampler(sample, () => now)
    expect(read()).toBe(first)
    for (now = 5_000; now < 60_000; now += 5_000) expect(read()).toBe(first)
    expect(sample).toHaveBeenCalledTimes(1)
    expect(read()).toBe(second)
    expect(sample).toHaveBeenCalledTimes(2)
  })

  it('caches an unavailable sample and retries after a minute', () => {
    let now = 0
    const sample = vi.fn(() => undefined)
    const read = createHostDiskSampler(sample, () => now)
    expect(read()).toBeUndefined()
    now = 59_999
    expect(read()).toBeUndefined()
    expect(sample).toHaveBeenCalledTimes(1)
    now = 60_000
    expect(read()).toBeUndefined()
    expect(sample).toHaveBeenCalledTimes(2)
  })
})
