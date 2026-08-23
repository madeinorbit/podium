import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the process-spawning layer so the resolver’s child environment is observable.
// These tests use a fixture home and never inspect the host installation.
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' } as never)),
}))
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
}))

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { isOpencodeCliAvailable, resolveOpencodeBin } from './cli.js'

const fixtureHome = '/fixture/home'
const fixtureEnv = Object.freeze({ HOME: fixtureHome, PATH: '/fixture/bin', PODIUM_NO_RELAY: '1' })

describe('opencode CLI environment', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset()
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '' } as never)
  })

  it('probes the fixture executable with the explicit environment', () => {
    const binary = join(fixtureHome, '.opencode', 'bin', 'opencode')
    expect(resolveOpencodeBin(fixtureHome, fixtureEnv)).toBe(binary)
    expect(isOpencodeCliAvailable(fixtureHome, fixtureEnv)).toBe(true)
    expect(spawnSync).toHaveBeenCalledWith(binary, ['--version'], {
      stdio: 'ignore',
      env: expect.objectContaining(fixtureEnv),
    })
  })

  it('passes the explicit environment to every availability probe', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: '' } as never)
    expect(isOpencodeCliAvailable(fixtureHome, fixtureEnv)).toBe(false)
    for (const [, , options] of vi.mocked(spawnSync).mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({
          env: expect.objectContaining(fixtureEnv),
        }),
      )
    }
  })
})
