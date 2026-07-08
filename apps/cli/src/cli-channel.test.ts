import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '@podium/core/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyChannel } from './cli-channel'

describe('applyChannel', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-channel-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    delete process.env.PODIUM_STATE_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the current channel (default stable) with no arg', () => {
    expect(applyChannel()).toEqual({ channel: 'stable' })
  })
  it('sets and persists the channel', () => {
    expect(applyChannel('edge')).toEqual({ channel: 'edge' })
    expect(loadConfig().updateChannel).toBe('edge')
    expect(applyChannel()).toEqual({ channel: 'edge' })
  })
  it('throws on an unknown channel', () => {
    expect(() => applyChannel('beta')).toThrow()
  })
})
