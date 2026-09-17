import { randomBytes } from 'node:crypto'
import type { PairingGrant } from '../modules/machines/service'
export type { PairingGrant } from '../modules/machines/service'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I/O/0/1
function defaultCode(): string {
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) {
    out += ALPHABET[(bytes[i] as number) % ALPHABET.length]
    if (i === 3) out += '-'
  }
  return out
}

/** Short-lived, single-use pairing codes, held in memory. Lost on restart by design. */
export const PAIR_CODE_TTL_MS = 10 * 60_000
export const PAIR_MINTS_PER_MINUTE = 5
export const PAIR_REDEMPTIONS_PER_MINUTE = 120
const MAX_OUTSTANDING_CODES = 1024

export class PairingManager {
  private readonly codes = new Map<string, { expiresAtMs: number; grant: PairingGrant }>()
  private readonly randomCode: () => string
  private readonly ttlMs: number
  private readonly installationId?: string
  private readonly minted = new Map<string, { start: number; count: number }>()
  private attempts = { start: 0, count: 0 }
  private admit(bucket: { start: number; count: number }, limit: number, now: number): boolean {
    if (now < bucket.start || now - bucket.start >= 60_000) { bucket.start = now; bucket.count = 0 }
    return ++bucket.count <= limit
  }
  constructor(opts: { randomCode?: () => string; ttlMs?: number; installationId?: string } = {}) {
    this.randomCode = opts.randomCode ?? defaultCode
    this.ttlMs = opts.ttlMs ?? PAIR_CODE_TTL_MS
    this.installationId = opts.installationId
  }
  mint(grant: PairingGrant = {}, nowMs = Date.now()): string {
    for (const [code, entry] of this.codes) if (nowMs >= entry.expiresAtMs) this.codes.delete(code)
    for (const [owner, bucket] of this.minted) if (nowMs - bucket.start >= 60_000) this.minted.delete(owner)
    const owner = grant.ownerUserId ?? ''
    const bucket = this.minted.get(owner) ?? { start: nowMs, count: 0 }
    this.minted.set(owner, bucket)
    if (!this.admit(bucket, PAIR_MINTS_PER_MINUTE, nowMs) || this.codes.size >= MAX_OUTSTANDING_CODES) {
      throw new Error('pairing code rate limit exceeded')
    }
    const code = this.randomCode()
    if (this.codes.has(code)) throw new Error('pairing code collision')
    this.codes.set(code, { expiresAtMs: nowMs + this.ttlMs, grant: { ...grant, ...(this.installationId === undefined ? {} : { installationId: this.installationId }) } })
    return code
  }
  peek(code: string, nowMs = Date.now()): PairingGrant | undefined {
    const entry = this.codes.get(code)
    return entry && nowMs < entry.expiresAtMs ? { ...entry.grant } : undefined
  }
  redeem(code: string, nowMs = Date.now()): PairingGrant | undefined {
    // Installation-wide bound cannot be reset by opening a new connection or inventing a machine id.
    if (!this.admit(this.attempts, PAIR_REDEMPTIONS_PER_MINUTE, nowMs)) return undefined
    const entry = this.codes.get(code)
    if (entry === undefined) return undefined
    this.codes.delete(code) // single-use regardless of outcome
    return nowMs < entry.expiresAtMs ? { ...entry.grant } : undefined
  }
}
