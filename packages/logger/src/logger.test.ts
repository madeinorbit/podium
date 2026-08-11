import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureLevelsFromEnv, setLogLevel, setNamespaceLevel } from './level-control'
import { createLogger, getProcessContext, resetLogging, setProcessContext } from './logger'
import type { LogRecord } from './record'
import { addSink } from './sinks'
import { createRingBufferSink } from './sinks/ring-buffer'

function collector(minLevel?: 'error' | 'warn' | 'info' | 'debug' | 'trace') {
  const seen: LogRecord[] = []
  addSink({
    name: 'collector',
    ...(minLevel ? { minLevel } : {}),
    write: (r) => {
      seen.push(r)
    },
  })
  return seen
}

beforeEach(() => {
  resetLogging()
  configureLevelsFromEnv({})
})
afterEach(() => {
  resetLogging()
})

describe('createLogger', () => {
  it('emits one record per level with the namespace attached', () => {
    const seen = collector('trace')
    setLogLevel('trace')
    const log = createLogger('daemon:pty')
    log.error('e')
    log.warn('w')
    log.info('i')
    log.debug('d')
    log.trace('t')
    expect(seen.map((r) => r.level)).toEqual(['error', 'warn', 'info', 'debug', 'trace'])
    expect(new Set(seen.map((r) => r.ns))).toEqual(new Set(['daemon:pty']))
  })

  it('carries structured fields to the sink', () => {
    const seen = collector()
    createLogger('daemon:sync').warn('sync failed', { machineId: 'm1', attempt: 3 })
    expect(seen[0]).toMatchObject({ msg: 'sync failed', machineId: 'm1', attempt: 3 })
  })

  it('serializes an error passed as the err field', () => {
    const seen = collector()
    createLogger('server:boot').error('write failed', { err: new Error('disk full') })
    expect(seen[0]?.err).toMatchObject({ name: 'Error', message: 'disk full' })
  })
})

describe('process context', () => {
  it('stamps role and version on every record once set at boot', () => {
    const seen = collector()
    setProcessContext({ role: 'daemon', v: '0.1.3', platform: 'linux' })
    createLogger('daemon:pty').warn('resize dropped')
    expect(seen[0]).toMatchObject({ role: 'daemon', v: '0.1.3', platform: 'linux' })
  })

  it('merges a later call rather than replacing what boot already set', () => {
    setProcessContext({ role: 'server' })
    setProcessContext({ v: '9.9.9' })
    expect(getProcessContext()).toMatchObject({ role: 'server', v: '9.9.9' })
  })
})

describe('child loggers', () => {
  it('binds context onto every record it emits', () => {
    const seen = collector()
    createLogger('server:session').child({ sessionId: 's1' }).info('started')
    expect(seen[0]).toMatchObject({ ns: 'server:session', sessionId: 's1', msg: 'started' })
  })

  it('merges through nesting, innermost last', () => {
    const seen = collector()
    createLogger('server:session').child({ sessionId: 's1' }).child({ attempt: 2 }).info('retrying')
    expect(seen[0]).toMatchObject({ sessionId: 's1', attempt: 2 })
  })

  it('lets a call-site field override a bound one', () => {
    const seen = collector()
    createLogger('server:session').child({ attempt: 1 }).info('retrying', { attempt: 7 })
    expect(seen[0]?.attempt).toBe(7)
  })

  it('does not leak a child binding back into its parent', () => {
    const seen = collector()
    const parent = createLogger('server:session')
    parent.child({ sessionId: 's1' }).info('child')
    parent.info('parent')
    expect(seen[1]?.sessionId).toBeUndefined()
  })
})

describe('level gating', () => {
  it('drops a record no sink would accept', () => {
    const seen = collector()
    setLogLevel('info')
    createLogger('daemon:pty').debug('too quiet to print')
    expect(seen).toHaveLength(0)
  })

  it('reports what is enabled so a caller can skip expensive fields', () => {
    setLogLevel('info')
    collector()
    const log = createLogger('daemon:pty')
    expect(log.isLevelEnabled('info')).toBe(true)
    expect(log.isLevelEnabled('debug')).toBe(false)
  })
})

describe('the two predicates a hot path chooses between', () => {
  it('reports a level as ENABLED once any sink would consume it, flight recorder included', () => {
    // The trap this pins: `isLevelEnabled` answers "will anything consume
    // this?", and once a ring buffer is pinned at trace the answer is always
    // yes. A per-frame caller guarding on it will still pay for the record.
    addSink(createRingBufferSink({ capacity: 10 }))
    setLogLevel('info')
    expect(createLogger('daemon:pty').isLevelEnabled('trace')).toBe(true)
  })

  it('reports the same level as NOT REQUESTED, because no operator asked for it', () => {
    addSink(createRingBufferSink({ capacity: 10 }))
    setLogLevel('info')
    expect(createLogger('daemon:pty').isLevelRequested('trace')).toBe(false)
  })

  it('reports it as requested once configuration does ask for it', () => {
    addSink(createRingBufferSink({ capacity: 10 }))
    setNamespaceLevel('daemon:*', 'trace')
    expect(createLogger('daemon:pty').isLevelRequested('trace')).toBe(true)
    expect(createLogger('server:events').isLevelRequested('trace')).toBe(false)
  })

  it('tracks a configuration change made after the logger was built', () => {
    const log = createLogger('daemon:pty')
    expect(log.isLevelRequested('debug')).toBe(false)
    setLogLevel('debug')
    expect(log.isLevelRequested('debug')).toBe(true)
  })
})

describe('level gating, continued', () => {
  it('applies a per-namespace override to the sinks that follow the config', () => {
    const seen = collector()
    setLogLevel('warn')
    setNamespaceLevel('daemon:*', 'debug')
    createLogger('daemon:pty').debug('visible')
    createLogger('server:events').debug('invisible')
    expect(seen.map((r) => r.msg)).toEqual(['visible'])
  })

  it('does not let a namespace override quieten a sink pinned at trace', () => {
    // The flight recorder is unconditional by design: `PODIUM_LOG` moves the
    // sinks that FOLLOW the configuration, never the ring buffer, or a crash in
    // a namespace someone had turned down would arrive with no context.
    const ring = createRingBufferSink({ capacity: 10 })
    addSink(ring)
    setNamespaceLevel('server:*', 'error')
    createLogger('server:events').trace('still recorded')
    expect(ring.snapshot().map((r) => r.msg)).toEqual(['still recorded'])
  })

  it('notices a level change made after the logger was created', () => {
    const seen = collector()
    const log = createLogger('daemon:pty')
    log.debug('before')
    setLogLevel('debug')
    log.debug('after')
    expect(seen.map((r) => r.msg)).toEqual(['after'])
  })

  it('still feeds the ring buffer what the console-level sink refuses', () => {
    const ring = createRingBufferSink({ capacity: 10 })
    addSink(ring)
    const consoleLevel = collector()
    setLogLevel('warn')
    createLogger('daemon:pty').debug('flight recorder detail')
    expect(consoleLevel).toHaveLength(0)
    expect(ring.snapshot().map((r) => r.msg)).toEqual(['flight recorder detail'])
  })

  it('does nothing at all when no sink is registered — and reports the gate CLOSED', () => {
    // The not-throw half was vacuous: it passed identically whether the gate
    // was open or shut, while sitting directly over the bug where an unsunk
    // logger built records and answered `true` for a fan-out to nobody. The
    // predicate is the falsifiable half.
    const log = createLogger('daemon:pty')
    setLogLevel('trace')
    expect(() => log.error('nowhere to go')).not.toThrow()
    expect(log.isLevelEnabled('error')).toBe(false)
    expect(log.isLevelEnabled('trace')).toBe(false)
  })

  it('answers isLevelEnabled false when every sink is stricter than the level', () => {
    collector('error')
    setLogLevel('trace')
    const log = createLogger('daemon:pty')
    // Configuration asked for trace; no registered sink would take it. The two
    // predicates disagree here on purpose, and that disagreement is the whole
    // reason both exist.
    expect(log.isLevelRequested('trace')).toBe(true)
    expect(log.isLevelEnabled('trace')).toBe(false)
    expect(log.isLevelEnabled('error')).toBe(true)
  })

  it('opens the gate as soon as a sink registers, mid-life', () => {
    const log = createLogger('daemon:pty')
    expect(log.isLevelEnabled('error')).toBe(false)
    const seen = collector('trace')
    expect(log.isLevelEnabled('error')).toBe(true)
    log.error('now it lands')
    expect(seen.map((r) => r.msg)).toEqual(['now it lands'])
  })
})
