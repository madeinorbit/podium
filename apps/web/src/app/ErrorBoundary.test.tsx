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
    const probe = vi.fn().mockResolvedValue('replaced')
    act(() => {
      root.render(
        <ErrorBoundary resetKey="k" probeAssets={probe}>
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
    const probe = vi.fn().mockResolvedValue('ok')
    act(() => {
      root.render(
        <ErrorBoundary resetKey="k" probeAssets={probe}>
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
    const probe = vi.fn().mockResolvedValue('replaced')
    act(() => {
      root.render(
        <ErrorBoundary resetKey="k" probeAssets={probe}>
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
        <ErrorBoundary resetKey="k" probeAssets={probe}>
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
        <ErrorBoundary resetKey="k" probeAssets={vi.fn().mockResolvedValue('replaced')}>
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

/**
 * THE CRASH THAT WAS ONLY A RESTART (POD-2762).
 *
 * The human opened Settings while an update was applying. The chunk was refused
 * — not 404'd, REFUSED, because nothing was listening — and every existing path
 * read that as "the server did not confirm a replacement", which is to say as
 * "no". The interface put its crash screen over an app whose server was back
 * two seconds later.
 *
 * These are the three ways that wait can end, and each one has to land on a
 * different screen. A single wrong answer here is either a crash page for a
 * hiccup or a reload offer that can never be satisfied.
 */
describe('ErrorBoundary and a server that is restarting', () => {
  let container: HTMLDivElement
  let root: Root

  function FailedImport(): never {
    throw new TypeError(
      'Failed to fetch dynamically imported module: ' +
        'http://100.113.194.89:32780/assets/SettingsView-WmDcr0IH.js',
    )
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

  async function settle(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve()
    })
  }

  /** Renders the boundary over a refused chunk, with the wait stubbed. */
  function mount(waitResult: string) {
    const probe = vi.fn().mockResolvedValue('unreachable')
    const waitForServer = vi.fn().mockResolvedValue(waitResult)
    act(() => {
      root.render(
        <ErrorBoundary resetKey="k" probeAssets={probe} waitForServer={waitForServer as never}>
          <FailedImport />
        </ErrorBoundary>,
      )
    })
    return { probe, waitForServer }
  }

  it('says the server is restarting rather than that the interface stopped', async () => {
    // A wait that never settles is the state the user is actually IN for the
    // seconds a handover takes, so it is the state worth asserting.
    const probe = vi.fn().mockResolvedValue('unreachable')
    act(() => {
      root.render(
        <ErrorBoundary
          resetKey="k"
          probeAssets={probe}
          waitForServer={(() => new Promise(() => {})) as never}
        >
          <FailedImport />
        </ErrorBoundary>,
      )
    })
    await settle()

    expect(container.textContent).toContain('Podium’s server is restarting.')
    expect(container.textContent).toMatch(/nothing has been lost/i)
    expect(container.textContent).toMatch(/no need to press anything/i)
    // The two wrong screens, named so a regression cannot quietly pick one.
    expect(container.textContent).not.toContain('The interface stopped')
    expect(container.textContent).not.toContain('Podium was updated')
  })

  it('offers the reload once the server comes back on the same build', async () => {
    mount('ok')
    await settle()

    expect(container.textContent).toContain('Podium’s server is back.')
    expect(container.textContent).toContain('This page needs one reload.')
    expect(container.textContent).not.toContain('The interface stopped')
  })

  /**
   * A handover that lands on a DIFFERENT build ends as POD-2721's case, not
   * this one. The wait is what makes the page able to find that out: at the
   * moment of the failure the server could not have told it either way.
   */
  it('lands on the replaced-build offer when the server returns as a new build', async () => {
    mount('replaced')
    await settle()

    expect(container.textContent).toContain('Podium was updated')
    expect(container.textContent).not.toContain('Podium’s server is restarting')
  })

  /**
   * GIVING UP ADDS NO KNOWLEDGE. A server that never came back leaves this page
   * knowing exactly what it knew at the start, so it must fall back to the
   * honest crash page rather than keep a hopeful screen up forever.
   */
  it('falls back to the honest crash page when the server never returns', async () => {
    mount('gave-up')
    await settle()

    expect(container.textContent).toContain('The interface stopped')
    expect(container.textContent).not.toContain('Podium’s server is restarting')
  })

  it('never reloads by itself on any of those endings', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload, href: 'http://podium.test/' })
    mount('ok')
    await settle()
    expect(reload).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
