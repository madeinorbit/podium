/** Database-authoritative enrollment and legacy stage-1 bearer regressions (rules 2–4). */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asUserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mintSigningKeyPair, publicKeyWire } from '@podium/runtime/signing'
import { signWithMachine } from '@podium/runtime/machine-credential'
import type { ControlMessage } from '@podium/protocol/daemon'
import { userCommandPrincipal } from './command-principal'
import { mintPairingToken, openEnrollmentLedger, verifyPairingToken, type EnrollmentLedger } from './enrollment-ledger'
import { canSeeMachine, checkMachineUse, checkMachineVerb, machineVerbsFor, ownershipSnapshotFromMachines } from './machine-access'
import { MachinesService, sha256, type PairingGrant, type MachinesDeps } from './modules/machines/service'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'

const OWNER = asUserId('user:enrollment-admin')
const OTHER = asUserId('user:colleague')
const ORIGINAL_HOST = asMachineId('00000000-0000-4000-8000-000000000101')
const PROMOTED_HOST = asMachineId('00000000-0000-4000-8000-000000000202')
const DENIED = { ok: false, reason: 'unknown machine — re-pair' }
const stores: SessionStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

function tempState(): string {
  return mkdtempSync(join(tmpdir(), 'podium-enroll-'))
}

function service(store: SessionStore, hostMachineId = store.hostMachineId, pairing?: MachinesDeps['pairing']) {
  return new MachinesService({
    instanceId: 'default', installationId: 'durability-installation', store, hostMachineId, pairing,
    userExists: async (id) => await store.users.get(id) !== undefined,
    sessionsChangedForMachine: () => {}, clients: () => [], machinesForPrincipal: async () => [],
  })
}

async function makeWorld(stateDir: string) {
  const store = await openTestStore(':memory:')
  stores.push(store)
  for (const [id, role] of [[OWNER, 'admin'], [OTHER, 'member']] as const) {
    await store.users.create({ id, displayName: id, role, createdAt: new Date().toISOString(), disabledAt: null }, 'hash')
  }
  // Historical disk data is fixture evidence only, never a runtime dependency.
  const enrollment = openEnrollmentLedger(stateDir)
  return { store, machines: service(store), enrollment }
}

async function seedStage1Remote(
  store: SessionStore,
  enrollment: EnrollmentLedger,
  opts: { machineId?: string; ownerUserId?: string; hostname?: string } = {},
): Promise<{ machineId: string; token: string; name: string }> {
  const machineId = asMachineId(opts.machineId ?? 'remote-box')
  // Explicit POD-4155 fixture: pre-keypair bearer issuance, not new enrollment.
  const serial = enrollment.nextSerial(machineId)
  const ownerUserId = asUserId(opts.ownerUserId ?? OWNER)
  const token = mintPairingToken(enrollment.pairingRoot, { machineId, serial })
  enrollment.appendEnroll({ id: `fixture-${machineId}-${serial}`, machineId, serial, ownerUserId, at: new Date().toISOString() })
  await store.machines.upsertMachine({ id: machineId, name: 'Remote Box', hostname: opts.hostname ?? 'remote.local', tokenHash: sha256(token), ownerUserId,
    assignment: { server: false, agentExecution: true } })
  return { machineId, token, name: 'Remote Box' }
}

async function hello(machines: MachinesService, machineId: string, token: string) {
  return await machines.authenticateDaemon({ type: 'hello', machineId: asMachineId(machineId), token, hostname: 'remote.local' })
}

describe('database-authoritative host credentials', () => {
  let dir: string
  beforeEach(() => { dir = tempState() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('does not reconstruct a missing host row or infer an owner from the ledger', async () => {
    const source = await makeWorld(dir)
    const paired = await seedStage1Remote(source.store, source.enrollment, { machineId: PROMOTED_HOST, ownerUserId: OTHER })
    const target = await makeWorld(dir)
    expect(await hello(service(target.store, PROMOTED_HOST), PROMOTED_HOST, paired.token)).toEqual(DENIED)
    expect(await target.store.machines.getMachine(PROMOTED_HOST)).toBeUndefined()
  })

  it('stores the original host credential in the database without ledger enrollment or owner inference', async () => {
    const w = await makeWorld(dir)
    const host = service(w.store, ORIGINAL_HOST)
    await host.ensureHostMachine('original.local', 'original-secret')
    expect(w.enrollment.isActivelyEnrolled(ORIGINAL_HOST)).toBe(false)
    expect(w.enrollment.recordedOwner(ORIGINAL_HOST)).toBeUndefined()
    expect((await w.store.machines.custodian(ORIGINAL_HOST))).toBeNull()
    expect(await w.store.machines.getMachineByToken(ORIGINAL_HOST, 'original-secret')).toBe(true)
  })

  it('preserves the database owner when a paired host receives its local credential', async () => {
    const w = await makeWorld(dir)
    const paired = await seedStage1Remote(w.store, w.enrollment, { machineId: PROMOTED_HOST, ownerUserId: OTHER })
    const before = readFileSync(w.enrollment.path, 'utf8')
    await service(w.store, PROMOTED_HOST).ensureHostMachine('promoted.local', 'promoted-secret')
    expect(readFileSync(w.enrollment.path, 'utf8')).toBe(before)
    expect((await w.store.machines.custodian(PROMOTED_HOST))).toBe(OTHER)
    expect(await w.store.machines.getMachineByToken(PROMOTED_HOST, 'promoted-secret')).toBe(true)
    expect(await w.store.machines.getMachineByToken(PROMOTED_HOST, paired.token)).toBe(false)
  })

  it('keeps host credentials in the database when the server moves away and returns', async () => {
    const w = await makeWorld(dir)
    await service(w.store, ORIGINAL_HOST).ensureHostMachine('original.local', 'original-secret')
    await seedStage1Remote(w.store, w.enrollment, { machineId: PROMOTED_HOST })
    await service(w.store, PROMOTED_HOST).ensureHostMachine('promoted.local', 'promoted-secret')
    await service(w.store, ORIGINAL_HOST).ensureHostMachine('original.local', 'return-secret')
    expect(w.enrollment.isActivelyEnrolled(ORIGINAL_HOST)).toBe(false)
    expect(await w.store.machines.getMachineByToken(ORIGINAL_HOST, 'return-secret')).toBe(true)
    expect(await w.store.machines.getMachineByToken(PROMOTED_HOST, 'promoted-secret')).toBe(true)
  })

  it('does not treat a legacy ledger revoke as authority over an active database row', async () => {
    const w = await makeWorld(dir)
    const paired = await seedStage1Remote(w.store, w.enrollment, { machineId: ORIGINAL_HOST, ownerUserId: OTHER })
    w.enrollment.appendRevoke({ id: 'legacy-revoke', machineId: ORIGINAL_HOST, serial: 1, by: OWNER, at: new Date().toISOString() })
    expect(w.enrollment.isActivelyEnrolled(ORIGINAL_HOST)).toBe(false)
    expect((await hello(w.machines, ORIGINAL_HOST, paired.token)).ok).toBe(true)
    expect((await w.store.machines.custodian(ORIGINAL_HOST))).toBe(OTHER)
  })

  it('reboots without writing the ledger or inventing an owner', async () => {
    const w = await makeWorld(dir)
    const before = readFileSync(w.enrollment.path, 'utf8')
    await service(w.store, ORIGINAL_HOST).ensureHostMachine('original.local', 'secret')
    await service(w.store, ORIGINAL_HOST).ensureHostMachine('original.local', 'secret')
    expect(readFileSync(w.enrollment.path, 'utf8')).toBe(before)
    expect(w.enrollment.nextSerial(ORIGINAL_HOST)).toBe(1)
    expect(w.enrollment.isActivelyEnrolled(ORIGINAL_HOST)).toBe(false)
    expect((await w.store.machines.custodian(ORIGINAL_HOST))).toBeNull()
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

describe('database-authoritative legacy bearer lifecycle', () => {
  let dir: string
  beforeEach(() => { dir = tempState() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('accepts an explicit stage-1 bearer only while its database row exists', async () => {
    const w = await makeWorld(dir)
    const { machineId, token } = await seedStage1Remote(w.store, w.enrollment)
    expect(await hello(w.machines, machineId, token)).toEqual({ ok: true, machineId, name: 'Remote Box', legacyBindingOwners: {} })
    await w.store.machines.deleteMachine(machineId)
    expect(await hello(w.machines, machineId, token)).toEqual(DENIED)
    const restarted = service(w.store)
    expect(await hello(restarted, machineId, token)).toEqual(DENIED)
    expect(await w.store.machines.getMachine(machineId)).toBeUndefined()
  })

  it('retains the revoked row and denies its bearer across service restart', async () => {
    const w = await makeWorld(dir)
    const { machineId, token } = await seedStage1Remote(w.store, w.enrollment)
    const before = readFileSync(w.enrollment.path, 'utf8')
    await w.machines.revokeMachine(asMachineId(machineId), { by: OWNER })
    const row = await w.store.machines.getMachine(machineId)
    expect(row).toMatchObject({ id: machineId, revokedAt: expect.any(String) })
    expect(await w.store.machines.custodian(machineId)).toBe(OWNER)
    expect(readFileSync(w.enrollment.path, 'utf8')).toBe(before)
    expect(await hello(w.machines, machineId, token)).toEqual(DENIED)
    expect(await hello(service(w.store), machineId, token)).toEqual(DENIED)
    expect((await w.store.machines.getMachine(machineId))?.revokedAt).toBe(row?.revokedAt)
  })

  it('denies foreign and historical local bearers identically when the row is missing', async () => {
    const w = await makeWorld(dir)
    const { machineId, token } = await seedStage1Remote(w.store, w.enrollment)
    await w.store.machines.deleteMachine(machineId)
    const otherDir = tempState()
    try {
      const other = await makeWorld(otherDir)
      const foreign = await seedStage1Remote(other.store, other.enrollment, { machineId })
      expect(verifyPairingToken(w.enrollment.pairingRoot, foreign.token)).toBeNull()
      expect(await hello(w.machines, machineId, foreign.token)).toEqual(DENIED)
      expect(await hello(w.machines, machineId, token)).toEqual(DENIED)
      expect(await w.store.machines.getMachine(machineId)).toBeUndefined()
    } finally { rmSync(otherDir, { recursive: true, force: true }) }
  })

  it('does not restore custody or grants from historical enrollment after database loss', async () => {
    const w = await makeWorld(dir)
    const { machineId, token } = await seedStage1Remote(w.store, w.enrollment)
    const restarted = await makeWorld(dir)
    expect(await hello(restarted.machines, machineId, token)).toEqual(DENIED)
    expect(await restarted.store.machines.getMachine(machineId)).toBeUndefined()
    expect(await restarted.store.grants.listForResource('machine', machineId)).toEqual([])
    const ownership = await ownershipSnapshotFromMachines(restarted.machines)
    for (const principal of [userCommandPrincipal(OWNER, 'admin'), userCommandPrincipal(OTHER, 'member')]) {
      expect(await checkMachineUse(principal, asMachineId(machineId), ownership)).toBe('absent')
      expect(await canSeeMachine(principal, asMachineId(machineId), ownership)).toBe(false)
    }
  })

  it('lets admins see and manage an explicitly unowned row without granting use', async () => {
    const w = await makeWorld(dir)
    const { machineId, token } = await seedStage1Remote(w.store, w.enrollment, { ownerUserId: OTHER })
    await w.store.machines.setMachineOwner(asMachineId(machineId), null)
    expect((await hello(w.machines, machineId, token)).ok).toBe(true)
    const ownership = await ownershipSnapshotFromMachines(w.machines)
    const admin = userCommandPrincipal(OWNER, 'admin')
    expect(await machineVerbsFor(admin, asMachineId(machineId), ownership)).toEqual(new Set(['see', 'manage']))
    expect(await checkMachineUse(admin, asMachineId(machineId), ownership)).toBe('unauthorized')
    expect(await checkMachineVerb(admin, asMachineId(machineId), ownership, 'manage')).toBeUndefined()
    expect(await canSeeMachine(userCommandPrincipal(OTHER, 'member'), asMachineId(machineId), ownership)).toBe(false)
    expect((await w.store.machines.custodian(machineId))).toBeNull()
  })

  it('uses database custody after a legacy owner append and never repairs it at boot', async () => {
    const w = await makeWorld(dir)
    const { machineId } = await seedStage1Remote(w.store, w.enrollment)
    w.enrollment.appendOwner({ id: 'historical-owner-transition', machineId: asMachineId(machineId), ownerUserId: OTHER, at: new Date().toISOString() })
    expect(w.enrollment.recordedOwner(asMachineId(machineId))).toBe(OTHER)
    for (const machines of [w.machines, service(w.store)]) {
      expect(await machines.effectiveOwner(asMachineId(machineId))).toBe(OWNER)
      expect((await w.store.machines.custodian(machineId))).toBe(OWNER)
      const ownership = await ownershipSnapshotFromMachines(machines)
      expect(await checkMachineVerb(userCommandPrincipal(OWNER, 'admin'), asMachineId(machineId), ownership, 'manage')).toBeUndefined()
      expect(await checkMachineVerb(userCommandPrincipal(OTHER, 'member'), asMachineId(machineId), ownership, 'manage')).toBe('absent')
    }
    await w.machines.transferOwnership(asMachineId(machineId), OTHER)
    expect(await service(w.store).effectiveOwner(asMachineId(machineId))).toBe(OTHER)
    const ownership = await ownershipSnapshotFromMachines(w.machines)
    expect(await checkMachineVerb(userCommandPrincipal(OWNER, 'admin'), asMachineId(machineId), ownership, 'manage')).toBeUndefined()
    expect(await checkMachineUse(userCommandPrincipal(OWNER, 'admin'), asMachineId(machineId), ownership)).toBe('unauthorized')
  })
})


describe('Part B incarnation transitions', () => {
  let dir: string
  let machines: MachinesService
  beforeEach(() => { dir = tempState() })
  afterEach(() => { machines?.dispose(); rmSync(dir, { recursive: true, force: true }) })

  async function fixture() {
    const w = await makeWorld(dir)
    w.machines.dispose()
    const codes = new Map<string, PairingGrant>()
    let serial = 0
    machines = service(w.store, w.store.hostMachineId, {
      mint: (grant = {}) => {
        const code = `replacement-${++serial}`
        codes.set(code, { ...grant, installationId: 'durability-installation' })
        return code
      },
      peek: code => codes.get(code),
      redeem: code => { const grant = codes.get(code); codes.delete(code); return grant },
    })
    const paired = await seedStage1Remote(w.store, w.enrollment)
    const id = asMachineId(paired.machineId)
    const key = mintSigningKeyPair()
    const frame = { type: 'pair' as const, machineId: id, hostname: 'replacement.local', publicKey: publicKeyWire(key) }
    return { store: w.store, id, token: paired.token, key, frame }
  }

  // Design Part B, B8: "revoked_at; connections dropped; queued work cancelled".
  it('B8: revoke closes the live credential connection and cancels offline control before replacement', async () => {
    const { store, id, token, frame } = await fixture()
    let closed = 0
    const oldFence = machines.credentialFence()
    machines.registerCredentialConnection(id, () => { closed += 1 })
    const queued: ControlMessage = { type: 'inventoryRequest' }
    machines.toMachine(id, queued)
    expect((await hello(machines, id, token)).ok).toBe(true)
    await machines.revokeMachine(id, { by: OWNER })
    expect(closed).toBe(1)
    expect(oldFence(id)).toBe(false)
    expect(await hello(machines, id, token)).toEqual(DENIED)
    await expect(machines.attach(id, () => {})).rejects.toThrow('revoked')
    expect((await store.machines.getMachine(id))?.revokedAt).toEqual(expect.any(String))
    const code = await machines.mintReplacementPairingCode(id, { ownerUserId: OWNER }, true)
    expect((await machines.authenticateDaemon({ ...frame, code })).ok).toBe(true)
    const delivered: ControlMessage[] = []
    await machines.attach(id, message => { delivered.push(message) })
    await machines.flushQueued(id)
    expect(delivered).toEqual([])
    machines.toMachine(id, queued)
    expect(delivered).toEqual([queued]) // Positive transport control: cancellation, not a dead sender.
    await machines.revokeMachine(id, { by: OWNER })
    expect((await machines.listMachines()).find(machine => machine.id === id)?.online).toBe(false)
    machines.toMachine(id, queued)
    expect(delivered).toEqual([queued])
  })

  // Design Part B, M9: "Revoke with queued control, old connection,
  // concurrent re-enrol" → "old incarnation cannot act after the transition".
  it('M9: a live old credential and queued control lose authority during concurrent revoke and re-enrol', async () => {
    const { id, token, frame } = await fixture()
    const fence = machines.credentialFence()
    let closed = 0
    machines.registerCredentialConnection(id, () => { closed += 1 })
    expect((await hello(machines, id, token)).ok).toBe(true)
    machines.toMachine(id, { type: 'inventoryRequest' })
    const revoking = machines.revokeMachine(id, { by: OWNER })
    const replacing = (async () => {
      // Mint queues behind revoke on the same transition lane, without the
      // caller awaiting revoke; replacement binds the committed incarnation.
      const code = await machines.mintReplacementPairingCode(id, { ownerUserId: OWNER }, true)
      return machines.authenticateDaemon({ ...frame, code })
    })()
    machines.toMachine(id, { type: 'inventoryRequest' })
    const [, replacement] = await Promise.all([revoking, replacing])
    expect(replacement.ok).toBe(true)
    expect(closed).toBe(1)
    expect(fence(id)).toBe(false)
    expect(await hello(machines, id, token)).toEqual(DENIED)
    const delivered: ControlMessage[] = []
    await machines.attach(id, message => { delivered.push(message) })
    await machines.flushQueued(id)
    expect(delivered).toEqual([])
    machines.toMachine(id, { type: 'inventoryRequest' })
    expect(delivered).toEqual([{ type: 'inventoryRequest' }])
  })

  // Design Part B, B2: "new credential incarnation; old connections dropped";
  // M9: "Revoke with queued control, old connection, concurrent re-enrol" →
  // "old incarnation cannot act after the transition". Rev 28 explicitly says
  // "queued work cancelled with the old incarnation, re-issued by callers".
  it.each(['revoke-first', 'replacement-first'] as const)('B2/M9: %s serializes revoke, queued control and replacement', async order => {
    const { store, id, token, key, frame } = await fixture()
    const oldFence = machines.credentialFence()
    let closed = 0
    machines.registerCredentialConnection(id, () => { closed += 1 })
    machines.toMachine(id, { type: 'inventoryRequest' })
    // Obtain a credential-bound replacement capability while the retained row is revoked.
    await machines.revokeMachine(id, { by: OWNER })
    const code = await machines.mintReplacementPairingCode(id, { ownerUserId: OWNER }, true)
    const replace = () => machines.authenticateDaemon({ ...frame, code })
    const revoke = () => machines.revokeMachine(id, { by: OWNER })
    // Both promises start before either settles; the per-machine transition lane
    // determines whether the new incarnation is active or itself revoked.
    const pending = order === 'revoke-first' ? [revoke(), replace()] : [replace(), revoke()]
    machines.toMachine(id, { type: 'inventoryRequest' })
    const results = await Promise.all(pending)
    expect(results[order === 'revoke-first' ? 1 : 0]).toMatchObject({ ok: true })
    expect(closed).toBe(1)
    expect(oldFence(id)).toBe(false)
    expect(await hello(machines, id, token)).toEqual(DENIED)
    expect(await store.machines.credentialIncarnation(id)).toBe(frame.publicKey)
    const transcript = 'replacement-proof'
    const signature = signWithMachine(key, transcript)
    expect(await store.machines.verifyMachineSignature(id, transcript, signature)).toBe(order === 'revoke-first')
    if (order === 'revoke-first') {
      const delivered: ControlMessage[] = []
      await machines.attach(id, message => { delivered.push(message) })
      await machines.flushQueued(id)
      expect(delivered).toEqual([])
      machines.toMachine(id, { type: 'inventoryRequest' })
      expect(delivered).toEqual([{ type: 'inventoryRequest' }])
    } else {
      await expect(machines.attach(id, () => {})).rejects.toThrow('revoked')
    }
  })
})
