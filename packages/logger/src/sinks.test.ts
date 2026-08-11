import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogLevel } from './levels'
import type { LogRecord } from './record'
import { buildRecord } from './record'
import { addSink, clearSinks, dispatch, emissionGate, getSinks } from './sinks'

function record(level: LogLevel, ns = 'test:ns'): LogRecord {
  return buildRecord({ level, ns, msg: 'm', fields: {}, context: {} })
}

function collector(name: string, minLevel?: LogLevel) {
  const seen: LogRecord[] = []
  return {
    seen,
    sink: {
      name,
      ...(minLevel ? { minLevel } : {}),
      write: (r: LogRecord) => {
        seen.push(r)
      },
    },
  }
}

beforeEach(() => {
  clearSinks()
})
afterEach(() => {
  clearSinks()
  vi.restoreAllMocks()
})

describe('sink registry', () => {
  it('fans one record out to every registered sink', () => {
    const a = collector('a')
    const b = collector('b')
    addSink(a.sink)
    addSink(b.sink)
    dispatch(record('info'), 'info')
    expect(a.seen).toHaveLength(1)
    expect(b.seen).toHaveLength(1)
  })

  it('returns a disposer that unregisters the sink', () => {
    const a = collector('a')
    const dispose = addSink(a.sink)
    dispose()
    expect(getSinks()).toHaveLength(0)
    dispatch(record('error'), 'info')
    expect(a.seen).toHaveLength(0)
  })
})

describe('per-sink thresholds', () => {
  it('lets each sink filter independently of the others', () => {
    const console_ = collector('console', 'warn')
    const ring = collector('ring', 'trace')
    addSink(console_.sink)
    addSink(ring.sink)
    dispatch(record('debug'), 'trace')
    expect(console_.seen).toHaveLength(0)
    expect(ring.seen).toHaveLength(1)
  })

  it('makes a sink without its own minLevel follow the namespace level', () => {
    const following = collector('following')
    addSink(following.sink)
    dispatch(record('debug'), 'warn')
    expect(following.seen).toHaveLength(0)
    dispatch(record('debug'), 'debug')
    expect(following.seen).toHaveLength(1)
  })
})

describe('emissionGate', () => {
  it('is the namespace level when every sink follows it', () => {
    addSink(collector('a').sink)
    expect(emissionGate('warn')).toBe('warn')
  })

  it('opens to the loosest pinned sink so the flight recorder sees everything', () => {
    addSink(collector('console', 'warn').sink)
    addSink(collector('ring', 'trace').sink)
    expect(emissionGate('warn')).toBe('trace')
  })

  it('is the namespace level when the only sinks are stricter than it', () => {
    addSink(collector('console', 'error').sink)
    expect(emissionGate('error')).toBe('error')
  })
})

describe('fail-open', () => {
  it('disables a throwing sink and keeps delivering to the others', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const healthy = collector('healthy')
    const broken = {
      name: 'broken',
      write: () => {
        throw new Error('sink is on fire')
      },
    }
    addSink(broken)
    addSink(healthy.sink)

    dispatch(record('error'), 'info')
    dispatch(record('error'), 'info')
    dispatch(record('error'), 'info')

    expect(healthy.seen).toHaveLength(3)
    expect(getSinks().map((s) => s.name)).toEqual(['healthy'])
  })

  it('warns locally exactly once about the sink it disabled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    addSink({
      name: 'broken',
      write: () => {
        throw new Error('sink is on fire')
      },
    })
    dispatch(record('error'), 'info')
    dispatch(record('error'), 'info')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('broken')
  })

  it('never lets a sink failure reach the call site', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    addSink({
      name: 'broken',
      write: () => {
        throw new Error('sink is on fire')
      },
    })
    expect(() => dispatch(record('error'), 'info')).not.toThrow()
  })
})
