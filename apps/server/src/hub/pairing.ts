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
export interface PairingGrant {
  /** Copy allowlisted native agent logins from an already-owned online machine. */
  copyAgentCredentials?: boolean
}

export class PairingManager {
  private readonly codes = new Map<string, { expiresAtMs: number; grant: PairingGrant }>()
  private readonly randomCode: () => string
  private readonly ttlMs: number
  constructor(opts: { randomCode?: () => string; ttlMs?: number } = {}) {
    this.randomCode = opts.randomCode ?? defaultCode
    // A one-paste bare-machine install may need to bootstrap a package manager and
    // downloader before Podium can redeem the code. Keep it single-use/in-memory,
    // but leave enough wall time for slow or emulated architectures.
    this.ttlMs = opts.ttlMs ?? 60 * 60_000
  }
  mint(grant: PairingGrant = {}, nowMs = Date.now()): string {
    const code = this.randomCode()
    this.codes.set(code, { expiresAtMs: nowMs + this.ttlMs, grant: { ...grant } })
    return code
  }
  redeem(code: string, nowMs = Date.now()): PairingGrant | undefined {
    const entry = this.codes.get(code)
    if (entry === undefined) return undefined
    this.codes.delete(code) // single-use regardless of outcome
    return nowMs <= entry.expiresAtMs ? { ...entry.grant } : undefined
  }
}
