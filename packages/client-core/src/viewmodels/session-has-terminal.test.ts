import { describe, expect, it } from 'vitest'
import { sessionHasTerminal, sessionTerminalOutlook } from './session-status'

// ---------------------------------------------------------------------------
// POD-2290 — "does the native view have anything behind it". Three lines of
// code, and the reason they get their own file is that the DEFAULT is the whole
// safety argument: this predicate is what every client consults, and it is the
// single place where a missing driver family becomes a decision.
// ---------------------------------------------------------------------------

describe('sessionHasTerminal', () => {
  it('says no for the embedded family', () => {
    expect(sessionHasTerminal({ driverFamily: 'embedded' })).toBe(false)
  })

  it('says yes for engine terminals and server-family client terminals', () => {
    expect(sessionHasTerminal({ driverFamily: 'terminal' })).toBe(true)
    expect(sessionHasTerminal({ driverFamily: 'server' })).toBe(true)
  })

  it('READS UNKNOWN AS A TERMINAL — the direction the whole fix depends on', () => {
    // `driverFamily` rides the transient `driverId`, so it is legitimately
    // missing for an older daemon, a legacy session, a row that has not bound
    // yet, and a parked one. Unknown therefore has to mean "behave as before
    // driver families existed", which for every session that has ever existed
    // is: it has a terminal.
    //
    // The counterfactual matters more than the case. Failing the other way would
    // strand a working PTY session on the chat view — with the switch withheld,
    // because the same predicate gates it — every time a bind frame was late.
    expect(sessionHasTerminal({})).toBe(true)
    expect(sessionHasTerminal({ driverFamily: undefined })).toBe(true)
    expect(sessionHasTerminal(undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// POD-2290 ROUND TWO. The operator retested the two-valued version live and it
// still showed the dead pane, because collapsing `unknown` into `true` is right
// for a legacy row and wrong for a session that has not started yet — and a
// measured opencode spawn spends TWELVE SECONDS there.
// ---------------------------------------------------------------------------

describe('sessionTerminalOutlook', () => {
  it('keeps "nobody has said yet" as its own answer', () => {
    // The distinction the two-valued predicate could not express, and the one
    // the panel needs in order to wait instead of guessing.
    expect(sessionTerminalOutlook(undefined)).toBe('unknown')
    expect(sessionTerminalOutlook({})).toBe('unknown')
    expect(sessionTerminalOutlook({ driverFamily: undefined })).toBe('unknown')
  })

  it('answers the known families', () => {
    expect(sessionTerminalOutlook({ driverFamily: 'terminal' })).toBe('terminal')
    expect(sessionTerminalOutlook({ driverFamily: 'server' })).toBe('terminal')
    expect(sessionTerminalOutlook({ driverFamily: 'embedded' })).toBe('none')
  })

  it('prefers the RuntimeDriver attach contract after fresh hydration', () => {
    expect(sessionTerminalOutlook({ attachKinds: ['client'] })).toBe('terminal')
    expect(sessionTerminalOutlook({ attachKinds: ['engine'] })).toBe('terminal')
    expect(sessionTerminalOutlook({ attachKinds: [], driverFamily: 'server' })).toBe('none')
  })

  it('is what the two-valued reading is built from, so they cannot disagree', () => {
    for (const family of ['terminal', 'server', 'embedded', undefined] as const) {
      const session = family === undefined ? {} : { driverFamily: family }
      expect(sessionHasTerminal(session), String(family)).toBe(
        sessionTerminalOutlook(session) !== 'none',
      )
    }
  })
})
