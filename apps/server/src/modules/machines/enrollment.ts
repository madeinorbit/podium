import type { MachineId, UserId } from '@podium/model'
import { createHash } from 'node:crypto'
import { createLogger } from '@podium/logger'
import { parseWirePublicKey } from '@podium/runtime/signing'
import type { DaemonHandshake, UpdateKeyRotation } from '@podium/protocol'
import {
  type PairingTokenClaims,
  verdictForMissingRow,
  verifyPairingToken,
} from '../../enrollment-ledger'
import type { MachinesDeps, PairingGrant } from './service'
import type { SettingsAuditRow } from '../../store/settings-audit'

const log = createLogger('server:machines')

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
  /** Fan out `machinesChanged` after a write clients can see (owner transfer). */
  broadcastMachines(): Promise<void>
  hasSupervisor(machineId: MachineId): boolean
  retireIncarnation(machineId: MachineId): void
}

/** Client-facing hello/pair refusal — identical for every denial (D19.4 / D20). */
export const HELLO_DENIED_REASON = 'unknown machine — re-pair'

/** sha-256 hex of a secret — matches the store's token-hash scheme. */
export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * Pairing creates one identity. Replacing a retained revoked row requires a code
 * explicitly scoped to that identity by an authorized administrator. Collision
 * checks precede code consumption; conditional storage supplies a second fence.
 * Hello checks the current, non-revoked credential and never recovers over a row.
 */
/** A key proof is supplied only by the gateway after consuming its connection nonce.
 * It is not a wire field on legacy hello; that parser never admits it. */
export type MachineAuthenticationFrame = DaemonHandshake & {
  keyProof?: { transcript: string; signature: string }
}

export interface DaemonAuthenticationOptions {
  readonly bindingSessionIds?: readonly string[]
  /** Authenticate existing durable identity without mutating its projection. */
  readonly verifyOnly?: boolean
  readonly source?: 'supervisor' | 'legacy-daemon'
}

const transitions = new WeakMap<EnrollmentHost, Map<MachineId, Promise<void>>>()

/** Serialize credential transitions before inspecting or consuming a one-use code. */
export async function withMachineTransition<T>(host: EnrollmentHost, id: MachineId, run: () => Promise<T>): Promise<T> {
  let pending = transitions.get(host)
  if (!pending) { pending = new Map(); transitions.set(host, pending) }
  const previous = pending.get(id) ?? Promise.resolve()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.then(() => held)
  pending.set(id, tail)
  await previous
  try { return await run() } finally {
    release()
    if (pending.get(id) === tail) pending.delete(id)
  }
}

export async function authenticateDaemon(host: EnrollmentHost, frame: MachineAuthenticationFrame, options: DaemonAuthenticationOptions = {}) {
  return withMachineTransition(host, frame.machineId, () => authenticateDaemonUnlocked(host, frame, options))
}

async function authenticateDaemonUnlocked(
  host: EnrollmentHost,
  frame: MachineAuthenticationFrame,
  options: DaemonAuthenticationOptions = {},
):
  Promise<| {
      ok: true
      machineId: MachineId
      name: string
      token?: string
      enrolledPublicKey?: string
      pairingGrant?: PairingGrant
      updatePubkey?: string
      updateKeyRotations?: readonly UpdateKeyRotation[]
    }
  | { ok: false; reason: string }> {
  const deps = host.deps
  if (frame.type === 'pair') {
    // Recovery-only holds a query-only database. Pairing necessarily redeems a
    // code, appends enrollment, and creates a row, so verify-only fails closed
    // before any of those effects can begin.
    if (options.verifyOnly) return { ok: false, reason: HELLO_DENIED_REASON }
    // No pairing manager = node role: this server is not a rendezvous point,
    // so new machines can't join it. Returning daemons (`hello`) still work.
    if (!deps.pairing) return { ok: false, reason: 'pairing is disabled on this server' }
    if (!frame.publicKey || !parseWirePublicKey(frame.publicKey)) {
      return { ok: false, reason: 'valid machine public key required' }
    }
    // Existence check BEFORE redeem: a collision must not burn a single-use code.
    // The peer proposed this id; the directory decides, and an existing row is a
    // hard no — otherwise a valid pair code rebinds someone else's tokenHash.
    const existing = await deps.store.machines.getMachine(frame.machineId)
    const proposedGrant = deps.pairing.peek?.(frame.code)
    if (existing && (!existing.revokedAt || proposedGrant?.replaceMachineId !== frame.machineId)) {
      return { ok: false, reason: 'machine id already registered' }
    }
    if (proposedGrant?.replaceMachineId && (!existing || proposedGrant.replaceMachineId !== frame.machineId)) {
      return { ok: false, reason: 'replacement target does not match' }
    }
    if (existing && proposedGrant?.replaceIncarnation !== await deps.store.machines.credentialIncarnation(frame.machineId)) {
      return { ok: false, reason: 'replacement credential has changed' }
    }
    const pairingGrant = deps.pairing.redeem(frame.code)
    if (!pairingGrant) {
      return { ok: false, reason: 'invalid or expired code' }
    }
    const updatePubkey = deps.updatePubkey?.()
    const updateKeyRotations = deps.updateKeyRotations?.()
    const name = frame.name ?? frame.hostname
    const ownerUserId = pairingGrant.ownerUserId
    if (!ownerUserId || !deps.installationId || pairingGrant.installationId !== deps.installationId) {
      return { ok: false, reason: HELLO_DENIED_REASON }
    }
    const now = new Date().toISOString()
    const publicKey = frame.publicKey
    const enrolled = await deps.store.transact(async () => {
      // Re-read in the enrollment transaction: minting a code does not freeze eligibility.
      const member = await deps.store.users.get(ownerUserId)
      if (!member || (existing && existing.ownerUserId !== ownerUserId && member.role !== 'admin')) return false
      const changed = await deps.store.machines.enrollMachine({
        id: frame.machineId, name, hostname: frame.hostname, tokenHash: '',
        credentialKind: 'ed25519', publicKey,
        ownerUserId, podiumManaged: pairingGrant.podiumManaged ?? true,
        assignment: frame.assignment ?? { server: false, agentExecution: options.source !== 'supervisor' },
        assignmentEvidence: { version: 1, source: options.source === 'supervisor' ? 'supervisor-enrollment' : 'daemon-enrollment', requestId: frame.machineId },
      }, existing?.revokedAt ?? undefined, pairingGrant.replaceIncarnation)
      if (changed && existing) await deps.store.settingsAudit.append({
        command: 'machines.replace', outcome: 'applied', actorKind: 'user',
        actorId: ownerUserId, onBehalfOf: ownerUserId,
        detail: { machineId: frame.machineId, previousRevokedAt: existing.revokedAt },
        redactedPaths: [], createdAt: now,
      })
      return changed
    })
    if (!enrolled) return { ok: false, reason: 'machine id already registered' }
    if (existing) host.retireIncarnation(frame.machineId)

    return {
      ok: true,
      machineId: frame.machineId,
      name,
      enrolledPublicKey: publicKey,
      pairingGrant,
      ...(updatePubkey === undefined ? {} : { updatePubkey }),
      ...(updateKeyRotations === undefined ? {} : { updateKeyRotations }),
    }
  }
  const verified = frame.keyProof
    ? await deps.store.machines.verifyMachineSignature(frame.machineId, frame.keyProof.transcript, frame.keyProof.signature)
    : await deps.store.machines.getMachineByToken(frame.machineId, frame.token)
  if (verified) {
    const row = await deps.store.machines.getMachine(frame.machineId)
    if (!row || row.revokedAt) return { ok: false, reason: HELLO_DENIED_REASON }
    if (
      !options.verifyOnly &&
      (options.source === 'supervisor' || !host.hasSupervisor(frame.machineId))
    ) {
      await deps.store.machines.touchMachine(frame.machineId, frame.hostname)
    }
    const name = row.name ?? frame.hostname
    const updatePubkey = deps.updatePubkey?.()
    const updateKeyRotations = deps.updateKeyRotations?.()
    return {
      ok: true,
      machineId: frame.machineId,
      name,
      ...(updatePubkey ? { updatePubkey } : {}),
      ...(updateKeyRotations ? { updateKeyRotations } : {}),
    }
  }
  if (frame.keyProof) return { ok: false, reason: HELLO_DENIED_REASON }
  // A retained row is authoritative: never recover a rejected incarnation over it.
  if (await deps.store.machines.getMachine(frame.machineId)) return { ok: false, reason: HELLO_DENIED_REASON }
  // Row missing — D19.4 verdict algorithm (pairing root → revoke serial → re-enrol).
  // Verify-only may authenticate durable reality but may not reconstruct it.
  if (options.verifyOnly) return { ok: false, reason: HELLO_DENIED_REASON }
  return await helloMissingRow(host, frame)
}

/**
 * Hello path when the machines row is gone. Verdict order is fixed by D19.4:
 * unverifiable → deny; revoked → deny permanently; else re-enrol per D19.4b.
 * The client-facing reason never carries the verdict (existence/deployment oracle).
 */
async function helloMissingRow(
  host: EnrollmentHost,
  frame: Extract<DaemonHandshake, { type: 'hello' }>,
):
  Promise<| {
      ok: true
      machineId: MachineId
      name: string
      updatePubkey?: string
      updateKeyRotations?: readonly UpdateKeyRotation[]
    }
  | { ok: false; reason: string }> {
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
  await reEnrolMachine(host, {
    claims: result.claims,
    ownerUserId: result.ownerUserId,
    token: frame.token,
    name,
    hostname: frame.hostname,
  })
  logVerdict(host, 're-enrolled', frame.machineId)
  const updatePubkey = host.deps.updatePubkey?.()
  const updateKeyRotations = host.deps.updateKeyRotations?.()
  return {
    ok: true,
    machineId: frame.machineId,
    name,
    ...(updatePubkey ? { updatePubkey } : {}),
    ...(updateKeyRotations ? { updateKeyRotations } : {}),
  }
}

/**
 * Recreate a machines row from a pairing-root-verifiable token (D19.4b).
 * MachineId preserved; owner from ledger (or quarantine); grants never restored.
 */
async function reEnrolMachine(
  host: EnrollmentHost,
  input: {
    claims: PairingTokenClaims
    ownerUserId: UserId | null
    token: string
    name: string
    hostname: string
  },
): Promise<void> {
  const resolvedOwner = await resolveOwnerForRecovery(host, input.ownerUserId)
  await host.deps.store.machines.upsertMachine({
    id: input.claims.machineId,
    name: input.name,
    hostname: input.hostname,
    tokenHash: sha256(input.token),
    podiumManaged: true,
    ownerUserId: resolvedOwner,
  })
  // upsert COALESCE keeps a prior owner; recovery must apply the ledger owner.
  await host.deps.store.machines.setMachineOwner(input.claims.machineId, resolvedOwner)
  if (resolvedOwner === null) log.warn('machine unowned', {
    machineId: input.claims.machineId,
    reason: input.ownerUserId === null ? 'no recorded personal grantee' : 'recorded personal grantee no longer exists',
  })
  // Grants are always dropped on recovery — the row was gone, so edge rows
  // referencing it should already be gone; belt-and-braces clear.
  await host.deps.store.grants.removeAllForResource('machine', input.claims.machineId)
}

/**
 * Ledger owner → row owner. Unresolvable account → quarantine (`null`), never
 * first-admin auto-assign (D19.4b).
 */
async function resolveOwnerForRecovery(
  host: EnrollmentHost,
  recorded: UserId | null,
): Promise<UserId | null> {
  if (recorded === null) return null
  if (host.deps.userExists && !await host.deps.userExists(recorded)) return null
  return recorded
}

function logVerdict(
  host: EnrollmentHost,
  verdict: 're-enrolled' | 'revoked' | 'unverifiable',
  machineId: MachineId,
): void {
  // Diagnostics follow the decision (D19.4): log the verdict + instance id +
  // state root the check ran against. Client-facing reason stays opaque.
  const root = host.deps.enrollment?.path ?? '(no-ledger)'
  log.info('machine hello', {
    verdict,
    machineId,
    instanceId: host.deps.instanceId,
    ledger: root,
  })
}

/** Database-owned ownership transfer. */
export async function transferOwnership(
  host: EnrollmentHost,
  machineId: MachineId,
  newOwnerUserId: UserId,
  opts: { skipRowUpdate?: boolean; txnId?: string } = {},
): Promise<void> {
  const row = await host.deps.store.machines.getMachine(machineId)
  if (!row || row.revokedAt) throw new Error(`unknown machine '${machineId}'`)
  if (opts.skipRowUpdate) return
  await host.deps.store.machines.setMachineOwner(machineId, newOwnerUserId)
  await host.broadcastMachines()
}

/** Authenticated transport attribution and agent-scope narrowing, never payload input. */
export interface MachineManagementContext {
  manage?: (machineId: MachineId) => boolean
  attribution?: Pick<SettingsAuditRow, 'actorKind' | 'actorId' | 'onBehalfOf'>
}

/** Owners and admins may change custody; a delegated manage grant alone cannot. */
export async function transferMachineOwnership(
  host: EnrollmentHost,
  id: MachineId,
  newOwnerUserId: UserId,
  actor: UserId,
  context: MachineManagementContext = {},
): Promise<void> {
  if (!await host.deps.userExists?.(newOwnerUserId)) throw new Error(`unknown user: ${newOwnerUserId}`)
  const scopeAllowed = context.manage?.(id) !== false
  await withMachineTransition(host, id, async () => {
    await host.deps.store.transact(async () => {
      const machine = await host.deps.store.machines.getMachine(id)
      if (!machine || machine.revokedAt) throw new Error(`unknown machine '${id}'`)
      const admin = await host.deps.store.users.roleOf(actor) === 'admin'
      if (!scopeAllowed || (machine.ownerUserId !== actor && !admin)) {
        throw new Error('only the machine owner or an admin may transfer ownership')
      }
      if (newOwnerUserId === machine.ownerUserId) throw new Error('machine is already owned by that user')
      await host.deps.store.grants.removeAllForResource('machine', id)
      await host.deps.store.machines.setMachineOwner(id, newOwnerUserId)
      await host.deps.store.settingsAudit.append({
        command: admin && newOwnerUserId === actor ? 'takeover' : 'machines.transferOwnership',
        outcome: 'applied',
        ...(context.attribution ?? { actorKind: 'user' as const, actorId: actor, onBehalfOf: actor }),
        detail: { machineId: id, previousOwnerUserId: machine.ownerUserId, newOwnerUserId },
        redactedPaths: [],
        createdAt: new Date().toISOString(),
      })
    })
  })
  await host.broadcastMachines()
}

export async function effectiveOwner(host: EnrollmentHost, machineId: MachineId): Promise<UserId | null | undefined> {
  return (await host.deps.store.machines.getMachine(machineId))?.ownerUserId
}

/** Adoption is a separate, admin-only transition from explicitly unowned custody. */
export async function adoptMachine(host: EnrollmentHost, id: MachineId, newOwnerUserId: UserId, actor: UserId, context: MachineManagementContext = {}): Promise<void> {
  if (context.manage?.(id) === false || await host.deps.store.users.roleOf(actor) !== 'admin') {
    throw new Error('only an admin may adopt a machine')
  }
  if (!await host.deps.userExists?.(newOwnerUserId)) throw new Error(`unknown user: ${newOwnerUserId}`)
  await withMachineTransition(host, id, async () => {
    await host.deps.store.transact(async () => {
      const machine = await host.deps.store.machines.getMachine(id)
      if (!machine || machine.revokedAt) throw new Error(`unknown machine '${id}'`)
      if (machine.ownerUserId !== null) throw new Error('machine already has an owner — use transfer ownership')
      await host.deps.store.grants.removeAllForResource('machine', id)
      await host.deps.store.machines.setMachineOwner(id, newOwnerUserId)
      await host.deps.store.settingsAudit.append({
        command: newOwnerUserId === actor ? 'takeover' : 'machines.adopt', outcome: 'applied',
        ...(context.attribution ?? { actorKind: 'user' as const, actorId: actor, onBehalfOf: actor }),
        detail: { machineId: id, previousOwnerUserId: null, newOwnerUserId }, redactedPaths: [], createdAt: new Date().toISOString(),
      })
    })
  })
  await host.broadcastMachines()
}
