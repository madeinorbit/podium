import { setActiveCrashReporter } from '@podium/client-core/logging'
import { addSink, type LogRecord, resetLogging, setLogLevel } from '@podium/logger'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

function SessionCard(): never {
  throw new Error('render exploded')
}

describe('ErrorBoundary', () => {
  let container: HTMLDivElement
  let root: Root
  let records: LogRecord[]
  let crashes: Array<{ error: unknown; context?: Record<string, unknown> }>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    records = []
    crashes = []
    setLogLevel('warn')
    // A REAL sink with no pinned level, so the test observes the production
    // mechanism at the level a deployment actually runs it at.
    addSink({ name: 'capture', write: (record) => records.push(record) })
    setActiveCrashReporter({ report: (error, context) => crashes.push({ error, context }) })
    vi.spyOn(console, 'error').mockImplementation(() => {}) // React's own boundary log
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    setActiveCrashReporter(null)
    resetLogging()
    vi.restoreAllMocks()
  })

  it('keeps the React component stack instead of discarding the ErrorInfo', () => {
    act(() => {
      root.render(
        <ErrorBoundary resetKey="k">
          <SessionCard />
        </ErrorBoundary>,
      )
    })

    const logged = records.find((r) => r.level === 'error')
    expect(logged?.componentStack).toContain('SessionCard')
    expect(crashes[0]?.context?.componentStack).toContain('SessionCard')
  })

  it('still shows the crash page and still tells its owner', () => {
    const onError = vi.fn()
    act(() => {
      root.render(
        <ErrorBoundary resetKey="k" onError={onError}>
          <SessionCard />
        </ErrorBoundary>,
      )
    })

    // Two lines since POD-1304 — the shared boot screen breaks the headline —
    // so the reassurance is asserted as its own half rather than as one run.
    expect(container.textContent).toContain('The interface stopped.')
    expect(container.textContent).toContain('Your agents did not.')
    // The error is evidence, not the headline: it lives inside the disclosure.
    expect(container.querySelector('details')?.textContent).toContain('render exploded')
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('render exploded'))
  })
})
