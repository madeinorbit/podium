import { describe, expect, it } from 'vitest'
import { sessionHasTerminal } from './session-status'

// ---------------------------------------------------------------------------
// POD-2290 — "does the native view have anything behind it". Three lines of
// code, and the reason they get their own file is that the DEFAULT is the whole
// safety argument: this predicate is what every client consults, and it is the
// single place where a missing driver family becomes a decision.
// ---------------------------------------------------------------------------

describe('sessionHasTerminal', () => {
  it('says no for the families that have no PTY', () => {
    // A server-driven session runs its agent as a server child and an embedded
    // one as an in-process loop. Neither ever gets a PTY, so the native pane
    // would attach to nothing and spin forever.
    expect(sessionHasTerminal({ driverFamily: 'server' })).toBe(false)
    expect(sessionHasTerminal({ driverFamily: 'embedded' })).toBe(false)
  })

  it('says yes for the terminal family', () => {
    expect(sessionHasTerminal({ driverFamily: 'terminal' })).toBe(true)
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
