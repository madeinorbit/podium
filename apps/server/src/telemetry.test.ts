/**
 * Server telemetry wiring tests [spec:SP-f933].
 *
 * The load-bearing claim here is negative: with no consent, driving the bus
 * hard produces NOTHING on disk. The second claim is that a telemetry failure
 * cannot reach a user-visible path — the bus isolates listeners, so a thrown
 * emitter must not break the session spawn that emitted the event.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '@podium/runtime/config'
import { readQueue, readWindow } from '@podium/telemetry'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventBus } from './modules/bus'
import { wireTelemetry } from './telemetry'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-server-telemetry-'))
  process.env.PODIUM_STATE_DIR = dir
})
afterEach(() => {
  delete process.env.PODIUM_STATE_DIR
  rmSync(dir, { recursive: true, force: true })
})

const wire = (bus: EventBus) =>
  wireTelemetry({ bus, machineCount: () => 2, stateDir: dir, installRoot: '/opt/podium' })

describe('no consent = no collection, however hard the bus is driven', () => {
  it('records nothing when telemetry was never asked about', () => {
    saveConfig({ mode: 'all-in-one' })
    const bus = new EventBus()
    const t = wire(bus)
    for (let i = 0; i < 50; i++) {
      bus.emit('session.created', { sessionId: `s${i}`, agentKind: 'claude-code' })
      bus.emit('issue.updated', { issue: { id: `i${i}` } as never })
    }
    expect(readWindow(dir)).toBeUndefined()
    expect(readQueue(dir)).toEqual([])
    t.stop()
  })

  it('records nothing when usage is explicitly off', () => {
    saveConfig({ mode: 'all-in-one', telemetry: { usage: 'off', crash: 'off' } })
    const bus = new EventBus()
    const t = wire(bus)
    bus.emit('session.created', { sessionId: 's1', agentKind: 'codex' })
    expect(readWindow(dir)).toBeUndefined()
    t.stop()
  })

  it('records nothing under DO_NOT_TRACK even with consent stored', () => {
    process.env.DO_NOT_TRACK = '1'
    try {
      saveConfig({
        mode: 'all-in-one',
        telemetry: { usage: 'on', installId: '3f9c1a2e-0000-4000-8000-000000000000' },
      })
      const bus = new EventBus()
      const t = wire(bus)
      bus.emit('session.created', { sessionId: 's1', agentKind: 'codex' })
      expect(readWindow(dir)).toBeUndefined()
      t.stop()
    } finally {
      delete process.env.DO_NOT_TRACK
    }
  })
})

describe('with consent', () => {
  beforeEach(() => {
    saveConfig({
      mode: 'all-in-one',
      telemetry: {
        usage: 'on',
        installId: '3f9c1a2e-0000-4000-8000-000000000000',
        since: Date.now() - 86_400_000,
      },
    })
  })

  it('counts sessions per harness kind', () => {
    const bus = new EventBus()
    const t = wire(bus)
    bus.emit('session.created', { sessionId: 's1', agentKind: 'claude-code' })
    bus.emit('session.created', { sessionId: 's2', agentKind: 'claude-code' })
    bus.emit('session.created', { sessionId: 's3', agentKind: 'codex' })
    expect(readWindow(dir)?.sessions).toEqual({ 'claude-code': 2, codex: 1 })
    t.stop()
  })

  it('marks the issues feature from any issue mutation, and only once', () => {
    const bus = new EventBus()
    const t = wire(bus)
    bus.emit('issue.updated', { issue: { id: 'i1' } as never })
    bus.emit('issue.updated', { issue: { id: 'i2' } as never })
    expect(readWindow(dir)?.features).toEqual(['issues'])
    t.stop()
  })

  it('builds a report whose machines gauge is read at build time, not cached', () => {
    let machines = 1
    const bus = new EventBus()
    const t = wireTelemetry({
      bus,
      machineCount: () => machines,
      stateDir: dir,
      installRoot: '/opt/podium',
    })
    expect(t.emitter.buildUsageReport()).toMatchObject({ machines: '1' })
    machines = 9
    expect(t.emitter.buildUsageReport()).toMatchObject({ machines: '6-20' })
    t.stop()
  })

  it('stop() unsubscribes — a stopped emitter counts nothing', () => {
    const bus = new EventBus()
    const t = wire(bus)
    t.stop()
    bus.emit('session.created', { sessionId: 's1', agentKind: 'codex' })
    expect(readWindow(dir)?.sessions ?? {}).toEqual({})
  })
})

describe('a telemetry failure never reaches a user-visible path', () => {
  it('a throwing listener cannot break the emitter or its siblings', () => {
    saveConfig({ mode: 'all-in-one' })
    const bus = new EventBus()
    const t = wire(bus)
    let sibling = 0
    bus.on('session.created', () => {
      sibling++
    })
    bus.on('session.created', () => {
      throw new Error('boom')
    })
    // The bus isolates per-listener; the spawn path that emits sees nothing.
    expect(() => bus.emit('session.created', { sessionId: 's1', agentKind: 'codex' })).not.toThrow()
    expect(sibling).toBe(1)
    t.stop()
  })
})
