import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the process-spawning layer so we can count `opencode --version` probes.
// POD-192: the live daemon showed repeated synchronous probes (one per targeted
// discovery refresh) burning CPU — availability must be cached between calls.
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}))
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
}))

import { spawnSync } from 'node:child_process'
import { isOpencodeCliAvailable, resetOpencodeCliCache } from './cli.js'

describe('opencode CLI availability cache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetOpencodeCliCache()
    vi.mocked(spawnSync).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('spawns --version once and serves repeat calls from cache', () => {
    expect(isOpencodeCliAvailable()).toBe(true)
    const probesAfterFirst = vi.mocked(spawnSync).mock.calls.length
    expect(probesAfterFirst).toBeGreaterThan(0)

    for (let i = 0; i < 10; i++) expect(isOpencodeCliAvailable()).toBe(true)
    expect(vi.mocked(spawnSync).mock.calls.length).toBe(probesAfterFirst)
  })

  it('re-probes after the TTL expires', () => {
    isOpencodeCliAvailable()
    const probesAfterFirst = vi.mocked(spawnSync).mock.calls.length

    vi.advanceTimersByTime(61_000)
    isOpencodeCliAvailable()
    expect(vi.mocked(spawnSync).mock.calls.length).toBeGreaterThan(probesAfterFirst)
  })

  it('caches an unavailable result too (no probe storm when opencode is absent)', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: '' } as never)
    resetOpencodeCliCache()
    vi.mocked(spawnSync).mockClear()

    expect(isOpencodeCliAvailable()).toBe(false)
    const probesAfterFirst = vi.mocked(spawnSync).mock.calls.length
    expect(isOpencodeCliAvailable()).toBe(false)
    expect(vi.mocked(spawnSync).mock.calls.length).toBe(probesAfterFirst)
  })
})
