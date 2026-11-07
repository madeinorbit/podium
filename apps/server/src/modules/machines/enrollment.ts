import type { MachineId, UserId } from '@podium/model'
import { createHash } from 'node:crypto'
import { parseWirePublicKey } from '@podium/runtime/signing'
import type { DaemonHandshake, UpdateKeyRotation } from '@podium/protocol'
import type { MachinesDeps, PairingGrant } from './service'
import type { SettingsAuditRow } from '../../store/settings-audit'
import { afterCommit, spanOpen } from '../../store/executor/executor'

/** Database-owned machine credentials and custody transitions. */
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

/**
 * A custody transition: its database write, then the steps outside the database
 * (retiring a daemon's transports, the clients' `machinesChanged`).
 *
 * Outside a unit of work, both run under the machine's transition lock, as they
 * always did. INSIDE one (the sync write entry point, POD-6417) the lock cannot
 * be held: a daemon hello holds it while it waits for the write lane, which the
 * open unit holds, and each would wait on the other. The write is serialized by
 * the unit itself (one writer at a time), and the outside steps run after the
 * commit, under the lock, and never on a rollback (ADR 2 D10). A hello that read
 * the row before the commit has attached by the time the lock is free, so the
 * retirement after it still reaches its transports.
 */
export async function machineTransition(
  host: EnrollmentHost,
  ids: readonly MachineId[],
  write: () => Promise<void>,
  outside: () => Promise<void>,
  label: string,
): Promise<void> {
  // Stable ordering prevents opposing A→B/B→A requests from deadlocking.
  const sorted = [...new Set(ids)].sort()
  const locked = (run: () => Promise<void>): Promise<void> =>
    sorted.reduceRight<() => Promise<void>>(
      (inner, id) => () => withMachineTransition(host, id, inner),
      run,
    )()
  if (spanOpen()) {
    await write()
    afterCommit(async () => await locked(outside), label)
    return
  }
  await locked(async () => {
    await write()
    await outside()
  })
}

/** The clients' `machinesChanged` after a write they can see: after the commit
 *  inside a unit of work, at once outside one. */
export async function broadcastAfterWrite(host: EnrollmentHost, label: string): Promise<void> {
  if (spanOpen()) {
    afterCommit(async () => await host.broadcastMachines(), label)
    return
  }
  await host.broadcastMachines()
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
    // code and creates a row, so verify-only fails closed
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
    if (proposedGrant?.clientRegistration && (proposedGrant.clientRegistration.machineId !== frame.machineId ||
      (proposedGrant.clientRegistration.publicKey !== undefined && proposedGrant.clientRegistration.publicKey !== frame.publicKey))) {
      return { ok: false, reason: HELLO_DENIED_REASON }
    }
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
    if (pairingGrant.clientRegistration && (pairingGrant.clientRegistration.machineId !== frame.machineId ||
      (pairingGrant.clientRegistration.publicKey !== undefined && pairingGrant.clientRegistration.publicKey !== frame.publicKey))) {
      return { ok: false, reason: HELLO_DENIED_REASON }
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
      if (!member || (existing && await deps.store.machines.custodian(existing.id) !== ownerUserId && member.role !== 'admin')) return false
      const changed = await deps.store.machines.enrollMachine({
        id: frame.machineId, name: pairingGrant.clientRegistration && existing ? existing.name : name, hostname: frame.hostname, tokenHash: '',
        credentialKind: 'ed25519', publicKey,
        ownerUserId, podiumManaged: pairingGrant.clientRegistration && existing ? existing.podiumManaged : pairingGrant.podiumManaged ?? true,
        assignment: pairingGrant.clientRegistration ? { server: false, agentExecution: false }
          : frame.assignment ?? { server: false, agentExecution: options.source !== 'supervisor' },
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
    if (!row || row.revokedAt || row.supersededBy) return { ok: false, reason: HELLO_DENIED_REASON }
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
  // A rejected credential or missing database row always requires re-pairing.
  // Historical ledger files are never authority for credentials or custody.
  return { ok: false, reason: HELLO_DENIED_REASON }
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
  await machineTransition(host, [id], async () => {
    await host.deps.store.transact(async () => {
      const machine = await host.deps.store.machines.getMachine(id)
      if (!machine || machine.revokedAt) throw new Error(`unknown machine '${id}'`)
      const custodian = await host.deps.store.machines.custodian(id)
      const admin = await host.deps.store.users.roleOf(actor) === 'admin'
      if (!scopeAllowed || (custodian !== actor && !admin)) {
        throw new Error('only the machine owner or an admin may transfer ownership')
      }
      if (newOwnerUserId === custodian) throw new Error('machine is already owned by that user')
      await host.deps.store.grants.removeAllForResource('machine', id)
      await host.deps.store.machines.setMachineOwner(id, newOwnerUserId)
      await host.deps.store.settingsAudit.append({
        command: admin && newOwnerUserId === actor ? 'takeover' : 'machines.transferOwnership',
        outcome: 'applied',
        ...(context.attribution ?? { actorKind: 'user' as const, actorId: actor, onBehalfOf: actor }),
        detail: { machineId: id, previousOwnerUserId: custodian, newOwnerUserId },
        redactedPaths: [],
        createdAt: new Date().toISOString(),
      })
    })
  }, async () => {}, 'machines:transfer')
  await broadcastAfterWrite(host, 'machines:transfer:broadcast')
}

export async function effectiveOwner(host: EnrollmentHost, machineId: MachineId): Promise<UserId | null | undefined> {
  return await host.deps.store.machines.getMachine(machineId)
    ? await host.deps.store.machines.custodian(machineId) : undefined
}

/** Adoption is a separate, admin-only transition from explicitly unowned custody. */
export async function adoptMachine(host: EnrollmentHost, id: MachineId, newOwnerUserId: UserId, actor: UserId, context: MachineManagementContext = {}): Promise<void> {
  if (context.manage?.(id) === false || await host.deps.store.users.roleOf(actor) !== 'admin') {
    throw new Error('only an admin may adopt a machine')
  }
  if (!await host.deps.userExists?.(newOwnerUserId)) throw new Error(`unknown user: ${newOwnerUserId}`)
  await machineTransition(host, [id], async () => {
    await host.deps.store.transact(async () => {
      const machine = await host.deps.store.machines.getMachine(id)
      if (!machine || machine.revokedAt) throw new Error(`unknown machine '${id}'`)
      if (await host.deps.store.machines.custodian(id) !== null) throw new Error('machine already has an owner — use transfer ownership')
      await host.deps.store.grants.removeAllForResource('machine', id)
      await host.deps.store.machines.setMachineOwner(id, newOwnerUserId)
      await host.deps.store.settingsAudit.append({
        command: newOwnerUserId === actor ? 'takeover' : 'machines.adopt', outcome: 'applied',
        ...(context.attribution ?? { actorKind: 'user' as const, actorId: actor, onBehalfOf: actor }),
        detail: { machineId: id, previousOwnerUserId: null, newOwnerUserId }, redactedPaths: [], createdAt: new Date().toISOString(),
      })
    })
  }, async () => {}, 'machines:adopt')
  await broadcastAfterWrite(host, 'machines:adopt:broadcast')
}

/** One admin-authorized decision for client enrollment and retained revoked identity.
 * The same transition lock and replacement incarnation fence own later redemption. */
export async function mintClientRegistrationCode(host: EnrollmentHost,
  request: { machineId: MachineId; publicKey?: string }, actor: UserId): Promise<string> {
  return withMachineTransition(host, request.machineId, async () => {
    const grant = await host.deps.store.transact(async () => {
      if (await host.deps.store.users.roleOf(actor) !== 'admin')
        throw new Error('client registration requires a current administrator')
      if (request.publicKey !== undefined && !parseWirePublicKey(request.publicKey))
        throw new Error('invalid retained machine key')
      const row = await host.deps.store.machines.getMachine(request.machineId)
      if (row?.supersededBy) throw new Error('superseded machine identities cannot be re-enrolled')
      if (row && !row.revokedAt) throw new Error('machine already registered; reconnect with its retained credential')
      const incarnation = row ? await host.deps.store.machines.credentialIncarnation(request.machineId) : undefined
      if (row && (!request.publicKey || incarnation !== request.publicKey))
        throw new Error('retained machine key does not match the revoked identity')
      return { ownerUserId: actor, podiumManaged: row?.podiumManaged ?? true,
        copyAgentCredentials: false, clientRegistration: request,
        ...(row ? { replaceMachineId: request.machineId, replaceIncarnation: incarnation } : {}) }
    })
    if (!host.deps.pairing) throw new Error('inbound pairing is disabled on this server')
    return host.deps.pairing.mint(grant)
  })
}
