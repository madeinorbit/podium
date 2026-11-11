import { asMachineId, asUserId, firstAdminMemberId, machineAccessRowId } from '@podium/model'
import { machinePublicKeyWire } from '@podium/runtime/machine-credential'
import { mintSigningKeyPair } from '@podium/runtime/signing'
import { afterEach, expect, it, vi } from 'vitest'
import { disposeOracles, makeOracle } from '../sessions/oracle-support'

const AT = '2026-11-11T00:00:00.000Z'
const MEMBER = asUserId('user:machine-reader')

afterEach(async () => {
  vi.restoreAllMocks()
  await disposeOracles()
})

it('a source rename compares its records without reading the stored sync copy', async () => {
  const o = await makeOracle()
  const id = o.store.hostMachineId
  const before = await o.store.sync.maxChangeSeq()

  await o.store.machines.renameMachine(id, 'Renamed')
  const changes = await o.store.sync.changesSince(before)
  expect(changes.filter((row) => row.entity === 'machine')).toMatchObject([
    { entityId: id, op: 'upsert' },
  ])
  expect(JSON.parse(changes.find((row) => row.entity === 'machine')!.payload!)).toMatchObject({
    id,
    name: 'Renamed',
  })
  const unchanged = await o.store.sync.maxChangeSeq()
  await o.store.machines.renameMachine(id, 'Renamed')
  expect(await o.store.sync.maxChangeSeq()).toBe(unchanged)
})

it('custody writes publish each final record once across their several grant writes', async () => {
  const o = await makeOracle()
  const id = o.store.hostMachineId
  await o.store.users.create(
    { id: MEMBER, displayName: 'Reader', role: 'member', createdAt: AT, disabledAt: null },
    'hash',
  )
  const before = await o.store.sync.maxChangeSeq()
  await o.store.machines.setMachineOwner(id, MEMBER)
  const changes = (await o.store.sync.changesSince(before)).filter(
    (row) => row.entity === 'machine' || row.entity === 'machineAccess',
  )
  expect(new Set(changes.map((row) => `${row.entity}:${row.entityId}`)).size).toBe(changes.length)
  const display = changes.filter((row) => row.entity === 'machine')
  expect(display).toHaveLength(1)
  expect(JSON.parse(display[0]!.payload!)).toMatchObject({ id, custodian: MEMBER })
  expect(changes).toContainEqual(
    expect.objectContaining({
      entity: 'machineAccess',
      entityId: machineAccessRowId(MEMBER, id),
      op: 'upsert',
    }),
  )
})

it('credential adoption compares the assignment stored with the credential', async () => {
  const o = await makeOracle()
  const id = o.store.hostMachineId
  const before = await o.store.sync.maxChangeSeq()
  expect(
    await o.store.machines.adoptLegacyHostCredential(
      id,
      machinePublicKeyWire(mintSigningKeyPair()),
      { server: true, agentExecution: false },
      { version: 1, source: 'enrollment', requestId: id },
    ),
  ).toBe(true)
  const changes = (await o.store.sync.changesSince(before))
    .filter((row) => row.entity === 'machineAccess')
    .map((row) => JSON.parse(row.payload ?? 'null'))
  expect(changes).toContainEqual(
    expect.objectContaining({
      serviceAssignment: { server: true, agentExecution: false },
      components: ['server'],
    }),
  )
})

it('member creation, disablement, enablement and role changes compare the member across the fleet', async () => {
  const o = await makeOracle()
  const owner = await firstAdminMemberId(o.store)
  const other = asMachineId('machine:other')
  await o.store.machines.upsertMachine({
    id: other,
    name: 'Other',
    hostname: 'other.example',
    tokenHash: 'hash',
    ownerUserId: owner,
  })
  const ids = [o.store.hostMachineId, other].map((id) => machineAccessRowId(MEMBER, id)).sort()
  let before = await o.store.sync.maxChangeSeq()
  await o.store.users.create(
    { id: MEMBER, displayName: 'Reader', role: 'admin', createdAt: AT, disabledAt: null },
    'hash',
  )
  const changed = async () =>
    (await o.store.sync.changesSince(before)).filter(
      (row) => row.entity === 'machineAccess' && ids.includes(row.entityId),
    )
  expect((await changed()).map((row) => row.entityId).sort()).toEqual(ids)
  for (const [write, op] of [
    [() => o.store.users.disable(MEMBER, AT), 'remove'],
    [() => o.store.users.enable(MEMBER, AT), 'upsert'],
    [() => o.store.users.setRole(MEMBER, 'member'), 'remove'],
  ] as const) {
    before = await o.store.sync.maxChangeSeq()
    await write()
    const changes = await changed()
    expect(changes.map((row) => row.entityId).sort()).toEqual(ids)
    expect(changes.every((row) => row.op === op)).toBe(true)
  }
})

it('target publication, withdrawal and fleet-channel settings carry the display change in their write', async () => {
  const o = await makeOracle()
  const id = o.store.hostMachineId
  await o.store.machines.setUpdateChannel(id, null)
  const settings = await o.store.settings.getSettings()
  await o.store.settings.setSettings({
    ...settings,
    deployment: { ...settings.deployment, updateChannel: 'stable' },
  })
  let before = await o.store.sync.maxChangeSeq()
  const target = { version: '0.5.0', critical: false, artifacts: {} }
  await o.reg.modules.updates.setTarget('stable', target)
  const displayChanges = async () =>
    (await o.store.sync.changesSince(before))
      .filter((row) => row.entity === 'machine' && row.entityId === id)
      .map((row) => JSON.parse(row.payload!))
  expect(await displayChanges()).toMatchObject([{ targetVersion: '0.5.0' }])

  before = await o.store.sync.maxChangeSeq()
  await o.reg.modules.updates.setTargetUnavailable('stable', 'Withdrawn')
  expect(await displayChanges()).toMatchObject([{ targetVersion: null }])
  await o.reg.modules.updates.setTarget('edge', { ...target, version: '0.6.0' })

  before = await o.store.sync.maxChangeSeq()
  await expect(
    o.store.transact(async () => {
      await o.store.settings.setSettings({
        ...settings,
        deployment: { ...settings.deployment, updateChannel: 'edge' },
      })
      expect((await o.store.machines.recordContext.read()).fleetChannel).toBe('edge')
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  expect(await o.store.sync.maxChangeSeq()).toBe(before)
  expect((await o.store.machines.recordContext.read()).fleetChannel).toBe('stable')

  await o.store.settings.setSettings({
    ...settings,
    deployment: { ...settings.deployment, updateChannel: 'edge' },
  })
  expect(await displayChanges()).toMatchObject([
    {
      updateChannel: 'edge',
      targetVersion: '0.6.0',
    },
  ])
})
