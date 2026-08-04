import { createHash, randomUUID } from 'node:crypto'
import type { DaemonHandshake } from '@podium/protocol'
import {
  mintPairingToken,
  newLedgerTxnId,
  type PairingTokenClaims,
  verdictForMissingRow,
  verifyPairingToken,
} from '../../enrollment-ledger'
import type { MachinesDeps, PairingGrant } from './service'

/**
 * MACHINE CREDENTIAL LIFECYCLE — the second job MachinesService was doing.
 *
 * The service owns machine INVENTORY: the live daemon sockets, the offline
 * queue, the row caches, selection and routing. This module owns machine
 * IDENTITY over time: how a machine acquires a credential (pair), proves one
 * (hello), recovers one after its row is gone (D19.4 re-enrol), and how the
 * enrollment ledger's record of ownership is projected onto the rows.
 *
 * The seam is real rather than cosmetic: nothing here touches `daemons`,
 * `pendingByMachine`, `machineRecordsCache` or `machineNameCache` — the four
 * fields POD-1385's cohesive-owner argument protects. It reaches the service
 * only through {@link EnrollmentHost}: the injected deps, plus the two effects a
 * credential write has on the inventory side (drop the derived caches, tell
 * connected clients). That is the whole coupling, and it is one-directional.
 */
export interface EnrollmentHost {
  readonly deps: MachinesDeps
  /** The row caches are derived from the machines table; every write here invalidates. */
  invalidateMachineCache(): void
  /** Fan out `machinesChanged` after a write clients can see (owner transfer). */
  broadcastMachines(): void
}

/** Client-facing hello/pair refusal — identical for every denial (D19.4 / D20). */
export const HELLO_DENIED_REASON = 'unknown machine — re-pair'

/** sha-256 hex of a secret — matches the store's token-hash scheme. */
export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * Authenticate a daemon's handshake frame (pre-Control/Daemon-union, parsed by
 * wsServer). `pair` redeems a one-time code and mints a fresh **pairing-root-
 * verifiable** token (POD-1114), records the enrollment in the ledger, hashes
 * the token for the row, and returns the plaintext once (the daemon persists
 * it). The peer-chosen `machineId` is a REQUEST only: if that id already has a
 * row, the pair is REFUSED rather than upserting over its credential
 * (POD-1125), and the refusal runs BEFORE redeem so a collision does not burn
 * the single-use code. A revoked machine is gone from the table, so the same id
 * may pair again as a fresh insert.
 *
 * The two guards cover disjoint states and must both stay: POD-1125 refuses
 * when the row EXISTS, POD-1114's D19.4 verdict decides when the row is
 * ABSENT — re-enrol unattended, or deny permanently on a ledger revoke that
 * outranks the token. `hello` verifies a returning daemon's token against the
 * stored hash for its machineId, then attaches as that machineId — the id
 * always comes FROM the frame, never a token lookup, so getMachineByToken
 * returning a boolean is sufficient. The client-facing reason is byte-identical
 * in every denial so none of this is an existence oracle.
 */
export function authenticateDaemon(
  host: EnrollmentHost,
  frame: DaemonHandshake,
):
  | {
      ok: true
      machineId: string
      name: string
      token?: string
      pairingGrant?: PairingGrant
      updatePubkey?: string
    }
  | { ok: false; reason: string } {
  const deps = host.deps
  if (frame.type === 'pair') {
    // No pairing manager = node role: this server is not a rendezvous point,
    // so new machines can't join it. Returning daemons (`hello`) still work.
    if (!deps.pairing) return { ok: false, reason: 'pairing is disabled on this server' }
    // Existence check BEFORE redeem: a collision must not burn a single-use code.
    // The peer proposed this id; the directory decides, and an existing row is a
    // hard no — otherwise a valid pair code rebinds someone else's tokenHash.
    if (deps.store.machines.getMachine(frame.machineId)) {
      return { ok: false, reason: 'machine id already registered' }
    }
    const pairingGrant = deps.pairing.redeem(frame.code)
    if (!pairingGrant) {
      return { ok: false, reason: 'invalid or expired code' }
    }
    const updatePubkey = deps.updatePubkey?.()
    const name = frame.name ?? frame.hostname
    const ownerUserId = pairingGrant.ownerUserId ?? null
    const token = mintEnrolledToken(host, frame.machineId, ownerUserId)
    deps.store.machines.upsertMachine({
      id: frame.machineId,
      name,
      hostname: frame.hostname,
      tokenHash: sha256(token),
      // The pairer, carried from mint. `?? null` is the fail-closed arm, not a
      // default: a code with no owner produces an unowned machine.
      ownerUserId,
    })
    // Force the owner projection: upsert COALESCE would keep a stale owner after
    // a deliberate re-pair with a new pairer. The ledger enroll is the commit.
    deps.store.machines.setMachineOwner(frame.machineId, ownerUserId)
    host.invalidateMachineCache()
    return {
      ok: true,
      machineId: frame.machineId,
      name,
      token,
      pairingGrant,
      ...(updatePubkey === undefined ? {} : { updatePubkey }),
    }
  }
  if (deps.store.machines.getMachineByToken(frame.machineId, frame.token)) {
    // Even with a live row, a ledger revoke that outranks the token must win
    // (crash-after-append / DB rollback of the tombstone — D19.4a / D19.4d).
    if (isTokenRevoked(host, frame.machineId, frame.token)) {
      logVerdict(host, 'revoked', frame.machineId)
      return { ok: false, reason: HELLO_DENIED_REASON }
    }
    deps.store.machines.touchMachine(frame.machineId, frame.hostname)
    host.invalidateMachineCache()
    const name =
      deps.store.machines.listMachines().find((m) => m.id === frame.machineId)?.name ??
      frame.hostname
    return { ok: true, machineId: frame.machineId, name }
  }
  // Row missing — D19.4 verdict algorithm (pairing root → revoke serial → re-enrol).
  return helloMissingRow(host, frame)
}

/**
 * Mint a root-verifiable token and record enrollment in the ledger. Without an
 * enrollment ledger (socket-only fixtures), falls back to a random UUID so
 * existing unit tests that never open a state root keep working.
 */
function mintEnrolledToken(
  host: EnrollmentHost,
  machineId: string,
  ownerUserId: string | null,
): string {
  const ledger = host.deps.enrollment
  if (!ledger) return randomUUID()
  const serial = ledger.nextSerial(machineId)
  const token = mintPairingToken(ledger.pairingRoot, { machineId, serial })
  // Ledger append is the enrollment commit point (D19.4d). Failure aborts pair.
  const ok = ledger.appendEnroll({
    id: newLedgerTxnId(),
    machineId,
    serial,
    ownerUserId,
    at: new Date().toISOString(),
  })
  if (!ok) throw new Error('enrollment ledger refused the enroll append')
  return token
}

function isTokenRevoked(host: EnrollmentHost, machineId: string, token: string): boolean {
  const ledger = host.deps.enrollment
  if (!ledger) return false
  const claims = verifyPairingToken(ledger.pairingRoot, token)
  // Non-root tokens (host bootstrap secret, pre-upgrade UUID) have no serial
  // in this ledger; they cannot be re-enrolled and are not ledger-revoked here.
  if (!claims || claims.machineId !== machineId) return false
  const revokedAt = ledger.revokeSerial(machineId)
  return revokedAt !== undefined && revokedAt >= claims.serial
}

/**
 * Hello path when the machines row is gone. Verdict order is fixed by D19.4:
 * unverifiable → deny; revoked → deny permanently; else re-enrol per D19.4b.
 * The client-facing reason never carries the verdict (existence/deployment oracle).
 */
function helloMissingRow(
  host: EnrollmentHost,
  frame: Extract<DaemonHandshake, { type: 'hello' }>,
): { ok: true; machineId: string; name: string } | { ok: false; reason: string } {
  const ledger = host.deps.enrollment
  if (!ledger) return { ok: false, reason: HELLO_DENIED_REASON }
  const result = verdictForMissingRow(ledger, frame.token)
  if (result.verdict !== 're-enroll') {
    logVerdict(host, result.verdict, frame.machineId)
    return { ok: false, reason: HELLO_DENIED_REASON }
  }
  // Frame machineId must match the token's claims — a forged id with a stolen
  // token for a different machine must not re-enrol under the wrong name.
  if (result.claims.machineId !== frame.machineId) {
    logVerdict(host, 'unverifiable', frame.machineId)
    return { ok: false, reason: HELLO_DENIED_REASON }
  }
  const name = frame.hostname
  reEnrolMachine(host, {
    claims: result.claims,
    ownerUserId: result.ownerUserId,
    token: frame.token,
    name,
    hostname: frame.hostname,
  })
  logVerdict(host, 're-enrolled', frame.machineId)
  return { ok: true, machineId: frame.machineId, name }
}

/**
 * Recreate a machines row from a pairing-root-verifiable token (D19.4b).
 * MachineId preserved; owner from ledger (or quarantine); grants never restored.
 */
function reEnrolMachine(
  host: EnrollmentHost,
  input: {
    claims: PairingTokenClaims
    ownerUserId: string | null
    token: string
    name: string
    hostname: string
  },
): void {
  const resolvedOwner = resolveOwnerForRecovery(host, input.ownerUserId)
  host.deps.store.machines.upsertMachine({
    id: input.claims.machineId,
    name: input.name,
    hostname: input.hostname,
    tokenHash: sha256(input.token),
    ownerUserId: resolvedOwner,
  })
  // upsert COALESCE keeps a prior owner; recovery must apply the ledger owner.
  host.deps.store.machines.setMachineOwner(input.claims.machineId, resolvedOwner)
  // Grants are always dropped on recovery — the row was gone, so edge rows
  // referencing it should already be gone; belt-and-braces clear.
  host.deps.store.grants.removeAllForResource('machine', input.claims.machineId)
  host.invalidateMachineCache()
}

/**
 * Ledger owner → row owner. Unresolvable account → quarantine (`null`), never
 * first-admin auto-assign (D19.4b).
 */
function resolveOwnerForRecovery(host: EnrollmentHost, recorded: string | null): string | null {
  if (recorded === null) return null
  if (host.deps.userExists && !host.deps.userExists(recorded)) return null
  return recorded
}

function logVerdict(
  host: EnrollmentHost,
  verdict: 're-enrolled' | 'revoked' | 'unverifiable',
  machineId: string,
): void {
  // Diagnostics follow the decision (D19.4): log the verdict + instance id +
  // state root the check ran against. Client-facing reason stays opaque.
  const root = host.deps.enrollment?.path ?? '(no-ledger)'
  console.info(
    `[podium] machine hello verdict=${verdict} machineId=${machineId} instanceId=${host.deps.instanceId} ledger=${root}`,
  )
}

/**
 * Project ledger owners (and revocations) onto the machines table.
 * Ledger-first commit point (D19.4d): after a crash between append and row
 * update, boot repair makes the NEW owner effective with no manual step.
 * Also drops rows whose enrollment has been revoked at a serial that covers
 * the stored credential when we can tell — projection of the revoke append.
 */
export function reconcileOwnersFromLedger(host: EnrollmentHost): void {
  const ledger = host.deps.enrollment
  if (!ledger) return
  for (const machineId of ledger.enrolledMachineIds()) {
    const row = host.deps.store.machines.getMachine(machineId)
    const revokedAt = ledger.revokeSerial(machineId)
    const lastSerial = ledger.nextSerial(machineId) - 1
    // A revoke at serial S covers every token with serial <= S. If the latest
    // enroll serial is still covered, the machine is revoked and the row is a
    // stale projection — remove it (grants die with it).
    if (revokedAt !== undefined && lastSerial > 0 && revokedAt >= lastSerial) {
      if (row) {
        host.deps.store.grants.removeAllForResource('machine', machineId)
        host.deps.store.machines.deleteMachine(machineId)
      }
      continue
    }
    if (!row) continue
    const recorded = ledger.recordedOwner(machineId)
    if (recorded === undefined) continue
    const resolved = resolveOwnerForRecovery(host, recorded)
    if (row.ownerUserId !== resolved) {
      host.deps.store.machines.setMachineOwner(machineId, resolved)
    }
  }
  host.invalidateMachineCache()
}

/**
 * Ownership transfer — ledger append is the commit point (D19.4d).
 *
 * Ordering: append first; only then project onto `machines.owner`. Failure of
 * the append leaves the old owner effective and throws. Crash after append,
 * before the row write, is repaired by {@link reconcileOwnersFromLedger} on
 * the next boot (and the NEW owner is already effective for any check that
 * re-reads the ledger first — see {@link effectiveOwner}).
 *
 * `opts.skipRowUpdate` is the crash-injection seam for the required
 * regression sequence #5; production callers never pass it.
 */
export function transferOwnership(
  host: EnrollmentHost,
  machineId: string,
  newOwnerUserId: string,
  opts: { skipRowUpdate?: boolean; txnId?: string } = {},
): void {
  const ledger = host.deps.enrollment
  if (!ledger) throw new Error('ownership transfer requires the enrollment ledger')
  const row = host.deps.store.machines.getMachine(machineId)
  if (!row) throw new Error(`unknown machine '${machineId}'`)
  const txnId = opts.txnId ?? newLedgerTxnId()
  const appended = ledger.appendOwner({
    id: txnId,
    machineId,
    ownerUserId: newOwnerUserId,
    at: new Date().toISOString(),
  })
  // Idempotent retry: a re-append of the same id is a no-op but the row may
  // still need projecting.
  if (!appended && ledger.recordedOwner(machineId) !== newOwnerUserId) {
    throw new Error('ownership transfer ledger append failed')
  }
  if (opts.skipRowUpdate) return
  host.deps.store.machines.setMachineOwner(machineId, newOwnerUserId)
  host.invalidateMachineCache()
  host.broadcastMachines()
}

/**
 * The product-surface transfer (POD-1480) — what `machines.transferOwnership`
 * calls, and the first caller that ever reaches the projection tail of
 * {@link transferOwnership} (row write, cache invalidation, broadcast). The raw
 * function above stays as-is: it IS D19.4d's append-then-project sequence and
 * owns the crash-injection seam.
 *
 * The two checks here are DEFENCE IN DEPTH, not the gate. The gate is
 * `machineSharingAuthority: 'owner-only'` in `fleetAuthzFailure`, resolved from
 * the transport principal; this repeats the owner check for the same reason
 * `shareMachine` does — a service reachable from more than one transport must
 * not depend on every one of them remembering.
 *
 * `currentOwner` is the AUTHENTICATED human, never a payload field (ADR 3 D7).
 */
export function transferMachineOwnership(
  host: EnrollmentHost,
  id: string,
  newOwnerUserId: string,
  currentOwner: string,
): void {
  const machine = host.deps.store.machines.getMachine(id)
  if (!machine?.ownerUserId || machine.ownerUserId !== currentOwner) {
    throw new Error('only the machine owner may transfer ownership')
  }
  // An unknown or unreadable recipient is REFUSED rather than written. The
  // projection would otherwise record an owner `userExists` cannot resolve,
  // and the next `reconcileOwnersFromLedger` would quarantine the machine
  // (owner null, usable by nobody) — a typo silently bricking someone's Mac.
  //
  // `?.` — a deps bundle with no `userExists` resolves to `undefined`, which
  // is falsy and therefore REFUSES. Absent is the closed direction.
  if (!host.deps.userExists?.(newOwnerUserId)) {
    throw new Error(`unknown user: ${newOwnerUserId}`)
  }
  if (newOwnerUserId === currentOwner) {
    throw new Error('machine is already owned by that user')
  }
  // The audience does NOT travel with the machine. Every existing grant edge
  // was a deliberate act by the OUTGOING owner (readiness M3: sharing is a
  // deliberate act, and M2: `use` is a code-execution boundary). Carrying them
  // over would hand the incoming owner an audience they never approved, on
  // their hardware. Dropped BEFORE the ledger append, so a crash between the
  // two leaves the closed state and not the open one.
  host.deps.store.grants.removeAllForResource('machine', id)
  transferOwnership(host, id, newOwnerUserId)
}

/**
 * Give an owner to a machine that has none (POD-1494) — what `machines.adopt`
 * calls, and the sibling of {@link transferMachineOwnership} rather than a
 * relaxation of it.
 *
 * The two differ in WHERE THE AUTHORITY COMES FROM, and this function's shape is
 * that difference made concrete: transfer takes a `currentOwner` because the
 * incumbent's consent IS the authority, and this one takes no such parameter
 * because there is no incumbent to consent. The authority is the admin floor
 * on the contract, resolved from the transport principal — so there is
 * deliberately no adopter argument here that a caller could get wrong, and
 * no way for this function to be talked into believing who is asking.
 *
 * As with transfer these checks are DEFENCE IN DEPTH and not the gate: the gate
 * is `roleFloor: 'admin'` + `machineVerb: 'see'` + `machineOwnerPrecondition:
 * 'unowned'` in `fleetAuthzFailure`. They are repeated because a service
 * reachable from more than one transport must not depend on every one of them
 * remembering.
 */
export function adoptMachine(host: EnrollmentHost, id: string, newOwnerUserId: string): void {
  const machine = host.deps.store.machines.getMachine(id)
  if (!machine) throw new Error(`unknown machine '${id}'`)
  // THE LEDGER DECIDES, not `machine.ownerUserId`. The row is a projection
  // (D19.4d) and this is the one question adoption must not ask it: a row
  // still showing a stale owner between a transfer's append and its projection
  // would refuse a legitimate adoption, and — the direction that matters — a
  // row showing null while the ledger holds a resolvable owner would let an
  // admin adopt a machine that is currently somebody's.
  //
  // `null` covers recorded-as-unowned AND quarantine (the recorded owner no
  // longer resolves, D19.4b); `undefined` is never-recorded. All three are
  // adoptable — see the contract for why quarantine is deliberately included.
  const owner = effectiveOwner(host, id)
  if (owner !== null && owner !== undefined) {
    throw new Error('machine already has an owner — only its owner may transfer it')
  }
  // Same fail-closed reading as transfer: a deps bundle with no `userExists`
  // resolves to `undefined`, which REFUSES. Adopting to an unresolvable id
  // would append an owner the next `reconcileOwnersFromLedger` re-quarantines
  // — the machine would come out of adoption exactly as stuck as it went in.
  if (!host.deps.userExists?.(newOwnerUserId)) {
    throw new Error(`unknown user: ${newOwnerUserId}`)
  }
  // Grant edges should not survive an ownership change, and an unowned machine
  // is where stale ones are most likely to be: `machineVerbsFor` stops reading
  // them the moment the owner column goes null (owner-null grants nobody
  // anything), so an edge can sit here invisible and become live again the
  // instant an owner exists. Dropped BEFORE the append for the crash ordering
  // — the closed state is the safe one to be interrupted in.
  host.deps.store.grants.removeAllForResource('machine', id)
  transferOwnership(host, id, newOwnerUserId)
}

/**
 * Effective owner for authorization: ledger wins over the row (D19.4d rule 4).
 * Callers that authorize `use`/`manage` should prefer this over the raw row
 * when a ledger is present; {@link reconcileOwnersFromLedger} keeps the row
 * in sync, but a concurrent transfer can land between reconcile and check.
 */
export function effectiveOwner(host: EnrollmentHost, machineId: string): string | null | undefined {
  const ledger = host.deps.enrollment
  if (ledger) {
    const recorded = ledger.recordedOwner(machineId)
    if (recorded !== undefined) return resolveOwnerForRecovery(host, recorded)
  }
  return host.deps.store.machines.getMachine(machineId)?.ownerUserId
}
