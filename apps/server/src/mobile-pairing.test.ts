import { createHash } from 'node:crypto'
import { FIRST_ADMIN_USER_ID, asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { MobilePairingManager } from './mobile-pairing'

const SECRET = Buffer.alloc(32, 7)
const CLAIM_HASH = createHash('sha256').update(SECRET).digest('hex')

function manager(ttlMs = 1_000) {
  let token = 0
  return new MobilePairingManager({
    ttlMs,
    randomToken: () => `token-${++token}`,
    phraseDigest: () => Uint8Array.from([0, 0, 0, 0, 0]),
  })
}

const claimInput = {
  pairCode: '',
  claimHash: CLAIM_HASH,
  deviceId: 'device-1',
  deviceName: "Sam's iPhone",
  platform: 'ios' as const,
}

describe('MobilePairingManager', () => {
  it('binds approval to the minting user and completes exactly once', () => {
    const pairing = manager()
    const grant = pairing.mint(FIRST_ADMIN_USER_ID, 100)
    const claim = pairing.claim({ ...claimInput, pairCode: grant.pairCode }, 'native', 101)
    expect(claim).toEqual({
      claimId: 'token-3',
      phrase: ['amberanchor', 'amberanchor', 'amberanchor'],
      expiresAt: new Date(1_100).toISOString(),
    })
    expect(
      pairing.claim({ ...claimInput, pairCode: grant.pairCode }, 'native', 102),
    ).toBeUndefined()
    expect(pairing.decide(grant.pairingId, asUserId('user:other'), 'approved', 103)).toBe(false)
    expect(pairing.decide(grant.pairingId, FIRST_ADMIN_USER_ID, 'approved', 103)).toBe(true)
    expect(
      pairing.complete(claim!.claimId, Buffer.alloc(32, 8).toString('base64url'), 104),
    ).toBe('invalid-secret')
    expect(pairing.complete(claim!.claimId, SECRET.toString('base64url'), 104)).toEqual({
      pairingId: grant.pairingId,
      userId: FIRST_ADMIN_USER_ID,
      deviceId: 'device-1',
      deviceName: "Sam's iPhone",
      platform: 'ios',
      delivery: 'native',
    })
    expect(pairing.complete(claim!.claimId, SECRET.toString('base64url'), 105)).toBe(
      'unavailable',
    )
  })

  it('reports pending only to the holder of the claim secret', () => {
    const pairing = manager()
    const grant = pairing.mint(FIRST_ADMIN_USER_ID, 100)
    const claim = pairing.claim({ ...claimInput, pairCode: grant.pairCode }, 'native', 101)!
    expect(pairing.complete(claim.claimId, SECRET.toString('base64url'), 102)).toBe('pending')
    expect(
      pairing.complete(claim.claimId, Buffer.alloc(32, 3).toString('base64url'), 102),
    ).toBe('invalid-secret')
  })

  it('destroys a claim after too many wrong completion secrets', () => {
    let token = 0
    const pairing = new MobilePairingManager({
      maxSecretFailures: 2,
      randomToken: () => `token-${++token}`,
      phraseDigest: () => Uint8Array.from([0, 0, 0, 0, 0]),
    })
    const grant = pairing.mint(FIRST_ADMIN_USER_ID, 100)
    const claim = pairing.claim({ ...claimInput, pairCode: grant.pairCode }, 'native', 101)!
    const wrong = Buffer.alloc(32, 3).toString('base64url')
    expect(pairing.complete(claim.claimId, wrong, 102)).toBe('invalid-secret')
    expect(pairing.complete(claim.claimId, wrong, 103)).toBe('invalid-secret')
    expect(pairing.status(grant.pairingId, FIRST_ADMIN_USER_ID, 104)).toEqual({
      state: 'denied',
    })
    expect(pairing.complete(claim.claimId, SECRET.toString('base64url'), 104)).toBe('unavailable')
  })

  it('expires on server time and treats absent restart state as expired', () => {
    const pairing = manager(10)
    const grant = pairing.mint(FIRST_ADMIN_USER_ID, 100)
    expect(pairing.status(grant.pairingId, FIRST_ADMIN_USER_ID, 109)).toEqual({
      state: 'pending',
      expiresAt: new Date(110).toISOString(),
    })
    expect(pairing.status(grant.pairingId, FIRST_ADMIN_USER_ID, 110)).toEqual({
      state: 'expired',
    })
    expect(manager().status(grant.pairingId, FIRST_ADMIN_USER_ID, 101)).toEqual({
      state: 'expired',
    })
  })

  it('lets only the owner cancel an unclaimed grant while approval still requires a claim', () => {
    const pairing = manager()
    const grant = pairing.mint(FIRST_ADMIN_USER_ID, 100)
    expect(pairing.decide(grant.pairingId, FIRST_ADMIN_USER_ID, 'approved', 101)).toBe(false)
    expect(
      pairing.decide(grant.pairingId, asUserId('user:other'), 'denied', 101),
    ).toBe(false)
    expect(pairing.decide(grant.pairingId, FIRST_ADMIN_USER_ID, 'denied', 102)).toBe(true)
    expect(pairing.status(grant.pairingId, FIRST_ADMIN_USER_ID, 103)).toEqual({
      state: 'denied',
    })
    expect(
      pairing.claim({ ...claimInput, pairCode: grant.pairCode }, 'native', 103),
    ).toBeUndefined()
  })

  it('denies without minting and does not expose wrong-kind daemon grants', () => {
    const pairing = manager()
    const grant = pairing.mint(FIRST_ADMIN_USER_ID, 100)
    pairing.claim({ ...claimInput, pairCode: grant.pairCode }, 'native', 101)
    expect(pairing.decide(grant.pairingId, FIRST_ADMIN_USER_ID, 'denied', 102)).toBe(true)
    expect(pairing.status(grant.pairingId, FIRST_ADMIN_USER_ID, 103)).toEqual({
      state: 'denied',
    })
    expect(pairing.complete('token-3', SECRET.toString('base64url'), 103)).toBe('unavailable')
    expect(
      pairing.claim({ ...claimInput, pairCode: 'AB12-CD34' }, 'native', 103),
    ).toBeUndefined()
  })
})
