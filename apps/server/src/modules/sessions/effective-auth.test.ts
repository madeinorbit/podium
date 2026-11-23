/**
 * WHAT THE HARNESS SAID AGAINST WHAT WAS CHOSEN (credential management §9
 * "Launching", epic plan Task 10, acceptance 5 and 7). Fingerprints and
 * addresses below are obviously fake.
 */

import { asCredentialId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { judgeEffectiveAuth } from './effective-auth'

const KEY = {
  credentialId: asCredentialId('cred_00000000-0000-4000-8000-00000000000a'),
  type: 'anthropic.api-key',
  identity: { fingerprint: 'fp-key-chosen' },
}
const LOGIN = {
  credentialId: asCredentialId('cred_00000000-0000-4000-8000-00000000000b'),
  type: 'anthropic.claude-login',
  identity: { fingerprint: 'fp-login-chosen', email: 'chosen@example.invalid' },
}

describe('judgeEffectiveAuth', () => {
  it('an API key the harness read as delivered: the chosen fingerprint, no mismatch', () => {
    expect(
      judgeEffectiveAuth({ method: 'api-key', source: 'ANTHROPIC_API_KEY', delivered: true }, KEY),
    ).toEqual({ effectiveAuth: { method: 'api-key', fingerprint: 'fp-key-chosen' } })
  })

  it('a subscription answer for an API-key choice is a mismatch with both identities', () => {
    const judged = judgeEffectiveAuth(
      {
        method: 'subscription',
        identity: { email: 'other@example.invalid', fingerprint: 'fp-other' },
      },
      KEY,
    )
    expect(judged).toEqual({
      effectiveAuth: {
        method: 'subscription',
        fingerprint: 'fp-other',
        email: 'other@example.invalid',
      },
      credentialMismatch: {
        chosen: { credentialId: KEY.credentialId, method: 'api-key', fingerprint: 'fp-key-chosen' },
        reported: {
          method: 'subscription',
          fingerprint: 'fp-other',
          email: 'other@example.invalid',
        },
      },
    })
  })

  it('a key that was not the delivered value is a mismatch, though the method agrees', () => {
    const judged = judgeEffectiveAuth(
      { method: 'api-key', source: 'ANTHROPIC_API_KEY', delivered: false },
      KEY,
    )
    expect(judged.effectiveAuth).toEqual({ method: 'api-key' })
    expect(judged.credentialMismatch?.chosen.credentialId).toBe(KEY.credentialId)
  })

  it('a login on another account is a mismatch; the same account is not', () => {
    expect(
      judgeEffectiveAuth(
        { method: 'subscription', identity: { email: 'x@example.invalid', fingerprint: 'fp-x' } },
        LOGIN,
      ).credentialMismatch,
    ).toEqual({
      chosen: {
        credentialId: LOGIN.credentialId,
        method: 'subscription',
        fingerprint: 'fp-login-chosen',
        email: 'chosen@example.invalid',
      },
      reported: { method: 'subscription', fingerprint: 'fp-x', email: 'x@example.invalid' },
    })
    expect(
      judgeEffectiveAuth(
        {
          method: 'subscription',
          identity: { email: 'chosen@example.invalid', fingerprint: 'fp-login-chosen' },
        },
        LOGIN,
      ),
    ).toEqual({
      effectiveAuth: {
        method: 'subscription',
        fingerprint: 'fp-login-chosen',
        email: 'chosen@example.invalid',
      },
    })
  })

  it('a harness that cannot say is `unknown` and never a mismatch', () => {
    expect(judgeEffectiveAuth({ method: 'unknown' }, KEY)).toEqual({
      effectiveAuth: { method: 'unknown' },
    })
  })

  it("no credential chosen (the harness's own login) is never a mismatch", () => {
    expect(
      judgeEffectiveAuth(
        {
          method: 'subscription',
          identity: { email: 'own@example.invalid', fingerprint: 'fp-own' },
        },
        null,
      ),
    ).toEqual({
      effectiveAuth: {
        method: 'subscription',
        fingerprint: 'fp-own',
        email: 'own@example.invalid',
      },
    })
  })
})
