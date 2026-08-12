import { describe, expect, it } from 'vitest'
import { installGlobalHandlers } from './global-handlers'

function spyReporter(): {
  reporter: { report: (error: unknown, context?: Record<string, unknown>) => void }
  seen: Array<{ error: unknown; context?: Record<string, unknown> }>
} {
  const seen: Array<{ error: unknown; context?: Record<string, unknown> }> = []
  return { seen, reporter: { report: (error, context) => seen.push({ error, context }) } }
}

/** happy-dom has no PromiseRejectionEvent constructor; the shape is what the
 *  handler reads, so build that shape. */
function rejectionEvent(reason: unknown): Event {
  const event = new Event('unhandledrejection', { cancelable: true })
  Object.assign(event, { reason, promise: Promise.resolve() })
  return event
}

describe('browser global handlers', () => {
  it('reports an uncaught window error with where it came from', () => {
    const { reporter, seen } = spyReporter()
    const dispose = installGlobalHandlers(window, reporter)

    window.dispatchEvent(
      new ErrorEvent('error', { error: new Error('async boom'), filename: 'app.js', lineno: 12 }),
    )

    expect((seen[0]?.error as Error).message).toBe('async boom')
    expect(seen[0]?.context).toMatchObject({ source: 'window.onerror', filename: 'app.js' })
    dispose()
  })

  it('reports an unhandled rejection — the case window.onerror never sees', () => {
    const { reporter, seen } = spyReporter()
    const dispose = installGlobalHandlers(window, reporter)

    window.dispatchEvent(rejectionEvent(new Error('rejected in a microtask')))

    expect((seen[0]?.error as Error).message).toBe('rejected in a microtask')
    expect(seen[0]?.context?.source).toBe('unhandledrejection')
    dispose()
  })

  it('still reports a cross-origin script error, which arrives with no error object', () => {
    const { reporter, seen } = spyReporter()
    const dispose = installGlobalHandlers(window, reporter)

    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }))

    // The browser withholds the detail; the message alone still beats silence.
    expect((seen[0]?.error as Error).message).toBe('Script error.')
    dispose()
  })

  it('stops handling once disposed', () => {
    const { reporter, seen } = spyReporter()
    const dispose = installGlobalHandlers(window, reporter)
    dispose()

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('after dispose') }))

    expect(seen).toEqual([])
  })
})
