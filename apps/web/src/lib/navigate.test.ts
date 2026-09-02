import { addSink, type LogRecord, resetLogging, setLogLevel } from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { navigateReload } from './navigate'

/**
 * The seam every self-triggered navigation goes through (POD-3224).
 *
 * The property under test is NOT "it logs" — it is that logging did not become a
 * decision. Two callers act on a reload that throws (`reload-handshake.ts` shows
 * "activated, but reload failed" with a Reset affordance; `version-guard.ts`
 * must not answer `'reloaded'`), so a swallowed throw here would make one branch
 * unreachable and the other one lie. That is the regression these pin.
 */

let logged: LogRecord[]

beforeEach(() => {
  resetLogging()
  logged = []
  setLogLevel('info')
  addSink({ name: 'capture', write: (record) => logged.push(record) })
})

afterEach(() => {
  resetLogging()
})

describe('navigateReload', () => {
  it('names the site and the reason, then navigates', () => {
    const reload = vi.fn()
    navigateReload(
      'handshake',
      'replacement-ready',
      { signal: 'activated' },
      {
        location: { reload },
      },
    )

    expect(reload).toHaveBeenCalledOnce()
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({
      ns: 'web:reload',
      level: 'info',
      msg: 'reloading the page',
      site: 'handshake',
      reason: 'replacement-ready',
      signal: 'activated',
    })
  })

  it('RETHROWS a refused reload, so its callers can still decide', () => {
    const refusal = new Error('SecurityError: reload is not allowed here')
    const reload = vi.fn(() => {
      throw refusal
    })

    expect(() =>
      navigateReload('force-reload', 'reset-cached-interface', {}, { location: { reload } }),
    ).toThrow(refusal)
  })

  it('records the refusal at error before handing it back', () => {
    const reload = vi.fn(() => {
      throw new Error('refused')
    })

    try {
      navigateReload('wire-skew', 'no-update-panel-listening', {}, { location: { reload } })
    } catch {
      // The rethrow is asserted above; here the record is the subject.
    }

    // Two records: the intent, then the failure. A reader must be able to tell a
    // navigation that happened from one that only started.
    expect(logged.map((record) => record.msg)).toEqual([
      'reloading the page',
      'the page could not be reloaded',
    ])
    expect(logged[1]).toMatchObject({ level: 'error', site: 'wire-skew' })
  })
})
