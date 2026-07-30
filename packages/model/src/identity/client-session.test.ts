import { describe, expect, it } from 'vitest'
import { asDeviceId, asUserId } from '../ids/brands'
import { ClientSessionAggregate } from './client-session'

const row = (over: Record<string, unknown> = {}) => ({
  device: asDeviceId('client:conn-1'),
  user: asUserId('user:sole'),
  createdAt: '2026-07-30T00:00:00.000Z',
  expiresAt: '2026-08-30T00:00:00.000Z',
  ...over,
})

describe('device and person are TWO answers, not one (ADR 9 D1.3)', () => {
  it('carries both halves, and neither is optional', () => {
    expect(ClientSessionAggregate.safeParse(row()).success).toBe(true)

    for (const half of ['device', 'user']) {
      const { [half]: _dropped, ...partial } = row() as Record<string, unknown>
      expect(ClientSessionAggregate.safeParse(partial).success).toBe(false)
    }
  })

  it('lets two devices belong to ONE person, and two people share none', () => {
    // The property the column exists for, stated as data rather than prose: the
    // same user on two connections is two rows, and the device is what tells
    // them apart. Before the column, "which device" and "who" had one answer.
    const laptop = ClientSessionAggregate.parse(row({ device: asDeviceId('client:a') }))
    const phone = ClientSessionAggregate.parse(row({ device: asDeviceId('client:b') }))
    expect(laptop.user).toBe(phone.user)
    expect(laptop.device).not.toBe(phone.device)

    const other = ClientSessionAggregate.parse(row({ user: asUserId('user:bob') }))
    expect(other.user).not.toBe(laptop.user)
  })
})

describe('the token material never rides the row (ADR 1 D6, ADR 9 D3 secrets)', () => {
  it('carries no token, hash or secret-shaped key', () => {
    // The matrix classes this row `secret-presence`: a replica may know a device
    // session EXISTS without holding the material that would let it act as one.
    // The token PREIMAGE is named explicitly in ADR 9 D3's `secrets` class.
    const SECRET_SHAPED = /token|secret|password|hash|preimage/i
    for (const key of Object.keys(ClientSessionAggregate.shape)) {
      expect(key).not.toMatch(SECRET_SHAPED)
    }
  })

  it('DETECTS a token put back on the row — the check can say NO', () => {
    const leaky = ClientSessionAggregate.extend({ tokenHash: asUserId as never })
    const SECRET_SHAPED = /token|secret|password|hash|preimage/i
    expect(Object.keys(leaky.shape).filter((k) => SECRET_SHAPED.test(k))).toEqual(['tokenHash'])
  })
})

describe('it is per-user state, so the user IS the owner', () => {
  it('has no owner column that could differ from `user`', () => {
    // A second owner column would make a NON-GRANTABLE class shareable by
    // accident (ADR 9 D3 rule 4 — there is no "share my logged-in device" verb).
    expect(ClientSessionAggregate.shape).not.toHaveProperty('owner')
    expect(ClientSessionAggregate.shape).not.toHaveProperty('visibility')
    expect(ClientSessionAggregate.shape).toHaveProperty('user')
  })

  it('carries no instance partition — multi-user is not multi-tenancy', () => {
    for (const key of Object.keys(ClientSessionAggregate.shape)) {
      expect(key.toLowerCase()).not.toContain('instanceid')
      expect(key.toLowerCase()).not.toContain('tenant')
    }
  })
})
