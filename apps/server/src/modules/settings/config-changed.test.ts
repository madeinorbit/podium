/**
 * `config.changed` on the bus (POD-3840).
 *
 * `@podium/runtime` sits below this bus — the CLI and the daemon load it too —
 * so a config write announces itself through a plain in-process seam and the
 * server bridges that seam onto its own event. These tests pin the bridge and
 * the one thing it has to be careful about: a transfer writes a CANDIDATE config
 * to a temporary file beside the real one, and that is not a change to this
 * instance's configuration.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configPath, saveConfig } from '@podium/runtime/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus } from '../bus'
import { bridgeConfigChanged } from './service'

describe('config.changed bridge', () => {
  let dir: string
  let priorStateDir: string | undefined

  beforeEach(() => {
    priorStateDir = process.env.PODIUM_STATE_DIR
    dir = mkdtempSync(join(tmpdir(), 'podium-config-changed-'))
    process.env.PODIUM_STATE_DIR = dir
  })

  afterEach(() => {
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('publishes a write to the live config as config.changed', () => {
    const bus = new EventBus()
    const seen: { previous: unknown; next: unknown }[] = []
    bus.on('config.changed', (payload) => {
      seen.push(payload)
    })
    const stop = bridgeConfigChanged(bus)
    try {
      saveConfig({ mode: 'server', port: 18787 })
      saveConfig({ mode: 'server', port: 19999 })
    } finally {
      stop()
    }

    expect(seen).toHaveLength(2)
    expect(seen[0]?.previous).toEqual({})
    expect(seen[0]?.next).toEqual(expect.objectContaining({ port: 18787 }))
    expect(seen[1]?.previous).toEqual(expect.objectContaining({ port: 18787 }))
    expect(seen[1]?.next).toEqual(expect.objectContaining({ port: 19999 }))
  })

  it('ignores a candidate config saved to a temporary path', () => {
    const bus = new EventBus()
    const seen: unknown[] = []
    bus.on('config.changed', (payload) => {
      seen.push(payload)
    })
    const stop = bridgeConfigChanged(bus)
    try {
      // The shape `transfer-lifecycle` writes before its atomic rename, and the
      // shape it writes to preserve the OUTGOING config as a backup. Announcing
      // either would tell every subscriber this instance had been reconfigured
      // when nothing had moved yet — and the backup would announce it BACKWARDS.
      saveConfig({ mode: 'server', port: 19999 }, join(dir, '.config-transfer-1.tmp'))
    } finally {
      stop()
    }

    expect(seen).toEqual([])
    expect(configPath()).toBe(join(dir, 'config.json'))
  })

  it('stops publishing once the bridge is disposed', () => {
    const bus = new EventBus()
    const seen: unknown[] = []
    bus.on('config.changed', (payload) => {
      seen.push(payload)
    })
    bridgeConfigChanged(bus)()

    saveConfig({ mode: 'server', port: 18787 })

    expect(seen).toEqual([])
  })
})
