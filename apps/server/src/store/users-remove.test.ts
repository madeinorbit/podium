import { actorUser, asInviteId, asMachineId, asSessionId, asUserId, firstAdminMemberId } from '@podium/model'
import { afterEach, expect, it } from 'vitest'
import { MachinesService } from '../modules/machines/service'
import { WorldIndex } from '../modules/world-index'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'

const at = '2026-09-17T12:00:00Z'
const future = '2999-01-01T00:00:00Z'
const member = firstAdminMemberId()
const admin = asUserId('mem_remaining_admin')
const stores: SessionStore[] = []
afterEach(async () => { for (const store of stores.splice(0)) await store.close() })

async function setup() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  await store.users.create({ id: admin, displayName: 'Admin', role: 'admin', createdAt: at, disabledAt: null }, 'hash')
  await store.users.setPasswordHash(member, 'hash', at)
  await store.auth.createClientSession('member-cookie', member, future)
  await store.users.insertInvite({ id: asInviteId('invite-remove'), tokenHash: 'invite-hash', memberId: member, role: 'member', expiresAt: future, createdBy: admin, createdAt: at })
  for (const [id, ownerUserId] of [['owned', member], ['shared', member], ['other-owned', admin], ['unowned', null]] as const) {
    await store.machines.upsertMachine({ id, ownerUserId, name: id, hostname: id, tokenHash: id })
  }
  for (const [resourceKind, resourceId, grantee] of [['machine', 'shared', admin], ['machine', 'other-owned', member], ['machine', 'unowned', member], ['session', 'historical', member]] as const) {
    await store.grants.upsert({ resourceKind, resourceId, grantee, verb: 'use', owner: member, visibility: 'personal', actorKind: 'user', actorId: member, onBehalfOf: member, createdAt: at })
  }
  return store
}

it('removes custody and incoming grants atomically, preserves shares and attribution, and allows admin adoption', async () => {
  const store = await setup()
  await store.sessions.upsertSession({
    id: asSessionId('historical'), ownerUserId: member, createdBy: { actor: actorUser(member), onBehalfOf: member },
    agentKind: 'claude-code', cwd: '/repo', title: 'History', name: null, nameSource: null,
    originKind: 'spawn', conversationId: null, resumeKind: null, resumeValue: null,
    status: 'live', exitCode: null, spawnFailure: null, durableLabel: 'history',
    createdAt: at, lastActiveAt: at, geometry: { cols: 80, rows: 24 }, archived: false,
    workState: null, machineId: asMachineId('owned'), lastOutputAt: null, lastInputAt: null, lastResumedAt: null,
  })
  const historical = await store.sessions.getSession(asSessionId('historical'))
  const shares = (await store.grants.listForResource('machine', 'shared')).filter(edge => edge.grantee !== member)
  const index = await WorldIndex.load(store)
  await store.users.removeMember(member, admin)
  await store.users.removeMember(member, admin)
  for (const id of ['owned', 'shared', 'unowned']) {
    expect((await store.machines.custodian(id))).toBeNull()
    expect((index.reader.grantsFor('machine', id).find(edge => edge.custody)?.grantee ?? null)).toBeNull()
  }
  expect((await store.machines.custodian('other-owned'))).toBe(admin)
  expect(index.reader.user(member)).toBeUndefined()
  for (const [kind, id] of [['machine', 'other-owned'], ['machine', 'unowned'], ['session', 'historical']] as const) {
    expect((await store.grants.listForResource(kind, id)).filter(edge => edge.grantee === member)).toEqual([])
    expect(index.reader.grantsFor(kind, id).filter(edge => edge.grantee === member)).toEqual([])
  }
  expect(await store.grants.listForResource('machine', 'shared')).toEqual(shares)
  expect(index.reader.grantsFor('machine', 'shared')).toEqual(shares)
  expect(await store.sessions.getSession(asSessionId('historical'))).toEqual(historical)
  expect(await store.auth.getClientSession('member-cookie')).toBeUndefined()
  expect(await store.users.inviteByHash('invite-hash')).toBeUndefined()
  const audit = (await store.settingsAudit.list()).filter(row => row.command === 'members.remove')
  expect(audit).toHaveLength(2)
  expect(audit).toEqual(expect.arrayContaining(['owned', 'shared'].map(machineId => expect.objectContaining({ detail: expect.objectContaining({ machineId }) }))))
  for (const row of audit) expect(row).toMatchObject({ actorId: admin, outcome: 'applied', detail: { memberId: member, previousOwnerUserId: member, newOwnerUserId: null } })
  const svc = new MachinesService({ instanceId: 'default', store, hostMachineId: store.hostMachineId,
    sessionsChangedForMachine: () => {}, clients: () => [], machinesForPrincipal: async () => [],
    userExists: async id => !!await store.users.get(id),
  })
  try {
    await svc.adoptMachine(asMachineId('owned'), admin, admin)
    await store.users.removeMember(member, admin)
    expect((await store.machines.custodian('owned'))).toBe(admin)
    expect((await store.settingsAudit.list()).filter(row => row.command === 'members.remove')).toHaveLength(2)
  } finally { svc.dispose() }
  await store.users.enable(member, at)
  expect(await store.users.credentialFor(member)).toBeUndefined()
})

it('removes an already-disabled member without implicitly transferring custody', async () => {
  const store = await setup()
  await store.users.disable(member, at, admin)
  expect((await store.machines.custodian('owned'))).toBe(member)
  await store.users.removeMember(member, admin)
  expect((await store.machines.custodian('owned'))).toBeNull()
  expect((await store.settingsAudit.list()).filter(row => row.command === 'members.disable')).toHaveLength(1)
})

it('rolls back custody, grants, credentials, invites, sessions, audits and live publication together', async () => {
  const store = await setup()
  const index = await WorldIndex.load(store)
  const grants = await store.grants.loadWorldGrants()
  await expect(store.transact(async () => {
    await store.users.removeMember(member, admin)
    expect((await store.machines.custodian('owned'))).toBeNull()
    expect((index.reader.grantsFor('machine', 'owned').find(edge => edge.custody)?.grantee ?? null)).toBe(member)
    throw new Error('abort removal')
  })).rejects.toThrow('abort removal')
  expect((await store.machines.custodian('owned'))).toBe(member)
  expect((index.reader.grantsFor('machine', 'owned').find(edge => edge.custody)?.grantee ?? null)).toBe(member)
  expect(index.reader.user(member)).toBeDefined()
  expect(await store.users.credentialFor(member)).toBeDefined()
  expect(await store.users.inviteByHash('invite-hash')).toBeDefined()
  expect(await store.auth.getClientSession('member-cookie')).toBeDefined()
  expect(await store.grants.loadWorldGrants()).toEqual(grants)
  expect(await store.settingsAudit.list()).toEqual([])
})
