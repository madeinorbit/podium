import {
  addSink,
  createLogger,
  createRingBufferSink,
  resetLogging,
  setLogLevel,
} from '@podium/logger'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type CrashPayload, createCrashReporter } from './crash'

function harness(overrides: { maxCrashes?: number } = {}) {
  const ring = createRingBufferSink({ capacity: 50 })
  addSink(ring)
  const sent: CrashPayload[] = []
  const reporter = createCrashReporter({
    log: createLogger('web'),
    snapshot: () => ring.snapshot(),
    send: async (payload) => {
      sent.push(payload)
    },
    onDegraded: () => {},
    ...overrides,
  })
  return { ring, sent, reporter }
}

/** happy-dom has no PromiseRejectionEvent constructor; the shape is what the
 *  handler reads, so build that shape. */
function rejectionEvent(reason: unknown): Event {
  const event = new Event('unhandledrejection', { cancelable: true })
  Object.assign(event, { reason, promise: Promise.resolve() })
  return event
}

describe('crash reporter', () => {
  beforeEach(() => {
    setLogLevel('warn')
  })
  afterEach(() => {
    resetLogging()
  })

  it('ships an uncaught window error with the ring buffer that led to it', async () => {
    const { sent, reporter } = harness()
    const dispose = reporter.installGlobalHandlers(window)
    const log = createLogger('web:store')
    log.warn('replica degraded', { detail: 'quota' })

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('async boom') }))
    await Promise.resolve()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.err).toMatchObject({ name: 'Error', message: 'async boom' })
    expect(sent[0]?.snapshot.map((r) => r.msg)).toEqual(['replica degraded', 'async boom'])
    dispose()
  })

  it('ships an unhandled promise rejection — the case window.onerror never sees', async () => {
    const { sent, reporter } = harness()
    const dispose = reporter.installGlobalHandlers(window)

    window.dispatchEvent(rejectionEvent(new Error('rejected in a microtask')))
    await Promise.resolve()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.err.message).toBe('rejected in a microtask')
    expect(sent[0]?.context?.source).toBe('unhandledrejection')
    dispose()
  })

  it('carries producer context, such as a React component stack', async () => {
    const { sent, reporter } = harness()

    reporter.report(new Error('render exploded'), {
      componentStack: '\n    at SessionCard\n    at Workspace',
      source: 'error-boundary',
    })
    await Promise.resolve()

    expect(sent[0]?.context?.componentStack).toContain('at SessionCard')
  })

  it('stops shipping once a crash loop exceeds the per-session cap', async () => {
    const { sent, reporter } = harness({ maxCrashes: 2 })

    for (let i = 0; i < 6; i++) reporter.report(new Error(`loop ${i}`))
    await Promise.resolve()

    expect(sent).toHaveLength(2)
  })

  it('ships one report when the same error arrives twice, as a boundary and a window error both do', async () => {
    const { sent, reporter } = harness()
    const error = new Error('caught twice')

    reporter.report(error, { source: 'error-boundary' })
    reporter.report(error, { source: 'window.onerror' })
    await Promise.resolve()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.context?.source).toBe('error-boundary')
  })

  it('never throws at the crash site when shipping itself fails, and never logs about it', async () => {
    const ring = createRingBufferSink({ capacity: 50 })
    addSink(ring)
    const degraded: string[] = []
    const reporter = createCrashReporter({
      log: createLogger('web'),
      snapshot: () => ring.snapshot(),
      send: () => {
        throw new Error('server unreachable')
      },
      onDegraded: (message) => degraded.push(message),
    })

    expect(() => reporter.report(new Error('boom'))).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()

    expect(degraded).toHaveLength(1)
    // The failure must not have become a record that a forwarding sink would
    // then try to ship — one crash, one entry in the buffer.
    expect(ring.snapshot().filter((r) => r.msg.includes('unreachable'))).toEqual([])
  })

  it('stops handling once disposed', async () => {
    const { sent, reporter } = harness()
    const dispose = reporter.installGlobalHandlers(window)
    dispose()

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('after dispose') }))
    await Promise.resolve()

    expect(sent).toHaveLength(0)
  })
})
