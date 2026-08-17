import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '@podium/runtime/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyChannel } from './cli-channel'

const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('applyChannel', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-channel-'))
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    process.env.PODIUM_STATE_DIR = priorStateDir
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
  /**
   * POD-2196. `dev` is a channel the rest of the product already has: the config
   * schema accepts it, `FleetUpdateChannel` names it, and it is the ONLY channel
   * a source checkout's own target is ever published on. Refusing it here left a
   * source machine pinned to `stable`, where that target never applies, and the
   * only way to reach it was the `PODIUM_UPDATE_CHANNEL` env var.
   */
  it('pins a source machine to the development channel', () => {
    expect(applyChannel('dev')).toEqual({ channel: 'dev' })
    expect(loadConfig().updateChannel).toBe('dev')
    expect(applyChannel()).toEqual({ channel: 'dev' })
  })
  it('throws on an unknown channel', () => {
    expect(() => applyChannel('beta')).toThrow()
  })
  it('names every channel it accepts when it refuses one', () => {
    expect(() => applyChannel('beta')).toThrow(/stable \| edge \| dev/)
  })
})
