import { addSink, createLogger, type LogRecord, resetLogging } from '@podium/logger'
import { afterEach, describe, expect, it } from 'vitest'
import { createSyncTransferTelemetry } from '../sync-stream/transfer-telemetry'
import { installClientLogging } from './install'
import { clientRecoveryId, createScreenReadinessDiagnostic } from './recovery'

afterEach(() => resetLogging())

describe('recovery diagnostics', () => {
  it('records initial load, stale refresh, regression and restored readiness once per transition', () => {
    const records: LogRecord[] = []
    addSink({ name: 'capture', minLevel: 'trace', write: (record) => records.push(record) })
    const note = createScreenReadinessDiagnostic('flight-deck')
    note(false)
    note(true)
    note(true, true)
    note(true, true)
    note(false, true)
    note(false, true)
    note(true)
    expect(records.map((r) => [r.ready, r.refreshing, r.wasLoaded, r.loadedToLoading])).toEqual([
      [false, false, false, false],
      [true, false, false, false],
      [true, true, true, false],
      [false, true, true, true],
      [true, false, true, false],
    ])
    expect(records[3]).toMatchObject({ level: 'warn', screen: 'flight-deck', clientRecoveryId })
    expect(new Set(records.map((r) => r.screenOpeningId)).size).toBe(1)
    const other = createScreenReadinessDiagnostic('flight-deck')
    other(false)
    expect(records.at(-1)).toMatchObject({
      wasLoaded: false,
      loadedToLoading: false,
      clientRecoveryId,
    })
    expect(records.at(-1)?.screenOpeningId).not.toBe(records[0]?.screenOpeningId)
  })

  it('retains recovery summaries at the default client level and correlates reload/boot records', async () => {
    const records: Array<Record<string, unknown>> = []
    const logging = installClientLogging({
      role: 'web',
      version: 'test',
      console: false,
      transport: {
        forward: async (input) => {
          records.push(...input.records)
        },
        crash: async () => {},
      },
    })
    try {
      const telemetry = createSyncTransferTelemetry()
      telemetry.noteReplicaEvent({ type: 'heal', rung: 1, cause: 'gap', reason: 'resume' })
      telemetry.noteReplicaEvent({ type: 'posture', previous: 'healing', posture: 'live' })
      createScreenReadinessDiagnostic('flight-deck')(true)
      createLogger('web:updates').warn('reloading the page')
      createLogger('web:boot').warn('web client booted')
      await logging.flush()
      expect(records.map((r) => r.msg)).toEqual([
        'sync recovery started',
        'sync recovery finished',
        'screen readiness changed',
        'reloading the page',
        'web client booted',
      ])
      expect(records[1]).toMatchObject({
        outcome: 'resumed',
        recoveryReason: 'resume',
        transferMode: 'delta',
      })
      expect(new Set(records.map((r) => r.clientRecoveryId))).toEqual(new Set([clientRecoveryId]))
      expect(clientRecoveryId).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      logging.dispose()
    }
  })
})
