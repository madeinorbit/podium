/**
 * PAIRING DURABILITY ACROSS SERVER DATA LOSS (POD-1114).
 *
 * Required regression sequences from ADR 1 Amendment 2 D19.4 / D19.4a / D19.4b /
 * D19.4d — as tests, not inspection:
 *
 *   1. LOSS RECOVERS — row deleted, server "restarts", daemon reconnects unattended
 *      with the same MachineId and no pair code.
 *   2. REVOKE STAYS DENIED ACROSS DB ROLLBACK — pair, revoke, roll DB back to before
 *      the revoke, reconnect with the old token → DENY.
 *   3. WRONG INSTANCE — token under a different root → denial byte-identical to revoke.
 *   4. RECOVERED ROW IS NOT AMBIENT — owner from ledger, grants empty, non-owner
 *      cannot use; with owner account gone → QUARANTINED (admin see, nobody use).
 *   5. CRASH BETWEEN THE WRITES — owner transition append without row update;
 *      restart → NEW owner holds use/manage, OLD holds neither, no manual repair.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIRST_ADMIN_USER_ID, asUserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userCommandPrincipal } from './command-principal'
import {
  mintPairingToken,
  openEnrollmentLedger,
  verifyPairingToken,
} from './enrollment-ledger'
import { PairingManager } from './hub/pairing'
import {
  canSeeMachine,
  checkMachineUse,
  checkMachineVerb,
  machineVerbsFor,
  ownershipFromMachines,
} from './machine-access'
import { MachinesService, sha256 } from './modules/machines/service'
import { SessionStore } from './store'

const OWNER = FIRST_ADMIN_USER_ID
const OTHER = asUserId('user:colleague')

function tempState(): string {
  return mkdtempSync(join(tmpdir(), 'podium-enroll-'))
}

function makeWorld(stateDir: string, opts: { dbPath?: string } = {}) {
  const store = new SessionStore(opts.dbPath ?? ':memory:')
  // Ensure the colleague exists for transfer / non-owner cases.
  const now = new Date().toISOString()
  if (!store.users.get(OTHER)) {
    store.users.create(
      { id: OTHER, displayName: 'Colleague', role: 'member', createdAt: now, disabledAt: null },
      'hash',
    )
  }
  const enrollment = openEnrollmentLedger(stateDir)
  const pairing = new PairingManager({ randomCode: () => `CODE-${Math.random().toString(36).slice(2, 10)}` })
  const machines = new MachinesService({
    instanceId: 'default',
    store,
    hostMachineId: store.hostMachineId,
    pairing,
    enrollment,
    userExists: (id) => store.users.get(id) !== undefined,
    sessionsChangedForMachine: () => {},
    clients: () => [],
    machinesForPrincipal: () => [],
  })
  return { store, machines, enrollment, pairing, stateDir }
}

function pairRemote(
  machines: MachinesService,
  opts: { machineId?: string; ownerUserId?: string; hostname?: string } = {},
): { machineId: string; token: string; name: string } {
  const machineId = opts.machineId ?? 'remote-box'
  const code = machines.mintPairingCode({
    ...(opts.ownerUserId !== undefined ? { ownerUserId: opts.ownerUserId } : { ownerUserId: OWNER }),
  })
  const auth = machines.authenticateDaemon({
    type: 'pair',
    code,
    machineId,
    hostname: opts.hostname ?? 'remote.local',
    name: 'Remote Box',
  })
  if (!auth.ok || !auth.token) throw new Error(`pair failed: ${'reason' in auth ? auth.reason : '?'}`)
  return { machineId: auth.machineId, token: auth.token, name: auth.name }
}

function hello(
  machines: MachinesService,
  machineId: string,
  token: string,
  hostname = 'remote.local',
) {
  return machines.authenticateDaemon({ type: 'hello', machineId, token, hostname })
}

describe('enrollment ledger unit', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('mints a token that verifies under the same root and fails under another', () => {
    dir = tempState()
    const a = openEnrollmentLedger(dir)
    const token = mintPairingToken(a.pairingRoot, { machineId: 'm1', serial: 1 })
    expect(verifyPairingToken(a.pairingRoot, token)).toEqual({ machineId: 'm1', serial: 1 })
    const b = openEnrollmentLedger(tempState())
    expect(verifyPairingToken(b.pairingRoot, token)).toBeNull()
    rmSync(b.path.replace(/enrollment\.ledger$/, ''), { recursive: true, force: true })
  })

  it('re-opens the same pairing root from disk', () => {
    dir = tempState()
    const first = openEnrollmentLedger(dir)
    const rootHex = first.pairingRoot.toString('hex')
    const second = openEnrollmentLedger(dir)
    expect(second.pairingRoot.toString('hex')).toBe(rootHex)
  })

  it('append is idempotent under the same event id', () => {
    dir = tempState()
    const ledger = openEnrollmentLedger(dir)
    const id = 'txn-1'
    expect(
      ledger.appendEnroll({
        id,
        machineId: 'm1',
        serial: 1,
        ownerUserId: OWNER,
        at: new Date().toISOString(),
      }),
    ).toBe(true)
    expect(
      ledger.appendEnroll({
        id,
        machineId: 'm1',
        serial: 1,
        ownerUserId: OWNER,
        at: new Date().toISOString(),
      }),
    ).toBe(false)
    expect(ledger.nextSerial('m1')).toBe(2)
  })
})

describe('D19.4 regression sequences', () => {
  let dir: string
  beforeEach(() => {
    dir = tempState()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------------
  // 1. LOSS RECOVERS
  // ---------------------------------------------------------------------------
  it('1. LOSS RECOVERS: missing machines row re-enrols unattended with the same MachineId', () => {
    const w = makeWorld(dir)
    const { machineId, token } = pairRemote(w.machines)
    expect(w.store.machines.getMachine(machineId)?.ownerUserId).toBe(OWNER)

    // Accidental loss of the row (DB recreate / restore from before pairing).
    w.store.machines.deleteMachine(machineId)
    expect(w.store.machines.getMachine(machineId)).toBeUndefined()

    // "Restart": new MachinesService over the SAME ledger + a fresh in-memory DB
    // that has no row (simulates DB loss while state root survives).
    const restarted = makeWorld(dir)
    // No pair code — only the old token.
    const auth = hello(restarted.machines, machineId, token)
    expect(auth).toEqual({ ok: true, machineId, name: 'remote.local' })
    expect(restarted.store.machines.getMachine(machineId)?.id).toBe(machineId)
    // Same MachineId preserved; token still authenticates after re-enrol.
    expect(hello(restarted.machines, machineId, token).ok).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // 2. REVOKE STAYS DENIED ACROSS DB ROLLBACK
  // ---------------------------------------------------------------------------
  it('2. REVOKE STAYS DENIED: rolling the DB back before the revoke still denies the old token', () => {
    const dbPath = join(dir, 'podium.db')
    const w = makeWorld(dir, { dbPath })
    const { machineId, token } = pairRemote(w.machines)

    // Snapshot the row as it was AFTER pair and BEFORE revoke (the "backup").
    const row = w.store.machines.getMachine(machineId)
    expect(row).toBeDefined()
    const tokenHash = sha256(token)

    // Intentional revoke — ledger append is the commit point.
    w.machines.revokeMachine(machineId, { by: OWNER })
    expect(w.store.machines.getMachine(machineId)).toBeUndefined()
    expect(hello(w.machines, machineId, token).ok).toBe(false)

    // DESTROY / ROLL BACK the DB to before the revoke: re-insert the pre-revoke row.
    // The ledger is NOT restored (D19.4a).
    w.store.machines.upsertMachine({
      id: machineId,
      name: 'Remote Box',
      hostname: 'remote.local',
      tokenHash,
      ownerUserId: OWNER,
    })
    expect(w.store.machines.getMachineByToken(machineId, token)).toBe(true)

    // Reconnect with the old token must still DENY — ledger wins.
    const denied = hello(w.machines, machineId, token)
    expect(denied).toEqual({ ok: false, reason: 'unknown machine — re-pair' })

    // Restart over the same ledger + rolled-back DB: still denied.
    const restarted = makeWorld(dir, { dbPath: join(dir, 'podium-restart.db') })
    // Simulate the rolled-back DB again on a fresh store.
    restarted.store.machines.upsertMachine({
      id: machineId,
      name: 'Remote Box',
      hostname: 'remote.local',
      tokenHash,
      ownerUserId: OWNER,
    })
    // New service constructor reconciles: revoke projection should drop the row
    // (or at least deny hello). Either way hello must fail.
    const afterReconcile = makeWorld(dir)
    afterReconcile.store.machines.upsertMachine({
      id: machineId,
      name: 'Remote Box',
      hostname: 'remote.local',
      tokenHash,
      ownerUserId: OWNER,
    })
    // Force reconcile against a service that sees the stale row + live ledger.
    const svc = new MachinesService({
      instanceId: 'default',
      store: afterReconcile.store,
      hostMachineId: afterReconcile.store.hostMachineId,
      enrollment: openEnrollmentLedger(dir),
      userExists: (id) => afterReconcile.store.users.get(id) !== undefined,
      sessionsChangedForMachine: () => {},
      clients: () => [],
      machinesForPrincipal: () => [],
    })
    expect(hello(svc, machineId, token).ok).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // 3. WRONG INSTANCE
  // ---------------------------------------------------------------------------
  it('3. WRONG INSTANCE: foreign pairing root denies with the same reason as revoke', () => {
    const w = makeWorld(dir)
    // A live enrollment on this instance (not revoked) so a foreign token for the
    // same MachineId is a re-enrol candidate if the MAC is skipped — that is the
    // mutant that sequence 3 must catch. Revoke-reason bytes come from a sibling.
    const { machineId, token } = pairRemote(w.machines, { machineId: 'remote-box' })
    const sibling = pairRemote(w.machines, { machineId: 'sibling-box' })
    w.machines.revokeMachine(sibling.machineId)
    const revokeReason = hello(w.machines, sibling.machineId, sibling.token)
    expect(revokeReason.ok).toBe(false)

    // Row lost without revoke — legitimate token would re-enrol; foreign must not.
    w.store.machines.deleteMachine(machineId)

    const otherDir = tempState()
    try {
      const other = makeWorld(otherDir)
      const foreign = pairRemote(other.machines, { machineId })
      // Unit-level witness: this instance's root refuses the foreign MAC.
      expect(verifyPairingToken(w.enrollment.pairingRoot, foreign.token)).toBeNull()
      expect(verifyPairingToken(other.enrollment.pairingRoot, foreign.token)).not.toBeNull()
      const wrong = hello(w.machines, machineId, foreign.token)
      expect(wrong.ok).toBe(false)
      // Error byte-identical to the revoke case (D19.4 case 3 / D20).
      expect(wrong).toEqual(revokeReason)
      // Counterfactual: the real token still recovers unattended.
      expect(hello(w.machines, machineId, token).ok).toBe(true)
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })

  // ---------------------------------------------------------------------------
  // 4. RECOVERED ROW IS NOT AMBIENT
  // ---------------------------------------------------------------------------
  it('4. RECOVERED ROW IS NOT AMBIENT: owner from ledger, grants empty, non-owner denied', () => {
    const w = makeWorld(dir)
    const { machineId, token } = pairRemote(w.machines, { ownerUserId: OWNER })

    // Share use with a colleague, then lose the row (grants go with it or are dropped).
    w.store.grants.upsert({
      resourceKind: 'machine',
      resourceId: machineId,
      grantee: OTHER,
      verb: 'use',
      owner: OWNER,
      visibility: 'owned-compute',
      createdAt: new Date().toISOString(),
      actorKind: 'user',
      actorId: OWNER,
      onBehalfOf: OWNER,
    })
    expect(w.store.grants.listForResource('machine', machineId).length).toBeGreaterThan(0)

    w.store.machines.deleteMachine(machineId)
    w.store.grants.removeAllForResource('machine', machineId)

    const restarted = makeWorld(dir)
    expect(hello(restarted.machines, machineId, token).ok).toBe(true)

    const row = restarted.store.machines.getMachine(machineId)
    expect(row?.ownerUserId).toBe(OWNER)
    // Grants ALWAYS dropped on recovery (D19.4b) — never restored from a stale set.
    expect(restarted.store.grants.listForResource('machine', machineId)).toEqual([])

    const ownership = ownershipFromMachines(restarted.machines)
    const owner = userCommandPrincipal(asUserId(OWNER), 'admin')
    const colleague = userCommandPrincipal(OTHER, 'member')
    expect(checkMachineUse(owner, machineId, ownership)).toBeUndefined()
    // Non-owning member cannot use; without see they look "absent".
    expect(checkMachineUse(colleague, machineId, ownership)).toBe('absent')
    expect(canSeeMachine(colleague, machineId, ownership)).toBe(false)
  })

  it('4b. owner account deleted → QUARANTINED (admin see, nobody use)', () => {
    const w = makeWorld(dir)
    // Pair under OTHER so the ledger records that owner; then the account is gone.
    const { machineId, token } = pairRemote(w.machines, { ownerUserId: OTHER })
    expect(w.store.machines.getMachine(machineId)?.ownerUserId).toBe(OTHER)
    w.store.machines.deleteMachine(machineId)

    // Fully recreated DB / account gone: userExists reports OTHER unresolvable.
    // Do NOT auto-assign first admin (D19.4b).
    const store = new SessionStore(':memory:')
    const svc = new MachinesService({
      instanceId: 'default',
      store,
      hostMachineId: store.hostMachineId,
      enrollment: openEnrollmentLedger(dir),
      userExists: (id) => id !== OTHER && store.users.get(id) !== undefined,
      sessionsChangedForMachine: () => {},
      clients: () => [],
      machinesForPrincipal: () => [],
    })
    expect(hello(svc, machineId, token).ok).toBe(true)
    const row = store.machines.getMachine(machineId)
    // Quarantine: owner null, not first-admin.
    expect(row?.ownerUserId).toBeNull()
    expect(row?.ownerUserId).not.toBe(OWNER)

    const ownership = ownershipFromMachines(svc)
    const admin = userCommandPrincipal(asUserId(OWNER), 'admin')
    // Admin holds see, nobody holds use.
    expect(canSeeMachine(admin, machineId, ownership)).toBe(true)
    expect(checkMachineUse(admin, machineId, ownership)).toBe('unauthorized')
    expect(machineVerbsFor(admin, machineId, ownership)).toEqual(new Set(['see']))
    // A non-admin principal does not get see via quarantine.
    const plainMember = userCommandPrincipal(asUserId('user:nobody'), 'member')
    expect(canSeeMachine(plainMember, machineId, ownership)).toBe(false)
    expect(checkMachineVerb(admin, machineId, ownership, 'manage')).toBe('unauthorized')
  })

  // ---------------------------------------------------------------------------
  // 5. CRASH BETWEEN THE WRITES (D19.4d)
  // ---------------------------------------------------------------------------
  it('5. CRASH BETWEEN THE WRITES: owner transition append without row update; restart repairs', () => {
    const w = makeWorld(dir)
    const { machineId } = pairRemote(w.machines, { ownerUserId: OWNER })
    expect(w.store.machines.getMachine(machineId)?.ownerUserId).toBe(OWNER)

    // Append owner transition, kill before the machines row is updated.
    w.machines.transferOwnership(machineId, OTHER, { skipRowUpdate: true })
    // Row still shows OLD owner — the crash window.
    expect(w.store.machines.getMachine(machineId)?.ownerUserId).toBe(OWNER)
    // But the ledger already commits the NEW owner; effectiveOwner reflects it.
    expect(w.machines.effectiveOwner(machineId)).toBe(OTHER)
    const ownershipMidCrash = ownershipFromMachines(w.machines)
    const oldP = userCommandPrincipal(asUserId(OWNER), 'admin')
    const newP = userCommandPrincipal(OTHER, 'member')
    // Authorization must not serve the stale projection (D19.4d rule 2).
    expect(checkMachineUse(newP, machineId, ownershipMidCrash)).toBeUndefined()
    expect(checkMachineVerb(newP, machineId, ownershipMidCrash, 'manage')).toBeUndefined()
    // Old owner no longer holds use/manage via the ledger-wins ownershipRows path.
    // (They may still hold admin-grade fleet powers elsewhere; machine verbs drop.)
    expect(checkMachineUse(oldP, machineId, ownershipMidCrash)).not.toBeUndefined()

    // Restart: reconcile repairs the row with no manual step.
    const restarted = makeWorld(dir)
    // The row was in the old in-memory DB; simulate surviving DB with stale owner
    // by writing the pre-crash row into the new store, then reconciling.
    restarted.store.machines.upsertMachine({
      id: machineId,
      name: 'Remote Box',
      hostname: 'remote.local',
      tokenHash: 'stale',
      ownerUserId: OWNER,
    })
    const svc = new MachinesService({
      instanceId: 'default',
      store: restarted.store,
      hostMachineId: restarted.store.hostMachineId,
      enrollment: openEnrollmentLedger(dir),
      userExists: (id) => restarted.store.users.get(id) !== undefined,
      sessionsChangedForMachine: () => {},
      clients: () => [],
      machinesForPrincipal: () => [],
    })
    // Constructor ran reconcileOwnersFromLedger — row now shows NEW owner.
    expect(restarted.store.machines.getMachine(machineId)?.ownerUserId).toBe(OTHER)
    const ownership = ownershipFromMachines(svc)
    expect(checkMachineUse(userCommandPrincipal(OTHER, 'member'), machineId, ownership)).toBeUndefined()
    expect(
      checkMachineVerb(userCommandPrincipal(OTHER, 'member'), machineId, ownership, 'manage'),
    ).toBeUndefined()
    expect(checkMachineUse(userCommandPrincipal(asUserId(OWNER), 'admin'), machineId, ownership)).toBe(
      'absent',
    )
  })
})
