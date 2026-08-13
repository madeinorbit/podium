import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { UserId } from '@podium/model'
import {
  mobilePairingPhraseFromDigest,
  type MobileDelivery,
  type MobilePairClaimRequest,
  type MobilePairStatusResponse,
  type MobilePlatform,
} from '@podium/protocol'

export const MOBILE_PAIRING_TTL_MS = 2 * 60_000

interface ClaimedMobileDevice {
  claimId: string
  claimHash: string
  deviceId: string
  deviceName: string
  platform: MobilePlatform
  delivery: MobileDelivery
  phrase: [string, string, string]
}

interface MobileGrant {
  pairingId: string
  pairCode: string
  userId: UserId
  expiresAtMs: number
  state: 'pending' | 'claimed' | 'approved' | 'denied' | 'completed'
  failedSecretAttempts: number
  claim?: ClaimedMobileDevice
}

export interface CompletedMobilePairing {
  pairingId: string
  userId: UserId
  deviceId: string
  deviceName: string
  platform: MobilePlatform
  delivery: MobileDelivery
}

type RandomToken = (bytes: number) => string

function defaultRandomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

/** In-memory, restart-expiring mobile grants. Deliberately separate from daemon enrollment. */
export class MobilePairingManager {
  private readonly byPairingId = new Map<string, MobileGrant>()
  private readonly pairingIdByCode = new Map<string, string>()
  private readonly pairingIdByClaim = new Map<string, string>()

  constructor(
    private readonly opts: {
      ttlMs?: number
      randomToken?: RandomToken
      phraseDigest?: (pairCode: string, claimId: string, claimHash: string) => Uint8Array
      maxSecretFailures?: number
    } = {},
  ) {}

  private randomToken(bytes: number): string {
    return (this.opts.randomToken ?? defaultRandomToken)(bytes)
  }

  private sweep(nowMs: number): void {
    for (const [pairingId, grant] of this.byPairingId) {
      if (grant.expiresAtMs > nowMs) continue
      this.byPairingId.delete(pairingId)
      this.pairingIdByCode.delete(grant.pairCode)
      if (grant.claim) this.pairingIdByClaim.delete(grant.claim.claimId)
    }
  }

  mint(
    userId: UserId,
    nowMs: number = Date.now(),
  ): {
    pairingId: string
    pairCode: string
    expiresAt: string
  } {
    this.sweep(nowMs)
    let pairingId = this.randomToken(18)
    while (this.byPairingId.has(pairingId)) pairingId = this.randomToken(18)
    let pairCode = this.randomToken(32)
    while (this.pairingIdByCode.has(pairCode)) pairCode = this.randomToken(32)
    const expiresAtMs = nowMs + (this.opts.ttlMs ?? MOBILE_PAIRING_TTL_MS)
    const grant: MobileGrant = {
      pairingId,
      pairCode,
      userId,
      expiresAtMs,
      state: 'pending',
      failedSecretAttempts: 0,
    }
    this.byPairingId.set(pairingId, grant)
    this.pairingIdByCode.set(pairCode, pairingId)
    return {
      pairingId,
      pairCode,
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
  }

  claim(
    input: MobilePairClaimRequest,
    nowMs: number = Date.now(),
  ): { claimId: string; phrase: [string, string, string]; expiresAt: string } | undefined {
    this.sweep(nowMs)
    const pairingId = this.pairingIdByCode.get(input.pairCode)
    if (!pairingId) return undefined
    const grant = this.byPairingId.get(pairingId)
    if (!grant || grant.state !== 'pending') return undefined

    let claimId = this.randomToken(18)
    while (this.pairingIdByClaim.has(claimId)) claimId = this.randomToken(18)
    const digest = this.opts.phraseDigest
      ? this.opts.phraseDigest(input.pairCode, claimId, input.claimHash)
      : createHmac('sha256', input.pairCode)
          .update(`podium-mobile-phrase\0${claimId}\0${input.claimHash}`)
          .digest()
    const phrase = mobilePairingPhraseFromDigest(digest)
    grant.claim = {
      claimId,
      claimHash: input.claimHash,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      platform: input.platform,
      delivery: input.delivery,
      phrase,
    }
    grant.state = 'claimed'
    this.pairingIdByCode.delete(input.pairCode)
    this.pairingIdByClaim.set(claimId, pairingId)
    return {
      claimId,
      phrase,
      expiresAt: new Date(grant.expiresAtMs).toISOString(),
    }
  }

  status(pairingId: string, userId: UserId, nowMs: number = Date.now()): MobilePairStatusResponse {
    this.sweep(nowMs)
    const grant = this.byPairingId.get(pairingId)
    if (!grant || grant.userId !== userId) return { state: 'expired' }
    if (grant.state === 'pending') {
      return {
        state: 'pending',
        expiresAt: new Date(grant.expiresAtMs).toISOString(),
      }
    }
    if (grant.state === 'denied' || grant.state === 'completed') return { state: grant.state }
    const claim = grant.claim
    if (!claim) return { state: 'expired' }
    return {
      state: grant.state,
      expiresAt: new Date(grant.expiresAtMs).toISOString(),
      deviceId: claim.deviceId,
      deviceName: claim.deviceName,
      platform: claim.platform,
      delivery: claim.delivery,
      phrase: claim.phrase,
    }
  }

  decide(
    pairingId: string,
    userId: UserId,
    decision: 'approved' | 'denied',
    nowMs: number = Date.now(),
  ): boolean {
    this.sweep(nowMs)
    const grant = this.byPairingId.get(pairingId)
    if (!grant || grant.userId !== userId || grant.state !== 'claimed' || !grant.claim) return false
    grant.state = decision
    if (decision === 'denied') this.pairingIdByClaim.delete(grant.claim.claimId)
    return true
  }

  complete(
    claimId: string,
    claimSecret: string,
    nowMs: number = Date.now(),
  ): CompletedMobilePairing | 'pending' | undefined {
    this.sweep(nowMs)
    const pairingId = this.pairingIdByClaim.get(claimId)
    if (!pairingId) return undefined
    const grant = this.byPairingId.get(pairingId)
    const claim = grant?.claim
    if (!grant || !claim || (grant.state !== 'claimed' && grant.state !== 'approved'))
      return undefined
    const actual = Buffer.from(claim.claimHash, 'hex')
    // Hash the secret with SHA-256 without keeping its plaintext beyond this call.
    const computed = awaitlessSha256(claimSecret)
    if (actual.length !== computed.length || !timingSafeEqual(actual, computed)) {
      grant.failedSecretAttempts += 1
      if (grant.failedSecretAttempts >= (this.opts.maxSecretFailures ?? 5)) {
        grant.state = 'denied'
        this.pairingIdByClaim.delete(claimId)
      }
      return undefined
    }
    if (grant.state === 'claimed') return 'pending'
    grant.state = 'completed'
    this.pairingIdByClaim.delete(claimId)
    return {
      pairingId,
      userId: grant.userId,
      deviceId: claim.deviceId,
      deviceName: claim.deviceName,
      platform: claim.platform,
      delivery: claim.delivery,
    }
  }
}

function awaitlessSha256(value: string): Buffer {
  // Kept as a helper so completion's comparison remains visibly constant-time.
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== 32 || decoded.toString('base64url') !== value) return Buffer.alloc(0)
  return createHash('sha256').update(decoded).digest()
}
