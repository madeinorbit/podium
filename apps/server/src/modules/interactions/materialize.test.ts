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
    // ONLY what the answer path can perform. `fresh-session` is a different
    // verb, `summary-resume` a harness capability nothing proved, and `abandon`
    // was removed because its only delivery route WOKE the session it claimed
    // to stop (POD-2414 review).
    expect(spec?.kind === 'recovery' && spec.payload.offered).toEqual(['full-resume'])
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
    expect(spec?.kind === 'recovery' && spec.payload.prompt).toBe(
      'This session stopped on a failure it cannot resolve by retrying (provider-error) — insufficient credit.',
    )
    expect(spec?.kind === 'recovery' && spec.payload.prompt).not.toContain('Resume')
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
      detail: 'insufficient credit',
    })
    expect(spec?.kind).toBe('recovery')
    expect(spec?.kind === 'recovery' && spec.payload.prompt).toBe(
      'This session stopped because the provider reported a billing problem (billing_error) — insufficient credit.',
    )
    expect(spec?.kind === 'recovery' && spec.payload.prompt).not.toContain('Resume')
  })

  it('keeps a usage-limit detail in the state-derived recovery prompt', () => {
    const spec = materializeFailure({
      evidence: 'agent-state',
      errorClass: 'usage_limit',
      retryable: false,
      detail: 'API error (status 402 Payment Required): balance exhausted',
    })
    expect(spec?.kind).toBe('recovery')
    expect(spec?.kind === 'recovery' && spec.payload.prompt).toBe(
      'This session stopped because the provider usage limit was reached (usage_limit) — API error (status 402 Payment Required): balance exhausted.',
    )
  })

  it('a retryable non-auth error class materializes nothing', () => {
    expect(
      materializeFailure({ evidence: 'agent-state', errorClass: 'overloaded', retryable: true }),
    ).toBeNull()
  })
})
