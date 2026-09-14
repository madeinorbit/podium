import { asMachineId, asSessionId, asUserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import { openTestStore } from '../../test-support/open-test-store'
import type { MemoryReader } from './types'
import { MemoryVisibilityPolicy, type MemoryDocumentRef } from './visibility'

const alice = asUserId('mem_visibility_alice')
const bob = asUserId('mem_visibility_bob')
const machineId = asMachineId('visibility-machine')
const at = '2026-09-14T00:00:00.000Z'
const human = (id: typeof alice): MemoryReader => ({ kind: 'user', id })

// Exercise the shared policy and its request-local indexes independently. Both
// members are durable users, distinct from the migrated administrator. No policy
// or store method is mocked; every decision below enters the public policy API.
describe.each(['live', 'request'] as const)('MemoryVisibilityPolicy (%s)', (mode) => {
  let registry: SessionRegistry
  let policy: MemoryVisibilityPolicy
  let issue: Extract<MemoryDocumentRef, { class: 'issue' }>
  let session: Extract<MemoryDocumentRef, { class: 'session' }>
  let store: Awaited<ReturnType<typeof openTestStore>>

  beforeEach(async () => {
    store = await openTestStore(':memory:')
    for (const id of [alice, bob]) {
      await store.users.create({ id, displayName: id, role: 'member', createdAt: at, disabledAt: null }, 'scrypt:test')
    }
    const users = await store.users.list()
    for (const id of [alice, bob]) {
      expect(users.find((user) => user.id === id)?.role).toBe('member')
      expect((await store.users.earliestAdmin())?.id).not.toBe(id)
    }
    registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registry.gateway.attachDaemon(machineId, () => {})
    const task = await registry.issues.create({ repoPath: '/visibility', title: 'Alice task', startNow: false, ownerUserId: alice })
    issue = { class: 'issue', id: task.id }
    const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/visibility', issueId: task.id, ownerUserId: bob })
    session = { class: 'session', id: sessionId }
    await store.conversations.registry.linkSegment({ machineId, newNativeId: 'current', priorNativeId: 'older', providerId: 'claude-code-jsonl' })
    await registry.gateway.routeDaemonFrame(machineId, { type: 'sessionResumeRef', sessionId, resume: { kind: 'claude-session', value: 'current' } })
    policy = new MemoryVisibilityPolicy(store)
    if (mode === 'request') policy = await policy.forRequest(await store.sessions.loadSessions(), { batchIssueOwners: true })
  })

  afterEach(async () => { await registry?.dispose() })

  const grant = async (resourceKind: string, resourceId: string, verb: 'read' | 'write' | 'manage' | 'use', grantee = bob) => {
    const owner = resourceKind === 'issue'
      ? (await store.issues.getIssue(resourceId))?.ownerUserId ?? alice
      : (await store.sessions.getSession(asSessionId(resourceId)))?.ownerUserId ?? alice
    await store.grants.upsert({ resourceKind, resourceId, verb, grantee, owner, visibility: 'personal', createdAt: at, actorKind: 'user', actorId: owner, onBehalfOf: owner })
    // Grants are request-local facts. A subsequent read request must see the
    // new edges, including the batchIssueOwners path.
    policy = new MemoryVisibilityPolicy(store)
    if (mode === 'request') policy = await policy.forRequest(await store.sessions.loadSessions(), { batchIssueOwners: true })
  }

  it('admits the issue owner', async () => {
    expect(await policy.mayRead(human(alice), issue)).toBe(true)
  })
  it('refuses an issue stranger without a grant', async () => {
    expect(await policy.mayRead(human(bob), issue)).toBe(false)
  })
  it.each(['read', 'write', 'manage'] as const)('admits an issue %s grantee', async (verb) => {
    await grant('issue', issue.id, verb)
    expect(await policy.mayRead(human(bob), issue)).toBe(true)
  })
  it('refuses an issue use-only grantee', async () => {
    await grant('issue', issue.id, 'use')
    expect(await policy.mayRead(human(bob), issue)).toBe(false)
  })
  it('refuses a missing issue despite a retained read grant', async () => {
    await grant('issue', 'missing', 'read')
    expect(await policy.mayRead(human(bob), { class: 'issue', id: 'missing' })).toBe(false)
  })
  it('admits the durable session owner on another members task', async () => {
    expect(await policy.mayRead(human(bob), session)).toBe(true)
  })
  it('refuses the attached task owner the private session', async () => {
    expect(await policy.mayRead(human(alice), session)).toBe(false)
  })
  it('refuses a task grantee the private session', async () => {
    const task = await store.issues.getIssue(issue.id)
    if (!task) throw new Error('missing seeded issue')
    await store.issues.upsertIssue({ ...task, ownerUserId: bob })
    await grant('issue', issue.id, 'read', alice)
    expect(await policy.mayRead(human(alice), session)).toBe(false)
  })
  it('refuses a legacy session grantee', async () => {
    await grant('session', session.id, 'read', alice)
    expect(await policy.mayRead(human(alice), session)).toBe(false)
  })
  it('refuses a missing session', async () => {
    expect(await policy.mayRead(human(bob), { class: 'session', id: 'missing' })).toBe(false)
  })
  it('admits the owner through mayReadSession', async () => {
    expect(await policy.mayReadSession(human(bob), asSessionId(session.id))).toBe(true)
  })
  it('refuses the stranger through mayReadSession', async () => {
    expect(await policy.mayReadSession(human(alice), asSessionId(session.id))).toBe(false)
  })

  describe.each(['conversation', 'transcript'] as const)('%s resolution', (cls) => {
    it('admits the owner through a sibling segment with no direct session match', async () => {
      expect((await store.sessions.loadSessions()).some((row) => row.resumeValue === 'older' || row.conversationId === 'older')).toBe(false)
      expect(await policy.mayRead(human(bob), { class: cls, machineId, nativeId: 'older' })).toBe(true)
    })
    it('refuses the other member through that same sibling', async () => {
      expect(await policy.mayRead(human(alice), { class: cls, machineId, nativeId: 'older' })).toBe(false)
    })
    it('refuses a native id on a different machine', async () => {
      expect(await policy.mayRead(human(bob), { class: cls, machineId: asMachineId('other-machine'), nativeId: 'current' })).toBe(false)
    })
    it('refuses an unrelated registered segment despite an owned session elsewhere', async () => {
      await store.conversations.registry.ensure({ machineId, nativeId: 'unrelated', providerId: 'claude-code-jsonl' })
      expect(await policy.mayRead(human(bob), { class: cls, machineId, nativeId: 'unrelated' })).toBe(false)
    })
    it('admits a direct native identity absent from the registry', async () => {
      const row = await store.sessions.getSession(asSessionId(session.id))
      if (!row) throw new Error('missing seeded session')
      await store.sessions.upsertSession({ ...row, resumeValue: 'unregistered' })
      policy = new MemoryVisibilityPolicy(store)
      if (mode === 'request') policy = await policy.forRequest(await store.sessions.loadSessions())
      expect(await store.conversations.registry.siblingSegments(machineId, 'unregistered')).toEqual([])
      expect(await policy.mayRead(human(bob), { class: cls, machineId, nativeId: 'unregistered' })).toBe(true)
    })
  })

  it('admits a superagent thread owner', async () => {
    expect(await policy.mayRead(human(bob), { class: 'superagent-thread', id: 'thread', ownerUserId: bob })).toBe(true)
  })
  it('refuses another members superagent thread', async () => {
    expect(await policy.mayRead(human(alice), { class: 'superagent-thread', id: 'thread', ownerUserId: bob })).toBe(false)
  })
  it('uses the agents represented human for admission', async () => {
    expect(await policy.mayRead({ kind: 'agent', id: alice, onBehalfOf: bob }, session)).toBe(true)
  })
  it('uses the agents represented human for refusal', async () => {
    expect(await policy.mayRead({ kind: 'agent', id: bob, onBehalfOf: alice }, session)).toBe(false)
  })
  it('admits settings as deployment substrate without consulting user identity', async () => {
    expect(policy.classOf('setting')).toBe('deployment-substrate')
    const reader: MemoryReader = { kind: 'user', get id(): typeof alice { throw new Error('substrate consulted identity') } }
    expect(await policy.mayRead(reader, { class: 'setting', id: 'anything' })).toBe(true)
  })
  it('admits a system read of a known class without resolving a row', async () => {
    expect(await policy.mayRead({ kind: 'system', id: 'indexer' }, { class: 'session', id: 'missing' })).toBe(true)
  })
  it('admits a system read through mayReadSession without resolving a row', async () => {
    expect(await policy.mayReadSession({ kind: 'system', id: 'indexer' }, asSessionId('missing'))).toBe(true)
  })
  it.each(['user', 'system'] as const)('refuses unknown classes for a %s reader', async (kind) => {
    expect(await policy.mayRead(kind === 'user' ? human(bob) : { kind, id: 'indexer' }, { class: 'unknown' })).toBe(false)
  })
})
