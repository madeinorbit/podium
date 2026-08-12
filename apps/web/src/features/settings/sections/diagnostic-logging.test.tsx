/**
 * Settings → Privacy → Diagnostic detail (POD-1920).
 *
 * The behaviours that matter: the button drives the SAME knob a server-pushed
 * raise does (so the two can never disagree), the row says the raise is
 * temporary, and it turns itself back down.
 */
import {
  createLevelController,
  setActiveLevelController,
} from '@podium/client-core/logging'
import { addSink, createLogger, type LogRecord, resetLogging } from '@podium/logger'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AFFORDANCE_TTL_MS, DiagnosticLoggingSubsection } from './diagnostic-logging'

/** A real sink with no `minLevel`, following config exactly as the console and
 *  forwarding sinks do — so "the button changed what is emitted" is a claim
 *  about the shipping mechanism rather than about a spy. */
function capture(): LogRecord[] {
  const records: LogRecord[] = []
  addSink({ name: 'capture', write: (record) => void records.push(record) })
  return records
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
    // A button that would raise nothing is worse than an absent one.
    setActiveLevelController(null)
    const { container } = render(<DiagnosticLoggingSubsection />)
    expect(container.innerHTML).toBe('')
  })

  it('turning it up is what makes a debug record reach a sink', () => {
    const records = capture()
    const log = createLogger('web:example')
    setActiveLevelController(createLevelController({ boot: 'warn' }))
    render(<DiagnosticLoggingSubsection />)

    log.debug('before')
    fireEvent.click(screen.getByTestId('log-level-raise'))
    log.debug('after')

    expect(records.map((r) => r.msg)).not.toContain('before')
    expect(records.map((r) => r.msg)).toContain('after')
  })

  it('offers the way back, and takes it', () => {
    const records = capture()
    const log = createLogger('web:example')
    setActiveLevelController(createLevelController({ boot: 'warn' }))
    render(<DiagnosticLoggingSubsection />)

    fireEvent.click(screen.getByTestId('log-level-raise'))
    expect(screen.getByTestId('log-level-reset')).toBeTruthy()

    fireEvent.click(screen.getByTestId('log-level-reset'))
    log.debug('after reset')

    expect(records.map((r) => r.msg)).not.toContain('after reset')
    expect(screen.getByTestId('log-level-raise')).toBeTruthy()
  })

  it('turns itself back down when the half hour is up', () => {
    // The row must stop claiming "on" without anyone pressing anything: this is
    // the property that makes leaving the page a safe thing to do.
    const records = capture()
    const log = createLogger('web:example')
    setActiveLevelController(createLevelController({ boot: 'warn' }))
    render(<DiagnosticLoggingSubsection />)

    fireEvent.click(screen.getByTestId('log-level-raise'))
    // Inside `act` because the row re-reads the status on a timer: without it
    // the level would revert while the rendered row still claimed "on", which
    // is exactly the disagreement this test is here to refuse.
    act(() => vi.advanceTimersByTime(AFFORDANCE_TTL_MS + 5001))
    log.debug('long after')

    expect(records.map((r) => r.msg)).not.toContain('long after')
    expect(screen.getByTestId('log-level-raise')).toBeTruthy()
  })
})
