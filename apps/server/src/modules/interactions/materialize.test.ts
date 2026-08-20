/**
 * THE FAILURE → INTERACTION GATE (POD-2414) — the classification table, as
 * tests. Pure input/output; the durable half is exercised in `service.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { failureDisposition, materializeFailure } from './materialize'

describe('materializeFailure — turn failures', () => {
  it('an auth-expired failure becomes a login ask naming the provider', () => {
    expect(
      materializeFailure({
        evidence: 'turn-failed',
        reason: 'auth-expired',
        disposition: 'needs-human',
        provider: 'claude',
      }),
    ).toEqual({
      kind: 'login',
      payload: { v: 1, provider: 'claude', reason: 'auth-expired' },
    })
  })

  it('a context-overflow failure becomes a recovery ask offering a resume', () => {
    const spec = materializeFailure({
      evidence: 'turn-failed',
      reason: 'context-overflow',
      disposition: 'needs-human',
    })
    expect(spec?.kind).toBe('recovery')
    expect(spec?.kind === 'recovery' && spec.payload.reason).toBe('context-overflow')
    // `fresh-session` and `summary-resume` are NOT offered: the first is a
    // different verb and the second is a harness capability nothing proved.
    expect(spec?.kind === 'recovery' && spec.payload.offered).toEqual(['full-resume', 'abandon'])
  })

  it('every OTHER needs-human failure still materializes, as an unknown recovery', () => {
    // This is the gap POD-2414 closes: before it, only auth-shaped failures
    // produced anything, so a provider error the driver classified needs-human
    // left the session blocked with nothing on any list.
    const spec = materializeFailure({
      evidence: 'turn-failed',
      reason: 'provider-error',
      disposition: 'needs-human',
      detail: 'insufficient credit',
    })
    expect(spec?.kind).toBe('recovery')
    expect(spec?.kind === 'recovery' && spec.payload.reason).toBe('unknown')
    expect(spec?.kind === 'recovery' && spec.payload.prompt).toContain('insufficient credit')
  })

  it('a retryable failure materializes NOTHING', () => {
    // A rate-limit the harness will retry is not a blocked session, and a row
    // for it would dilute the one property the list promises.
    expect(
      materializeFailure({
        evidence: 'turn-failed',
        reason: 'rate-limit',
        disposition: 'retryable',
      }),
    ).toBeNull()
  })

  it('a fatal failure materializes NOTHING — the process is gone', () => {
    expect(
      materializeFailure({ evidence: 'turn-failed', reason: 'timeout', disposition: 'fatal' }),
    ).toBeNull()
  })
})

describe('materializeFailure — legacy agent-state errors', () => {
  it('an auth-shaped error class is needs-human WHATEVER the retry hint says', () => {
    // `retryable` means "a blind continue is worth offering", and continuing
    // past an expired credential re-fails. This is also what keeps the shipped
    // `errored` → `login` behaviour byte-identical.
    expect(
      failureDisposition({
        evidence: 'agent-state',
        errorClass: 'authentication',
        retryable: true,
      }),
    ).toBe('needs-human')
    expect(
      materializeFailure({
        evidence: 'agent-state',
        errorClass: 'authentication',
        retryable: false,
      }),
    ).toEqual({
      kind: 'login',
      payload: { v: 1, provider: 'authentication', reason: 'auth-expired' },
    })
  })

  it('a billing failure — non-retryable, not auth — becomes an answerable recovery', () => {
    const spec = materializeFailure({
      evidence: 'agent-state',
      errorClass: 'billing_error',
      retryable: false,
    })
    expect(spec?.kind).toBe('recovery')
    expect(spec?.kind === 'recovery' && spec.payload.prompt).toContain('billing_error')
  })

  it('a retryable non-auth error class materializes nothing', () => {
    expect(
      materializeFailure({ evidence: 'agent-state', errorClass: 'overloaded', retryable: true }),
    ).toBeNull()
  })
})
