/**
 * Settings → Privacy → Diagnostic detail (POD-1920, POD-1946).
 *
 * The behaviours that matter: the picker drives the SAME knob a server-pushed
 * raise does (so the two can never disagree), the row says which level is in
 * force and whether it is temporary, and a raise turns itself back down.
 */
import { createLevelController, setActiveLevelController } from '@podium/client-core/logging'
import { addSink, createLogger, type LogRecord, resetLogging } from '@podium/logger'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AFFORDANCE_TTL_MS, DiagnosticLoggingSubsection } from './diagnostic-logging'

/** A real sink with no `minLevel`, following config exactly as the console and
 *  forwarding sinks do — so "the picker changed what is emitted" is a claim
 *  about the shipping mechanism rather than about a spy. */
function capture(): LogRecord[] {
  const records: LogRecord[] = []
  addSink({ name: 'capture', write: (record) => void records.push(record) })
  return records
}

/** A Base UI select only commits on a real pointer sequence — a bare click on
 *  the option is a no-op. */
function pickLevel(name: string | RegExp): void {
  fireEvent.click(screen.getByTestId('log-level-select'))
  const option = screen.getByRole('option', { name })
  fireEvent.pointerDown(option)
  fireEvent.pointerUp(option)
  fireEvent.click(option)
}

describe('diagnostic logging affordance', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    cleanup()
    setActiveLevelController(null)
    vi.useRealTimers()
    resetLogging()
  })

  it('renders nothing before client logging is installed', () => {
    // A control that would raise nothing is worse than an absent one.
    setActiveLevelController(null)
    const { container } = render(<DiagnosticLoggingSubsection />)
    expect(container.innerHTML).toBe('')
  })

  it('says which level is in force, and that it is the boot default', () => {
    setActiveLevelController(createLevelController({ boot: 'warn' }))
    render(<DiagnosticLoggingSubsection />)

    expect(screen.getByTestId('log-level-select').textContent).toContain('warn')
    expect(
      screen.getByText(/Running at warn \(failures and warnings\), this client's default/),
    ).toBeTruthy()
    // Nothing temporary is in force, so nothing claims an expiry.
    expect(screen.queryByTestId('log-level-reset')).toBeNull()
  })

  it('picking a level is what makes a debug record reach a sink', () => {
    const records = capture()
    const log = createLogger('web:example')
    setActiveLevelController(createLevelController({ boot: 'warn' }))
    render(<DiagnosticLoggingSubsection />)

    log.debug('before')
    pickLevel(/^debug/)
    log.debug('after')

    expect(records.map((r) => r.msg)).not.toContain('before')
    expect(records.map((r) => r.msg)).toContain('after')
  })

  it('offers every level, not just one preset', () => {
    const records = capture()
    const log = createLogger('web:example')
    setActiveLevelController(createLevelController({ boot: 'warn' }))
    render(<DiagnosticLoggingSubsection />)

    pickLevel(/^trace/)
    log.trace('deepest')
    expect(records.map((r) => r.msg)).toContain('deepest')

    // And down as well as up: below the boot default is a choice too.
    pickLevel(/^error/)
    log.warn('quieter')
    expect(records.map((r) => r.msg)).not.toContain('quieter')
  })

  it('shows a raise as temporary, with when it lifts', () => {
    setActiveLevelController(createLevelController({ boot: 'warn' }))
    render(<DiagnosticLoggingSubsection />)

    pickLevel(/^debug/)

    expect(screen.getByText(/a temporary change from its usual warn/)).toBeTruthy()
    expect(screen.getByText(/Back to warn by itself — 30 minutes left/)).toBeTruthy()
  })

  it('reflects a raise an OPERATOR pushed, without anyone touching the picker', () => {
    // The knob has two ends. A row that only reported its own clicks would tell
    // the reader this client is at its default while it is forwarding debug.
    const controller = createLevelController({ boot: 'warn' })
    setActiveLevelController(controller)
    render(<DiagnosticLoggingSubsection />)

    act(() => {
      controller.apply({ level: 'trace', ttlMs: 10 * 60 * 1000 })
      vi.advanceTimersByTime(5001)
    })

    expect(screen.getByTestId('log-level-select').textContent).toContain('trace')
    expect(screen.getByText(/Back to warn by itself — 10 minutes left/)).toBeTruthy()
  })

  it('offers the way back, and takes it', () => {
    const records = capture()
    const log = createLogger('web:example')
    setActiveLevelController(createLevelController({ boot: 'warn' }))
    render(<DiagnosticLoggingSubsection />)

    pickLevel(/^debug/)
    expect(screen.getByTestId('log-level-reset')).toBeTruthy()

    fireEvent.click(screen.getByTestId('log-level-reset'))
    log.debug('after reset')

    expect(records.map((r) => r.msg)).not.toContain('after reset')
    expect(screen.queryByTestId('log-level-reset')).toBeNull()
  })

  it('choosing the default level is a reset, not a raise held at the default', () => {
    // Otherwise the row would claim a temporary state that changes nothing, and
    // a deadline would be running against the level already in force.
    setActiveLevelController(createLevelController({ boot: 'warn' }))
    render(<DiagnosticLoggingSubsection />)

    pickLevel(/^debug/)
    pickLevel(/^warn/)

    expect(screen.queryByTestId('log-level-reset')).toBeNull()
    expect(
      screen.getByText(/Running at warn \(failures and warnings\), this client's default/),
    ).toBeTruthy()
  })

  it('turns itself back down when the half hour is up', () => {
    // The row must stop claiming "on" without anyone pressing anything: this is
    // the property that makes leaving the page a safe thing to do.
    const records = capture()
    const log = createLogger('web:example')
    setActiveLevelController(createLevelController({ boot: 'warn' }))
    render(<DiagnosticLoggingSubsection />)

    pickLevel(/^debug/)
    // Inside `act` because the row re-reads the status on a timer: without it
    // the level would revert while the rendered row still claimed "on", which
    // is exactly the disagreement this test is here to refuse.
    act(() => vi.advanceTimersByTime(AFFORDANCE_TTL_MS + 5001))
    log.debug('long after')

    expect(records.map((r) => r.msg)).not.toContain('long after')
    expect(screen.queryByTestId('log-level-reset')).toBeNull()
    expect(screen.getByTestId('log-level-select').textContent).toContain('warn')
  })
})
