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

/**
 * THE CRASH THAT WAS ONLY AN UPDATE (POD-2721).
 *
 * The human's interface "crashed" navigating to Settings. It had not: the server
 * had swapped its website, so `SettingsView-WmDcr0IH.js` was no longer on disk.
 * The page had no way to say so, and reported a bug that did not exist.
 */
describe('ErrorBoundary and a chunk the server no longer has', () => {
  let container: HTMLDivElement
  let root: Root

  function FailedImport(): never {
    throw new TypeError(
      'Failed to fetch dynamically imported module: ' +
        'http://100.113.194.89:32772/assets/SettingsView-WmDcr0IH.js',
    )
  }

  function OrdinaryCrash(): never {
    throw new Error('Cannot read properties of undefined (reading map)')
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    setActiveCrashReporter({ report: () => {} })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    setActiveCrashReporter(null)
    vi.restoreAllMocks()
  })

  /** Let the probe's promise settle and React flush the state it sets. */
  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('says the app was replaced, once the server confirms it', async () => {
    const probe = vi.fn().mockResolvedValue(true)
    act(() => {
      root.render(
        <ErrorBoundary resetKey="k" probeAssetsReplaced={probe}>
          <FailedImport />
        </ErrorBoundary>,
      )
    })
    await settle()

    expect(probe).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Podium was updated')
    expect(container.textContent).toMatch(/nothing has been lost/i)
    expect(container.textContent).toMatch(/reload/i)
    // The real error is still available to whoever is filing the bug.
    expect(container.textContent).toContain('SettingsView-WmDcr0IH.js')
  })

  /**
   * THE CASE THE BRIEF PROTECTS. A chunk that 404s while the server is serving
   * the SAME build this page came from is a genuine asset-serving bug. Hiding it
   * behind a friendly "we updated" page — or worse, a reload — is how that bug
   * becomes unfindable.
   */
  it('leaves a genuine asset-serving bug looking like the bug it is', async () => {
    const probe = vi.fn().mockResolvedValue(false)
    act(() => {
      root.render(
        <ErrorBoundary resetKey="k" probeAssetsReplaced={probe}>
          <FailedImport />
        </ErrorBoundary>,
      )
    })
    await settle()

    expect(probe).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('The interface stopped')
    expect(container.textContent).not.toContain('Podium was updated')
  })

  it('does not interrogate the server about an ordinary render crash', async () => {
    const probe = vi.fn().mockResolvedValue(true)
    act(() => {
      root.render(
        <ErrorBoundary resetKey="k" probeAssetsReplaced={probe}>
          <OrdinaryCrash />
        </ErrorBoundary>,
      )
    })
    await settle()

    expect(probe).not.toHaveBeenCalled()
    expect(container.textContent).toContain('The interface stopped')
  })

  it('keeps the honest crash page when the server cannot be asked', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('offline'))
    act(() => {
      root.render(
        <ErrorBoundary resetKey="k" probeAssetsReplaced={probe}>
          <FailedImport />
        </ErrorBoundary>,
      )
    })
    await settle()

    expect(container.textContent).toContain('The interface stopped')
  })

  /** It TELLS. It never takes the tab away on its own. */
  it('never reloads by itself, however certain the server is', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload, href: 'http://podium.test/' })
    act(() => {
      root.render(
        <ErrorBoundary resetKey="k" probeAssetsReplaced={vi.fn().mockResolvedValue(true)}>
          <FailedImport />
        </ErrorBoundary>,
      )
    })
    await settle()

    expect(container.textContent).toContain('Podium was updated')
    expect(reload).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
