import { asDelegationRef } from '@podium/protocol'
import { actorAgent, agentIdentityFromSessionId, asUserId, firstAdminMemberId } from '@podium/model'
import { hashPassword } from '@podium/runtime/auth-store'
import { Hono } from 'hono'
import { afterEach, expect, it } from 'vitest'
import { registerAuthRoute, requestUserId } from '../auth-route'
import { WorldIndex } from '../modules/world-index'
import { SessionRegistry } from '../relay'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'

const at = '2026-09-17T12:00:00Z'
const future = '2999-01-01T00:00:00Z'
const stores: SessionStore[] = []
afterEach(async () => { for (const store of stores.splice(0)) await store.close() })
async function setup() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  return store
}

it('atomically revokes all client sessions, preserves custody/shares, and re-enables idempotently', async () => {
  const store = await setup()
  const member = firstAdminMemberId()
  await store.users.setPasswordHash(member, 'hash', at)
  const other = asUserId('mem_other')
  await store.users.create({ id: other, displayName: 'Other', role: 'member', createdAt: at, disabledAt: null }, 'hash')
  await store.machines.upsertMachine({ id: 'shared-machine', name: 'Shared', hostname: 'host', tokenHash: 'machine-token', ownerUserId: member })
  for (const verb of ['use', 'manage'] as const) await store.grants.upsert({
    resourceKind: 'machine', resourceId: 'shared-machine', grantee: other, verb,
    owner: member, visibility: 'personal', actorKind: 'user', actorId: member, onBehalfOf: member, createdAt: at,
  })
  const shares = await store.grants.listForResource('machine', 'shared-machine')
  const index = await WorldIndex.load(store)
  const machine = index.reader.machine('shared-machine')
  for (const label of ['login', 'mobile', 'break-glass', 'upstream']) {
    await store.auth.createClientSession(label, member, future, label)
  }
  await store.auth.createClientSession('other', other, future)
  await store.users.disable(member, at)
  await store.users.disable(member, 'later')
  expect(index.reader.user(member)).toBeUndefined()
  expect(await store.users.credentialFor(member)).toBeUndefined()
  expect((await store.auth.listClientSessions()).map(row => row.tokenHash)).toEqual(['other'])
  expect(index.reader.machine('shared-machine')).toEqual(machine)
  expect(await store.grants.listForResource('machine', 'shared-machine')).toEqual(shares)
  expect(index.reader.grantsFor('machine', 'shared-machine')).toEqual(expect.arrayContaining(shares))
  expect(index.reader.grantsFor('machine', 'shared-machine')).toHaveLength(shares.length)
  await expect(store.auth.createClientSession('late-login', member, future)).rejects.toThrow('Member disabled')
  expect(await store.auth.getClientSession('late-login')).toBeUndefined()
  expect(await store.settingsAudit.list()).toMatchObject([{ command: 'members.disable', detail: { memberId: member, runningAgentPolicy: 'let-finish' }, createdAt: at }])
  expect(await store.settingsAudit.list()).toHaveLength(1)
  await store.users.enable(member, 'enabled')
  await store.users.enable(member, 'later')
  expect(index.reader.user(member)?.role).toBe('admin')
  expect(await store.users.credentialFor(member)).toBeDefined()
  expect(await store.auth.getClientSession('login')).toBeUndefined()
  expect(index.reader.machine('shared-machine')).toEqual(machine)
  expect(await store.settingsAudit.list()).toHaveLength(2)
})

it('rolls back member, sessions, audit and live principal publication together', async () => {
  const store = await setup()
  const member = firstAdminMemberId()
  const index = await WorldIndex.load(store)
  await store.auth.createClientSession('cookie', member, future)
  await expect(store.transact(async () => {
    await store.users.disable(member, at)
    expect(await store.auth.getClientSession('cookie')).toBeUndefined()
    expect(index.reader.user(member)).toBeDefined()
    throw new Error('abort')
  })).rejects.toThrow('abort')
  expect(await store.users.get(member)).toBeDefined()
  expect(await store.auth.getClientSession('cookie')).toBeDefined()
  expect(await store.settingsAudit.list()).toEqual([])
  expect(index.reader.user(member)).toBeDefined()
})

it('refuses sign-in and old cookies until re-enabled, without resurrecting revoked cookies', async () => {
  const store = await setup()
  const member = firstAdminMemberId()
  await store.users.setPasswordHash(member, await hashPassword('secret'), at)
  const app = new Hono()
  registerAuthRoute(app, { store: store.auth, users: store.users })
  const login = () => app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret' }) })
  const before = await login()
  expect(before.status).toBe(200)
  const cookie = before.headers.get('set-cookie')!.split(';')[0]!
  expect(await requestUserId(store.auth, cookie)).toBe(member)
  await store.users.disable(member, at)
  expect((await login()).status).toBe(401)
  expect(await requestUserId(store.auth, cookie)).toBeUndefined()
  await store.users.enable(member, at)
  expect((await login()).status).toBe(200)
  expect(await requestUserId(store.auth, cookie)).toBeUndefined()
})

it('lets existing agent processes finish but refuses new agent launches while disabled', async () => {
  const store = await setup()
  await store.machines.upsertMachine({ id: store.hostMachineId, name: 'Host', hostname: 'test', tokenHash: 'token', ownerUserId: firstAdminMemberId(), assignment: { server: true, agentExecution: true } })
  await store.machines.setServiceAssignment(store.hostMachineId, { server: true, agentExecution: true })
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  try {
    const frames: { type: string }[] = []
    await reg.gateway.attachDaemon(store.hostMachineId, frame => frames.push(frame))
    const running = await reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/test' })
    const child = await reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/test', spawnedBy: `session:${running.sessionId}` })
    const before = await store.sessions.getSession(running.sessionId)
    const input = {
      sessionId: child.sessionId,
      sourceMessageId: null,
      principal: {
        kind: 'agent' as const,
        principalRef: running.sessionId,
        delegation: asDelegationRef(running.sessionId),
        attribution: {
          actor: actorAgent(agentIdentityFromSessionId(running.sessionId)),
          onBehalfOf: firstAdminMemberId(),
        },
      },
    }
    expect(await reg.modules.sessions.authorizeQueuedInputAtApply(input)).toEqual({ ok: true })
    frames.length = 0
    await store.users.disable(firstAdminMemberId(), at)
    expect(await store.sessions.getSession(running.sessionId)).toEqual(before)
    expect(frames.some(frame => frame.type === 'kill')).toBe(false)
    expect(await reg.modules.sessions.authorizeQueuedInputAtApply(input)).toMatchObject({ ok: false })
    await expect(reg.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/test' })).rejects.toThrow()
    expect(frames.some(frame => frame.type === 'spawn')).toBe(false)
    await store.users.enable(firstAdminMemberId(), at)
    expect(await reg.modules.sessions.authorizeQueuedInputAtApply(input)).toEqual({ ok: true })
  } finally { await reg.dispose() }
})
