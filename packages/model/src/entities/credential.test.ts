import { describe, expect, it } from 'vitest'
import { CredentialView } from './credential'

const full = {
  id: 'cred_0190f2a4-7c1e-7d3a-9b5e-2f6c8d4a1e71',
  ownerUserId: 'user-1',
  label: 'Work Claude',
  type: 'anthropic.claude-login',
  identity: {
    fingerprint: 'fp-1',
    email: 'person@example.com',
    plan: 'max',
    organisation: 'Example',
  },
  status: 'attention',
  statusReason: 'The login expired.',
  limitReachedUntil: '2026-11-13T05:00:00.000Z',
  expiresAt: '2027-11-13T00:00:00.000Z',
  verifiedAt: '2026-11-13T00:00:00.000Z',
  homes: [{ machineId: 'machine-1', homeId: 'default', state: 'in' }],
  allowedMachines: ['machine-2'],
  sessionCount: 2,
  access: 'owner',
}

describe('CredentialView', () => {
  it('parses a full view unchanged', () => {
    expect(CredentialView.parse(full)).toEqual(full)
  })

  it('parses a minimal view: optional facts absent, lists empty', () => {
    const minimal = {
      id: full.id,
      ownerUserId: 'user-1',
      label: 'Key',
      type: 'openai.api-key',
      identity: {},
      status: 'ok',
      homes: [],
      allowedMachines: [],
      sessionCount: 0,
      access: 'use',
    }
    expect(CredentialView.parse(minimal)).toEqual(minimal)
  })

  it('has no place for a secret: one sent along is dropped', () => {
    const planted = 'fake-secret-planted-for-this-test'
    // Canary: the planted value is really in the input, so its absence below means something.
    expect(JSON.stringify({ ...full, secret: planted })).toContain(planted)
    const parsed = CredentialView.parse({
      ...full,
      secret: planted,
      identity: { ...full.identity, token: planted },
    })
    expect(JSON.stringify(parsed)).not.toContain(planted)
  })

  it('keeps a type id this build does not know, so a newer server still renders', () => {
    expect(CredentialView.parse({ ...full, type: 'future.api-key' }).type).toBe('future.api-key')
  })

  it('refuses an unknown status, access or home state', () => {
    expect(CredentialView.safeParse({ ...full, status: 'fine' }).success).toBe(false)
    expect(CredentialView.safeParse({ ...full, access: 'admin' }).success).toBe(false)
    expect(
      CredentialView.safeParse({
        ...full,
        homes: [{ machineId: 'm', homeId: 'h', state: 'maybe' }],
      }).success,
    ).toBe(false)
    expect(CredentialView.safeParse({ ...full, sessionCount: -1 }).success).toBe(false)
  })
})
