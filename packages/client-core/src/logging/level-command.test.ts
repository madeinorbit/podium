import {
  addSink,
  createLogger,
  type LogRecord,
  resetLevels,
  resetLogging,
  type Sink,
} from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyServerLogLevel,
  createLevelController,
  DEFAULT_LEVEL_TTL_MS,
  logLevelStatus,
  MAX_LEVEL_TTL_MS,
  setActiveLevelController,
} from './level-command'

/**
 * A REAL SINK WITH NO `minLevel` — the production mechanism, not a console spy.
 *
 * Pinning it at `trace` would make it see records a client at `warn` never
 * emits, and every assertion below about "the level actually changed what is
 * emitted" would pass on behaviour that does not ship. So it follows config,
 * exactly as the console and forwarding sinks do — which is what makes the
 * capture a witness for BOTH of them at once, and therefore what lets this file
 * assert the one-knob property rather than assume it.
 */
function captureRecords(): { records: LogRecord[]; sink: Sink } {
  const records: LogRecord[] = []
  return { records, sink: { write: (record) => void records.push(record) } }
}

describe('client log level control', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetLevels()
  })
  afterEach(() => {
    setActiveLevelController(null)
    vi.useRealTimers()
    resetLogging()
  })

  it('raising the level is what makes a debug record reach a sink', () => {
    const { records, sink } = captureRecords()
    addSink(sink)
    const log = createLogger('web:example')
    const levels = createLevelController({ boot: 'warn' })

    log.debug('before')
    expect(records.map((r) => r.msg)).not.toContain('before')

    levels.apply({ level: 'debug' })
    log.debug('after')

    expect(records.map((r) => r.msg)).toContain('after')
  })

  it('one raise moves every sink that follows config, not a chosen one', () => {
    // The one-knob property, stated as a test: two independent sinks with no
    // threshold of their own — the console and the forwarding sink in
    // production — must both start seeing `debug` from the SAME single call.
    // A second, forwarding-only threshold would show up here as one capture
    // moving while the other did not.
    const consoleLike = captureRecords()
    const forwardLike = captureRecords()
    addSink(consoleLike.sink)
    addSink(forwardLike.sink)
    const log = createLogger('web:example')

    createLevelController({ boot: 'warn' }).apply({ level: 'debug' })
    log.debug('diagnosis')

    expect(consoleLike.records.map((r) => r.msg)).toContain('diagnosis')
    expect(forwardLike.records.map((r) => r.msg)).toContain('diagnosis')
  })

  it('puts the client back at its boot level when the TTL expires', () => {
    const { records, sink } = captureRecords()
    addSink(sink)
    const log = createLogger('web:example')
    const levels = createLevelController({ boot: 'warn' })

    levels.apply({ level: 'debug', ttlMs: 60_000 })
    vi.advanceTimersByTime(59_999)
    log.debug('still raised')
    expect(records.map((r) => r.msg)).toContain('still raised')

    vi.advanceTimersByTime(1)
    log.debug('after expiry')

    expect(records.map((r) => r.msg)).not.toContain('after expiry')
    expect(levels.status()).toEqual({ level: 'warn', boot: 'warn', expiresAt: null })
  })

  it('restores the boot level rather than a named one on reset', () => {
    // A client that boots at `info` must come back to `info`, not to whatever
    // the shipping default happens to be — the operator says "put it back", not
    // "set it to warn", so a later change of default cannot strand a stale
    // level in somebody's support instructions.
    const { records, sink } = captureRecords()
    addSink(sink)
    const log = createLogger('web:example')
    const levels = createLevelController({ boot: 'info' })

    levels.apply({ level: 'trace' })
    levels.apply({ level: null })
    log.info('lifecycle')
    log.debug('detail')

    expect(records.map((r) => r.msg)).toContain('lifecycle')
    expect(records.map((r) => r.msg)).not.toContain('detail')
    expect(levels.status().level).toBe('info')
  })

  it('announces the raise and the way back at warn, so both land in the forwarded file', () => {
    // At the boot default these two lines are the only trace of the operator's
    // act in the client's own log. Below `warn` they would vanish exactly when
    // they are the explanation for why the stream got loud and then quiet.
    const { records, sink } = captureRecords()
    addSink(sink)
    const levels = createLevelController({ boot: 'warn' })

    levels.apply({ level: 'debug', ttlMs: 1000 })
    vi.advanceTimersByTime(1000)

    const own = records.filter((r) => r.ns === 'client-core:log-level')
    expect(own.map((r) => [r.level, r.msg])).toEqual([
      ['warn', 'client log level raised'],
      ['warn', 'client log level restored'],
    ])
    expect(own[1]).toMatchObject({ reason: 'expired', to: 'warn' })
  })

  it('defaults the TTL when the command names none, and clamps an over-long one', () => {
    const now = () => 1_000_000
    const levels = createLevelController({ boot: 'warn', now })

    levels.apply({ level: 'debug' })
    expect(levels.status().expiresAt).toBe(1_000_000 + DEFAULT_LEVEL_TTL_MS)

    levels.apply({ level: 'debug', ttlMs: MAX_LEVEL_TTL_MS * 10 })
    expect(levels.status().expiresAt).toBe(1_000_000 + MAX_LEVEL_TTL_MS)
  })

  it('a later raise replaces the earlier expiry rather than stacking with it', () => {
    const { records, sink } = captureRecords()
    addSink(sink)
    const log = createLogger('web:example')
    const levels = createLevelController({ boot: 'warn' })

    levels.apply({ level: 'debug', ttlMs: 10_000 })
    vi.advanceTimersByTime(9_000)
    // Re-issued: the operator is still working, so the clock starts again. The
    // bug this pins is the first timer surviving and dropping the client back
    // to `warn` a second later, mid-diagnosis.
    levels.apply({ level: 'debug', ttlMs: 10_000 })
    vi.advanceTimersByTime(2_000)

    log.debug('still here')
    expect(records.map((r) => r.msg)).toContain('still here')
  })

  it('is a no-op before client logging is installed', () => {
    // A raise addressed at a client whose logging never installed has nothing to
    // raise. It must not throw on the socket's dispatch path.
    setActiveLevelController(null)
    expect(() => applyServerLogLevel({ level: 'debug' })).not.toThrow()
    expect(logLevelStatus()).toBeNull()
  })

  it('routes a server-pushed command to the installed controller', () => {
    const levels = createLevelController({ boot: 'warn' })
    setActiveLevelController(levels)

    applyServerLogLevel({ level: 'trace', ttlMs: 5_000 })

    expect(logLevelStatus()).toMatchObject({ level: 'trace', boot: 'warn' })
  })
})
