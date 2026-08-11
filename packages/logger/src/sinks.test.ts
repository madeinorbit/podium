import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogLevel } from './levels'
import type { LogRecord } from './record'
import { buildRecord, setRecordFreezing } from './record'
import {
  addSink,
  clearSinks,
  closeSinks,
  dispatch,
  emissionGate,
  flushSinks,
  getSinks,
} from './sinks'

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

/**
 * Let every pending microtask run. A timer callback is scheduled behind the
 * whole microtask queue, so this drains it completely and deterministically —
 * unlike counting `await Promise.resolve()` ticks, which is a guess about how
 * many hops a rejection takes to propagate (an async function returning a
 * rejected promise adopts it, costing two extra) and becomes a flaky test the
 * day that number changes. This is not a sleep: there is no duration to lose a
 * race against.
 */
function settleMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
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

  it('is CLOSED when nothing is registered, so no record is built for nobody', () => {
    expect(emissionGate('trace')).toBeNull()
  })

  it('is CLOSED when every sink is pinned stricter than the namespace level', () => {
    // The counterexample this suite used to lack. The old fold seeded itself
    // with `nsLevel`, so it answered 'debug' here: records built down to
    // `debug` for a console sink that only ever accepts `error`. It was
    // invisible while the only case tested was nsLevel === 'error', where the
    // seed and the sink's own threshold happen to coincide.
    addSink(collector('console', 'error').sink)
    expect(emissionGate('debug')).toBe('error')
    expect(emissionGate('error')).toBe('error')
  })

  it('reopens when a looser sink joins an already-cached gate', () => {
    addSink(collector('console', 'error').sink)
    expect(emissionGate('warn')).toBe('error')
    addSink(collector('ring', 'trace').sink)
    expect(emissionGate('warn')).toBe('trace')
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

  it('disables a sink whose write REJECTS, not just one that throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const healthy = collector('healthy')
    // The shape every real async sink has: an async write, so the failure
    // arrives after `dispatch` has already returned. A try/catch cannot see
    // this, and before dispatch checked for a thenable it became an
    // unhandledRejection while the sink stayed registered and kept failing.
    addSink({ name: 'async-broken', write: async () => Promise.reject(new Error('enospc')) })
    addSink(healthy.sink)

    dispatch(record('error'), 'info')
    await settleMicrotasks()

    expect(getSinks().map((s) => s.name)).toEqual(['healthy'])
    expect(String(warn.mock.calls[0]?.[0])).toContain('async-broken')

    dispatch(record('error'), 'info')
    expect(healthy.seen).toHaveLength(2)
  })

  it('leaves a sink whose write resolves alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: LogRecord[] = []
    addSink({
      name: 'async-fine',
      write: async (r: LogRecord) => {
        seen.push(r)
      },
    })
    dispatch(record('error'), 'info')
    await settleMicrotasks()
    expect(getSinks()).toHaveLength(1)
    expect(seen).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('the no-mutation contract', () => {
  afterEach(() => {
    setRecordFreezing(null)
  })

  it('catches a MUTATING sink under development, in its own test run', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setRecordFreezing(true)
    const ring = collector('ring', 'trace')
    // The violation is invisible without the freeze: this sink rewrites a
    // record every other sink and the ring-buffer snapshot also hold, so the
    // corruption would surface as a wrong crash payload weeks later, nowhere
    // near the sink that caused it.
    addSink({
      name: 'mutator',
      write: (r: LogRecord) => {
        r.msg = 'rewritten'
      },
    })
    addSink(ring.sink)

    dispatch(record('error'), 'info')

    expect(getSinks().map((s) => s.name)).toEqual(['ring'])
    expect(String(warn.mock.calls[0]?.[0])).toContain('mutator')
    expect(ring.seen[0]?.msg).toBe('m')
  })

  it('does NOT freeze in production, so the hot path pays nothing', () => {
    setRecordFreezing(false)
    expect(Object.isFrozen(record('error'))).toBe(false)
  })
})

describe('flush and close', () => {
  it('flushes every sink that buffers and leaves them registered', async () => {
    const flushed: string[] = []
    addSink({ name: 'a', write: () => {}, flush: async () => void flushed.push('a') })
    addSink({ name: 'b', write: () => {} })
    await flushSinks()
    expect(flushed).toEqual(['a'])
    expect(getSinks()).toHaveLength(2)
  })

  it('does NOT disable a sink whose flush fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    addSink({
      name: 'flaky',
      write: () => {},
      flush: async () => Promise.reject(new Error('disk full')),
    })
    // A failed flush is reported, never thrown, and never unregisters: flush is
    // called on the way out and at crash-ship time, and dropping the sink there
    // would discard the very records the next line is trying to save.
    await expect(flushSinks()).resolves.toBeUndefined()
    expect(getSinks()).toHaveLength(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('flaky')
  })

  it('closes every sink and empties the registry', async () => {
    const closed: string[] = []
    addSink({ name: 'a', write: () => {}, close: async () => void closed.push('a') })
    addSink({ name: 'b', write: () => {}, close: async () => void closed.push('b') })
    await closeSinks()
    expect(closed.sort()).toEqual(['a', 'b'])
    expect(getSinks()).toHaveLength(0)
  })

  it('empties the registry even when a close fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    addSink({
      name: 'stuck',
      write: () => {},
      close: async () => Promise.reject(new Error('nope')),
    })
    await expect(closeSinks()).resolves.toBeUndefined()
    expect(getSinks()).toHaveLength(0)
  })
})
