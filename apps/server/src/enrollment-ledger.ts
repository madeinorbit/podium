/**
 * ENROLLMENT LEDGER (POD-1114, ADR 1 Amendment 2 D19.4 / D19.4a / D19.4b / D19.4d).
 *
 * One append-only store at the **state-root tier** (beside `instance.json`, mode
 * `0600`, **outside** the server database). It holds:
 *
 *   - the instance-scoped pairing root
 *   - monotonic enrollment serials
 *   - the recorded machine owner
 *   - revocation entries
 *
 * That these share one durability domain is the correctness condition: where the
 * ledger and the database disagree about enrollment, revocation **or owner**,
 * **the ledger wins**. The ledger is never restored, rewound, or reconciled
 * backwards when the database is.
 *
 * Token shape: a pairing-root MAC over `(machineId, serial, nonce)`. Verification
 * needs only the root — no per-row hash — which is how a missing `machines` row
 * can still be judged (verdict algorithm in D19.4). Client-facing rejection
 * reasons never carry the verdict; server logs do.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { PortableStateWriteFence } from './modules/server-transfer/portable-fence'

const LEDGER_VERSION = 1 as const
const TOKEN_VERSION = 'v1' as const

// ---------------------------------------------------------------------------
// Token mint / verify under the pairing root
// ---------------------------------------------------------------------------

export interface PairingTokenClaims {
  machineId: string
  serial: number
}

/** Mint a root-verifiable pairing token. Serial is the enrollment serial. */
export function mintPairingToken(pairingRoot: Buffer, claims: PairingTokenClaims): string {
  const nonce = randomBytes(16).toString('base64url')
  const payload = `${TOKEN_VERSION}|${claims.machineId}|${claims.serial}|${nonce}`
  const mac = createHmac('sha256', pairingRoot).update(payload).digest()
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${mac.toString('base64url')}`
}

/**
 * Verify a token under this instance's pairing root. Returns claims or `null`
 * (foreign instance, forged, truncated, or stale beyond root rotation).
 * Constant-time on the MAC comparison path.
 */
export function verifyPairingToken(pairingRoot: Buffer, token: string): PairingTokenClaims | null {
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  let payloadBuf: Buffer
  let macBuf: Buffer
  try {
    payloadBuf = Buffer.from(token.slice(0, dot), 'base64url')
    macBuf = Buffer.from(token.slice(dot + 1), 'base64url')
  } catch {
    return null
  }
  if (macBuf.length !== 32) return null
  const expected = createHmac('sha256', pairingRoot).update(payloadBuf).digest()
  if (expected.length !== macBuf.length || !timingSafeEqual(expected, macBuf)) return null
  const payload = payloadBuf.toString('utf8')
  const parts = payload.split('|')
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return null
  const machineId = parts[1]
  const serial = Number(parts[2])
  if (!machineId || !Number.isInteger(serial) || serial < 1) return null
  return { machineId, serial }
}

// ---------------------------------------------------------------------------
// Ledger events
// ---------------------------------------------------------------------------

export type EnrollmentVerdict = 're-enrolled' | 'revoked' | 'unverifiable'

export interface EnrollEvent {
  v: typeof LEDGER_VERSION
  kind: 'enroll'
  /** Idempotency key — re-appending the same id is a no-op. */
  id: string
  machineId: string
  serial: number
  /** Recorded owner at pair time. `null` = unowned (usable by nobody). */
  ownerUserId: string | null
  at: string
}

export interface RevokeEvent {
  v: typeof LEDGER_VERSION
  kind: 'revoke'
  id: string
  machineId: string
  /** Serial of the token being revoked — step 2 compares `serial >= token.serial`. */
  serial: number
  by: string | null
  at: string
}

export interface OwnerEvent {
  v: typeof LEDGER_VERSION
  kind: 'owner'
  id: string
  machineId: string
  ownerUserId: string
  at: string
}

export type LedgerEvent = EnrollEvent | RevokeEvent | OwnerEvent

interface LedgerHeader {
  v: typeof LEDGER_VERSION
  kind: 'header'
  /** Hex-encoded pairing root secret. */
  pairingRoot: string
  createdAt: string
}

type LedgerLine = LedgerHeader | LedgerEvent

function isEvent(line: LedgerLine): line is LedgerEvent {
  return line.kind === 'enroll' || line.kind === 'revoke' || line.kind === 'owner'
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface EnrollmentLedger {
  readonly path: string
  readonly pairingRoot: Buffer
  /** Next enrollment serial for a machine (max known + 1, or 1). */
  nextSerial(machineId: string): number
  /**
   * Highest revoke serial recorded for this machine, or `undefined` if never
   * revoked. Step 2 of the verdict algorithm: deny when this is `>= token.serial`.
   */
  revokeSerial(machineId: string): number | undefined
  /** Latest recorded owner from enroll/owner events, or `undefined` if none. */
  recordedOwner(machineId: string): string | null | undefined
  /** Every machine id that has ever been enrolled (for boot reconcile). */
  enrolledMachineIds(): string[]
  /**
   * Append an enroll event. Idempotent under `id`. Returns false when a prior
   * event with the same id already exists (retry no-op).
   */
  appendEnroll(event: Omit<EnrollEvent, 'v' | 'kind'>): boolean
  appendRevoke(event: Omit<RevokeEvent, 'v' | 'kind'>): boolean
  appendOwner(event: Omit<OwnerEvent, 'v' | 'kind'>): boolean
}

function ledgerPath(stateDir: string): string {
  return join(stateDir, 'enrollment.ledger')
}

function parseLine(raw: string): LedgerLine | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  if (o.v !== LEDGER_VERSION) return null
  if (o.kind === 'header' && typeof o.pairingRoot === 'string') {
    return {
      v: LEDGER_VERSION,
      kind: 'header',
      pairingRoot: o.pairingRoot,
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
    }
  }
  if (
    (o.kind === 'enroll' || o.kind === 'revoke' || o.kind === 'owner') &&
    typeof o.id === 'string' &&
    typeof o.machineId === 'string'
  ) {
    return o as unknown as LedgerEvent
  }
  return null
}

function durableAppend(path: string, line: string): void {
  appendFileSync(path, `${line}\n`, { mode: 0o600 })
  const fd = openSync(path, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Open (or create) the enrollment ledger at the state-root tier.
 *
 * Creates the file with a freshly minted pairing root when absent. The root is
 * never rotated by this function; rotation policy is out of band.
 */
export function openEnrollmentLedger(
  stateDir: string,
  writeFence?: PortableStateWriteFence,
): EnrollmentLedger {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const path = ledgerPath(stateDir)

  let pairingRoot: Buffer
  const seenIds = new Set<string>()
  /** machineId → max enroll serial */
  const serials = new Map<string, number>()
  /** machineId → max revoke serial */
  const revokes = new Map<string, number>()
  /** machineId → latest owner (null means explicitly unowned) */
  const owners = new Map<string, string | null>()

  const applyEvent = (event: LedgerEvent): void => {
    if (seenIds.has(event.id)) return
    seenIds.add(event.id)
    switch (event.kind) {
      case 'enroll': {
        const prev = serials.get(event.machineId) ?? 0
        if (event.serial > prev) serials.set(event.machineId, event.serial)
        owners.set(event.machineId, event.ownerUserId)
        break
      }
      case 'revoke': {
        const prev = revokes.get(event.machineId) ?? 0
        if (event.serial > prev) revokes.set(event.machineId, event.serial)
        break
      }
      case 'owner': {
        owners.set(event.machineId, event.ownerUserId)
        break
      }
    }
  }

  if (!existsSync(path)) {
    pairingRoot = randomBytes(32)
    const header: LedgerHeader = {
      v: LEDGER_VERSION,
      kind: 'header',
      pairingRoot: pairingRoot.toString('hex'),
      createdAt: new Date().toISOString(),
    }
    writeFileSync(path, `${JSON.stringify(header)}\n`, { mode: 0o600, flag: 'wx' })
  } else {
    const text = readFileSync(path, 'utf8')
    let rootHex: string | undefined
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue
      const line = parseLine(raw)
      if (!line) continue
      if (line.kind === 'header') {
        rootHex = line.pairingRoot
        continue
      }
      applyEvent(line)
    }
    if (!rootHex || rootHex.length < 32) {
      throw new Error(`enrollment ledger at ${path} has no pairing root`)
    }
    pairingRoot = Buffer.from(rootHex, 'hex')
  }

  const append = (event: LedgerEvent): boolean => {
    const write = () => {
      if (seenIds.has(event.id)) return false
      durableAppend(path, JSON.stringify(event))
      applyEvent(event)
      return true
    }
    return writeFence ? writeFence.runWriterSync(write) : write()
  }

  return {
    path,
    pairingRoot,
    nextSerial(machineId: string): number {
      return (serials.get(machineId) ?? 0) + 1
    },
    revokeSerial(machineId: string): number | undefined {
      return revokes.get(machineId)
    },
    recordedOwner(machineId: string): string | null | undefined {
      if (!owners.has(machineId)) return undefined
      return owners.get(machineId) ?? null
    },
    enrolledMachineIds(): string[] {
      return [...owners.keys()]
    },
    appendEnroll(event): boolean {
      return append({ v: LEDGER_VERSION, kind: 'enroll', ...event })
    },
    appendRevoke(event): boolean {
      return append({ v: LEDGER_VERSION, kind: 'revoke', ...event })
    },
    appendOwner(event): boolean {
      return append({ v: LEDGER_VERSION, kind: 'owner', ...event })
    },
  }
}

/** Convenience: a fresh transition id for an idempotent ledger append. */
export function newLedgerTxnId(): string {
  return randomUUID()
}

/**
 * Verdict algorithm for a hello whose machines row is absent (D19.4).
 * Does not mutate the ledger or the database — the caller re-enrols on step 3.
 */
export function verdictForMissingRow(
  ledger: EnrollmentLedger,
  token: string,
):
  | { verdict: 're-enroll'; claims: PairingTokenClaims; ownerUserId: string | null }
  | { verdict: 'revoked' | 'unverifiable' } {
  const claims = verifyPairingToken(ledger.pairingRoot, token)
  if (!claims) return { verdict: 'unverifiable' }
  const revokedAt = ledger.revokeSerial(claims.machineId)
  if (revokedAt !== undefined && revokedAt >= claims.serial) {
    return { verdict: 'revoked' }
  }
  const owner = ledger.recordedOwner(claims.machineId)
  // No enroll history under this root either — treat as unverifiable rather than
  // inventing an ambient re-enrol for a token that somehow MAC-verified without
  // ever having been recorded (should not happen with honest minting).
  if (owner === undefined) return { verdict: 'unverifiable' }
  return { verdict: 're-enroll', claims, ownerUserId: owner }
}

/** Parent directory of a ledger path — useful when tests pass a ledger file path. */
export function ledgerStateDir(ledger: EnrollmentLedger): string {
  return dirname(ledger.path)
}
