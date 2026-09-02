import { setActiveLogFlusher } from '@podium/client-core/logging'
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
  setActiveLogFlusher(null)
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

/**
 * THE RECORD MUST OUTLIVE THE NAVIGATION IT DESCRIBES (POD-3224 follow-up).
 *
 * This is the defect the first two live traces found: the click, the handshake
 * outcome and the navigation line were all written within ~200 ms of a reload,
 * the forwarding sink batches on a five-second timer, and not one of the three
 * arrived. The logging was correct and the delivery was not, which from the
 * operator's side is the same thing as no logging at all.
 */
describe('delivery across the navigation', () => {
  it('hands the buffer to the browser BEFORE it replaces the document', () => {
    const order: string[] = []
    setActiveLogFlusher(() => {
      order.push('flush')
      return 1
    })
    const reload = vi.fn(() => {
      order.push('reload')
    })

    navigateReload('handshake', 'replacement-ready', {}, { location: { reload } })

    // Order is the whole assertion: a flush after the reload call is a flush
    // that never happened.
    expect(order).toEqual(['flush', 'reload'])
  })

  it('still navigates when the flush throws — logging cannot veto a reload', () => {
    setActiveLogFlusher(() => {
      throw new Error('transport is gone')
    })
    const reload = vi.fn()

    expect(() =>
      navigateReload('force-reload', 'reset-cached-interface', {}, { location: { reload } }),
    ).not.toThrow()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('navigates when nothing is installed to flush', () => {
    setActiveLogFlusher(null)
    const reload = vi.fn()

    navigateReload('setup', 'setup-retry', {}, { location: { reload } })

    expect(reload).toHaveBeenCalledOnce()
  })
})
