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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userCommandPrincipal } from './command-principal'
import { mintPairingToken, openEnrollmentLedger, verifyPairingToken } from './enrollment-ledger'
import { PairingManager } from './hub/pairing'
import {
  canSeeMachine,
  checkMachineUse,
  checkMachineVerb,
  machineVerbsFor,
  ownershipSnapshotFromMachines,
} from './machine-access'
import { MachinesService, sha256 } from './modules/machines/service'
import { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'

const OWNER = FIRST_ADMIN_USER_ID
const OTHER = asUserId('user:colleague')
const ORIGINAL_HOST = asMachineId('00000000-0000-4000-8000-000000000101')
const PROMOTED_HOST = asMachineId('00000000-0000-4000-8000-000000000202')

function tempState(): string {
  return mkdtempSync(join(tmpdir(), 'podium-enroll-'))
}

async function makeWorld(stateDir: string, opts: { dbPath?: string } = {}) {
  const store = await openTestStore(opts.dbPath ?? ':memory:')
  // Ensure the colleague exists for transfer / non-owner cases.
  const now = new Date().toISOString()
  if (!(await store.users.get(OTHER))) {
    await store.users.create(
      { id: OTHER, displayName: 'Colleague', role: 'member', createdAt: now, disabledAt: null },
      'hash',
    )
  }
  const enrollment = openEnrollmentLedger(stateDir)
  const pairing = new PairingManager({
    randomCode: () => `CODE-${Math.random().toString(36).slice(2, 10)}`,
  })
  const machines = new MachinesService({
    instanceId: 'default',
    store,
    hostMachineId: store.hostMachineId,
    pairing,
    enrollment,
    userExists: async (id) => await store.users.get(id) !== undefined,
    sessionsChangedForMachine: () => {},
    clients: () => [],
    machinesForPrincipal: async () => [],
  })
  return { store, machines, enrollment, pairing, stateDir }
}

async function pairRemote(
  machines: MachinesService,
  opts: { machineId?: string; ownerUserId?: string; hostname?: string } = {},
): Promise<{ machineId: string; token: string; name: string }> {
  const machineId = asMachineId(opts.machineId ?? 'remote-box')
  const code = machines.mintPairingCode({
    ...(opts.ownerUserId !== undefined
      ? { ownerUserId: asUserId(opts.ownerUserId) }
      : { ownerUserId: OWNER }),
  })
  const auth = await machines.authenticateDaemon({
    type: 'pair',
    code,
    machineId,
    hostname: opts.hostname ?? 'remote.local',
    name: 'Remote Box',
  })
  if (!auth.ok || !auth.token)
    throw new Error(`pair failed: ${'reason' in auth ? auth.reason : '?'}`)
  return { machineId: auth.machineId, token: auth.token, name: auth.name }
}

async function hello(
  machines: MachinesService,
  machineId: string,
  token: string,
  hostname = 'remote.local',
) {
  return await machines.authenticateDaemon({
    type: 'hello',
    machineId: asMachineId(machineId),
    token,
    hostname,
  })
}

function hostWorld(stateDir: string, store: SessionStore, hostMachineId = store.hostMachineId) {
  const enrollment = openEnrollmentLedger(stateDir)
  const machines = new MachinesService({
    instanceId: 'default',
    store,
    hostMachineId,
    enrollment,
    userExists: (id) => store.users.get(id) !== undefined,
    sessionsChangedForMachine: () => {},
    clients: () => [],
    machinesForPrincipal: async () => [],
  })
  return { enrollment, machines, store }
}

describe('server host enrollment provenance (POD-2467)', () => {
  let dir: string

  beforeEach(() => {
    dir = tempState()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('enrolls the original host without treating an arbitrary machine row as proof', async () => {
    const store = await SessionStore.open(':memory:', ORIGINAL_HOST)
    await store.machines.upsertMachine({
      id: asMachineId('forged-row'),
      name: 'Forged',
      hostname: 'forged.local',
      tokenHash: sha256('forged'),
      ownerUserId: OWNER,
    })
    const host = hostWorld(dir, store, ORIGINAL_HOST)

    await host.machines.ensureHostMachine('original.local', 'original-secret')

    expect(host.enrollment.isActivelyEnrolled(ORIGINAL_HOST)).toBe(true)
    expect(host.enrollment.recordedOwner(ORIGINAL_HOST)).toBe(OWNER)
    expect(host.enrollment.isActivelyEnrolled(asMachineId('forged-row'))).toBe(false)
    expect(await store.machines.getMachineByToken(ORIGINAL_HOST, 'original-secret')).toBe(true)
  })

  it('keeps a promoted paired host on its existing enrollment, owner, and new local credential', async () => {
    const source = makeWorld(dir)
    const paired = pairRemote((await source).machines, {
      machineId: PROMOTED_HOST,
      ownerUserId: OTHER,
    })
    const serialBeforePromotion = (await source).enrollment.nextSerial(PROMOTED_HOST)
    const promoted = hostWorld(dir, (await source).store, PROMOTED_HOST)

    await promoted.machines.ensureHostMachine('promoted.local', 'promoted-secret')

    expect(promoted.enrollment.isActivelyEnrolled(PROMOTED_HOST)).toBe(true)
    expect(promoted.enrollment.nextSerial(PROMOTED_HOST)).toBe(serialBeforePromotion)
    expect(promoted.enrollment.recordedOwner(PROMOTED_HOST)).toBe(OTHER)
    expect((await (await source).store.machines.getMachine(PROMOTED_HOST))?.ownerUserId).toBe(OTHER)
    expect(await (await source).store.machines.getMachineByToken(PROMOTED_HOST, 'promoted-secret')).toBe(true)
    expect(await (await source).store.machines.getMachineByToken(PROMOTED_HOST, (await paired).token)).toBe(false)
  })

  it('keeps the former host eligible when the server moves away and then returns', async () => {
    const store = await SessionStore.open(':memory:', ORIGINAL_HOST)
    const original = hostWorld(dir, store, ORIGINAL_HOST)
    await original.machines.ensureHostMachine('original.local', 'original-secret')
    const sourceSerial = original.enrollment.nextSerial(ORIGINAL_HOST)
    const pairing = new PairingManager({ randomCode: () => 'PROMOTE1' })
    const source = new MachinesService({
      instanceId: 'default',
      store,
      hostMachineId: ORIGINAL_HOST,
      pairing,
      enrollment: openEnrollmentLedger(dir),
      userExists: (id) => store.users.get(id) !== undefined,
      sessionsChangedForMachine: () => {},
      clients: () => [],
      machinesForPrincipal: async () => [],
    })
    await pairRemote(source, { machineId: PROMOTED_HOST })
    const promoted = hostWorld(dir, store, PROMOTED_HOST)
    await promoted.machines.ensureHostMachine('promoted.local', 'promoted-secret')

    const returned = hostWorld(dir, store, ORIGINAL_HOST)
    await returned.machines.ensureHostMachine('original.local', 'return-secret')

    expect(returned.enrollment.isActivelyEnrolled(ORIGINAL_HOST)).toBe(true)
    expect(returned.enrollment.isActivelyEnrolled(PROMOTED_HOST)).toBe(true)
    expect(returned.enrollment.nextSerial(ORIGINAL_HOST)).toBe(sourceSerial)
    expect(await store.machines.getMachineByToken(ORIGINAL_HOST, 'return-secret')).toBe(true)
  })

  it('does not let a forged host row override durable revocation', async () => {
    const store = await SessionStore.open(':memory:', ORIGINAL_HOST)
    const ledger = openEnrollmentLedger(dir)
    ledger.appendRevoke({
      id: 'revoke-forged-host',
      machineId: ORIGINAL_HOST,
      serial: 1,
      by: OWNER,
      at: new Date().toISOString(),
    })
    await store.machines.upsertMachine({
      id: ORIGINAL_HOST,
      name: 'Forged host',
      hostname: 'forged.local',
      tokenHash: sha256('forged-secret'),
      ownerUserId: OTHER,
    })
    const host = hostWorld(dir, store, ORIGINAL_HOST)

    await expect(
      host.machines.ensureHostMachine('trusted.local', 'trusted-secret'),
    ).rejects.toThrow('enrollment is revoked')
    expect(host.enrollment.isActivelyEnrolled(ORIGINAL_HOST)).toBe(false)
    expect(await store.machines.getMachineByToken(ORIGINAL_HOST, 'forged-secret')).toBe(true)
    expect(await store.machines.getMachineByToken(ORIGINAL_HOST, 'trusted-secret')).toBe(false)
  })

  it('reboots idempotently without appending another enrollment', async () => {
    const store = await SessionStore.open(':memory:', ORIGINAL_HOST)
    await hostWorld(dir, store, ORIGINAL_HOST).machines.ensureHostMachine('original.local', 'secret')
    const before = readFileSync(join(dir, 'enrollment.ledger'), 'utf8')

    const rebooted = hostWorld(dir, store, ORIGINAL_HOST)
    await rebooted.machines.ensureHostMachine('original.local', 'secret')
    const after = readFileSync(join(dir, 'enrollment.ledger'), 'utf8')

    expect(after).toBe(before)
    expect(rebooted.enrollment.nextSerial(ORIGINAL_HOST)).toBe(2)
    expect(rebooted.enrollment.isActivelyEnrolled(ORIGINAL_HOST)).toBe(true)
  })
})

describe('enrollment ledger unit', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('mints a token that verifies under the same root and fails under another', () => {
    dir = tempState()
    const a = openEnrollmentLedger(dir)
    const token = mintPairingToken(a.pairingRoot, { machineId: asMachineId('m1'), serial: 1 })
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
        machineId: asMachineId('m1'),
        serial: 1,
        ownerUserId: OWNER,
        at: new Date().toISOString(),
      }),
    ).toBe(true)
    expect(
      ledger.appendEnroll({
        id,
        machineId: asMachineId('m1'),
        serial: 1,
        ownerUserId: OWNER,
        at: new Date().toISOString(),
      }),
    ).toBe(false)
    expect(ledger.nextSerial(asMachineId('m1'))).toBe(2)
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
  it('1. LOSS RECOVERS: missing machines row re-enrols unattended with the same MachineId', async () => {
    const w = await makeWorld(dir)
    const { machineId, token } = await pairRemote(w.machines)
    expect((await w.store.machines.getMachine(machineId))?.ownerUserId).toBe(OWNER)

    // Accidental loss of the row (DB recreate / restore from before pairing).
    await w.store.machines.deleteMachine(machineId)
    expect(await w.store.machines.getMachine(machineId)).toBeUndefined()

    // "Restart": new MachinesService over the SAME ledger + a fresh in-memory DB
    // that has no row (simulates DB loss while state root survives).
    const restarted = await makeWorld(dir)
    // No pair code — only the old token.
    const auth = await hello(restarted.machines, machineId, token)
    expect(auth).toEqual({ ok: true, machineId, name: 'remote.local' })
    expect((await restarted.store.machines.getMachine(machineId))?.id).toBe(machineId)
    // Same MachineId preserved; token still authenticates after re-enrol.
    expect((await hello(restarted.machines, machineId, token)).ok).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // 2. REVOKE STAYS DENIED ACROSS DB ROLLBACK
  // ---------------------------------------------------------------------------
  it('2. REVOKE STAYS DENIED: rolling the DB back before the revoke still denies the old token', async () => {
    const dbPath = join(dir, 'podium.db')
    const w = await makeWorld(dir, { dbPath })
    const { machineId, token } = await pairRemote(w.machines)

    // Snapshot the row as it was AFTER pair and BEFORE revoke (the "backup").
    const row = await w.store.machines.getMachine(machineId)
    expect(row).toBeDefined()
    const tokenHash = sha256(token)

    // Intentional revoke — ledger append is the commit point.
    await w.machines.revokeMachine(asMachineId(machineId), { by: OWNER })
    expect(await w.store.machines.getMachine(machineId)).toBeUndefined()
    expect((await hello(w.machines, machineId, token)).ok).toBe(false)

    // DESTROY / ROLL BACK the DB to before the revoke: re-insert the pre-revoke row.
    // The ledger is NOT restored (D19.4a).
    await w.store.machines.upsertMachine({
      id: machineId,
      name: 'Remote Box',
      hostname: 'remote.local',
      tokenHash,
      ownerUserId: OWNER,
    })
    expect(await w.store.machines.getMachineByToken(machineId, token)).toBe(true)

    // Reconnect with the old token must still DENY — ledger wins.
    const denied = await hello(w.machines, machineId, token)
    expect(denied).toEqual({ ok: false, reason: 'unknown machine — re-pair' })

    // Restart over the same ledger + rolled-back DB: still denied.
    const restarted = await makeWorld(dir, { dbPath: join(dir, 'podium-restart.db') })
    // Simulate the rolled-back DB again on a fresh store.
    await restarted.store.machines.upsertMachine({
      id: machineId,
      name: 'Remote Box',
      hostname: 'remote.local',
      tokenHash,
      ownerUserId: OWNER,
    })
    // New service constructor reconciles: revoke projection should drop the row
    // (or at least deny hello). Either way hello must fail.
    const afterReconcile = await makeWorld(dir)
    await afterReconcile.store.machines.upsertMachine({
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
      userExists: async (id) => await afterReconcile.store.users.get(id) !== undefined,
      sessionsChangedForMachine: () => {},
      clients: () => [],
      machinesForPrincipal: async () => [],
    })
    expect((await hello(svc, machineId, token)).ok).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // 3. WRONG INSTANCE
  // ---------------------------------------------------------------------------
  it('3. WRONG INSTANCE: foreign pairing root denies with the same reason as revoke', async () => {
    const w = await makeWorld(dir)
    // A live enrollment on this instance (not revoked) so a foreign token for the
    // same MachineId is a re-enrol candidate if the MAC is skipped — that is the
    // mutant that sequence 3 must catch. Revoke-reason bytes come from a sibling.
    const { machineId, token } = await pairRemote(w.machines, { machineId: 'remote-box' })
    const sibling = await pairRemote(w.machines, { machineId: 'sibling-box' })
    await w.machines.revokeMachine(asMachineId(sibling.machineId))
    const revokeReason = await hello(w.machines, sibling.machineId, sibling.token)
    expect(revokeReason.ok).toBe(false)

    // Row lost without revoke — legitimate token would re-enrol; foreign must not.
    await w.store.machines.deleteMachine(machineId)

    const otherDir = tempState()
    try {
      const other = await makeWorld(otherDir)
      const foreign = await pairRemote(other.machines, { machineId })
      // Unit-level witness: this instance's root refuses the foreign MAC.
      expect(verifyPairingToken(w.enrollment.pairingRoot, foreign.token)).toBeNull()
      expect(verifyPairingToken(other.enrollment.pairingRoot, foreign.token)).not.toBeNull()
      const wrong = await hello(w.machines, machineId, foreign.token)
      expect(wrong.ok).toBe(false)
      // Error byte-identical to the revoke case (D19.4 case 3 / D20).
      expect(wrong).toEqual(revokeReason)
      // Counterfactual: the real token still recovers unattended.
      expect((await hello(w.machines, machineId, token)).ok).toBe(true)
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })

  // ---------------------------------------------------------------------------
  // 4. RECOVERED ROW IS NOT AMBIENT
  // ---------------------------------------------------------------------------
  it('4. RECOVERED ROW IS NOT AMBIENT: owner from ledger, grants empty, non-owner denied', async () => {
    const w = await makeWorld(dir)
    const { machineId, token } = await pairRemote(w.machines, { ownerUserId: OWNER })

    // Share use with a colleague, then lose the row (grants go with it or are dropped).
    await w.store.grants.upsert({
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
    expect((await w.store.grants.listForResource('machine', machineId)).length).toBeGreaterThan(0)

    await w.store.machines.deleteMachine(machineId)
    await w.store.grants.removeAllForResource('machine', machineId)

    const restarted = await makeWorld(dir)
    expect((await hello(restarted.machines, machineId, token)).ok).toBe(true)

    const row = await restarted.store.machines.getMachine(machineId)
    expect(row?.ownerUserId).toBe(OWNER)
    // Grants ALWAYS dropped on recovery (D19.4b) — never restored from a stale set.
    expect(await restarted.store.grants.listForResource('machine', machineId)).toEqual([])

    const ownership = await ownershipSnapshotFromMachines(restarted.machines)
    const owner = userCommandPrincipal(asUserId(OWNER), 'admin')
    const colleague = userCommandPrincipal(OTHER, 'member')
    expect(await checkMachineUse(owner, asMachineId(machineId), ownership)).toBeUndefined()
    // Non-owning member cannot use; without see they look "absent".
    expect(await checkMachineUse(colleague, asMachineId(machineId), ownership)).toBe('absent')
    expect(await canSeeMachine(colleague, asMachineId(machineId), ownership)).toBe(false)
  })

  it('4b. owner account deleted → QUARANTINED (admin see, nobody use)', async () => {
    const w = await makeWorld(dir)
    // Pair under OTHER so the ledger records that owner; then the account is gone.
    const { machineId, token } = await pairRemote(w.machines, { ownerUserId: OTHER })
    expect((await w.store.machines.getMachine(machineId))?.ownerUserId).toBe(OTHER)
    await w.store.machines.deleteMachine(machineId)

    // Fully recreated DB / account gone: userExists reports OTHER unresolvable.
    // Do NOT auto-assign first admin (D19.4b).
    const store = await openTestStore(':memory:')
    const svc = new MachinesService({
      instanceId: 'default',
      store,
      hostMachineId: store.hostMachineId,
      enrollment: openEnrollmentLedger(dir),
      userExists: async (id) => id !== OTHER && await store.users.get(id) !== undefined,
      sessionsChangedForMachine: () => {},
      clients: () => [],
      machinesForPrincipal: async () => [],
    })
    expect((await hello(svc, machineId, token)).ok).toBe(true)
    const row = await store.machines.getMachine(machineId)
    // Quarantine: owner null, not first-admin.
    expect(row?.ownerUserId).toBeNull()
    expect(row?.ownerUserId).not.toBe(OWNER)

    const ownership = await ownershipSnapshotFromMachines(svc)
    const admin = userCommandPrincipal(asUserId(OWNER), 'admin')
    // Admin holds see, nobody holds use.
    expect(await canSeeMachine(admin, asMachineId(machineId), ownership)).toBe(true)
    expect(await checkMachineUse(admin, asMachineId(machineId), ownership)).toBe('unauthorized')
    expect(await machineVerbsFor(admin, asMachineId(machineId), ownership)).toEqual(new Set(['see']))
    // A non-admin principal does not get see via quarantine.
    const plainMember = userCommandPrincipal(asUserId('user:nobody'), 'member')
    expect(await canSeeMachine(plainMember, asMachineId(machineId), ownership)).toBe(false)
    expect(await checkMachineVerb(admin, asMachineId(machineId), ownership, 'manage')).toBe(
      'unauthorized',
    )
  })

  // ---------------------------------------------------------------------------
  // 5. CRASH BETWEEN THE WRITES (D19.4d)
  // ---------------------------------------------------------------------------
  it('5. CRASH BETWEEN THE WRITES: owner transition append without row update; restart repairs', async () => {
    const w = await makeWorld(dir)
    const { machineId } = await pairRemote(w.machines, { ownerUserId: OWNER })
    expect((await w.store.machines.getMachine(machineId))?.ownerUserId).toBe(OWNER)

    // Append owner transition, kill before the machines row is updated.
    await w.machines.transferOwnership(asMachineId(machineId), OTHER, { skipRowUpdate: true })
    // Row still shows OLD owner — the crash window.
    expect((await w.store.machines.getMachine(machineId))?.ownerUserId).toBe(OWNER)
    // But the ledger already commits the NEW owner; effectiveOwner reflects it.
    expect(await w.machines.effectiveOwner(asMachineId(machineId))).toBe(OTHER)
    const ownershipMidCrash = await ownershipSnapshotFromMachines(w.machines)
    const oldP = userCommandPrincipal(asUserId(OWNER), 'admin')
    const newP = userCommandPrincipal(OTHER, 'member')
    // Authorization must not serve the stale projection (D19.4d rule 2).
    expect(await checkMachineUse(newP, asMachineId(machineId), ownershipMidCrash)).toBeUndefined()
    expect(
      await checkMachineVerb(newP, asMachineId(machineId), ownershipMidCrash, 'manage'),
    ).toBeUndefined()
    // Old owner no longer holds use/manage via the ledger-wins ownershipRows path.
    // (They may still hold admin-grade fleet powers elsewhere; machine verbs drop.)
    expect(await checkMachineUse(oldP, asMachineId(machineId), ownershipMidCrash)).not.toBeUndefined()

    // Restart: reconcile repairs the row with no manual step.
    const restarted = await makeWorld(dir)
    // The row was in the old in-memory DB; simulate surviving DB with stale owner
    // by writing the pre-crash row into the new store, then reconciling.
    await restarted.store.machines.upsertMachine({
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
      userExists: async (id) => await restarted.store.users.get(id) !== undefined,
      sessionsChangedForMachine: () => {},
      clients: () => [],
      machinesForPrincipal: async () => [],
    })
    // Constructor ran reconcileOwnersFromLedger — row now shows NEW owner.
    expect((await restarted.store.machines.getMachine(machineId))?.ownerUserId).toBe(OTHER)
    const ownership = await ownershipSnapshotFromMachines(svc)
    expect(
      await checkMachineUse(userCommandPrincipal(OTHER, 'member'), asMachineId(machineId), ownership),
    ).toBeUndefined()
    expect(
      await checkMachineVerb(
        userCommandPrincipal(OTHER, 'member'),
        asMachineId(machineId),
        ownership,
        'manage',
      ),
    ).toBeUndefined()
    expect(
      await checkMachineUse(
        userCommandPrincipal(asUserId(OWNER), 'admin'),
        asMachineId(machineId),
        ownership,
      ),
    ).toBe('absent')
  })
})
