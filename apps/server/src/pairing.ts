import { randomBytes } from 'node:crypto'

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
export class PairingManager {
  private readonly codes = new Map<string, number>() // code -> expiresAtMs
  private readonly randomCode: () => string
  private readonly ttlMs: number
  constructor(opts: { randomCode?: () => string; ttlMs?: number } = {}) {
    this.randomCode = opts.randomCode ?? defaultCode
    this.ttlMs = opts.ttlMs ?? 600_000
  }
  mint(nowMs = Date.now()): string {
    const code = this.randomCode()
    this.codes.set(code, nowMs + this.ttlMs)
    return code
  }
  redeem(code: string, nowMs = Date.now()): boolean {
    const exp = this.codes.get(code)
    if (exp === undefined) return false
    this.codes.delete(code) // single-use regardless of outcome
    return nowMs <= exp
  }
}
