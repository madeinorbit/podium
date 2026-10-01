import {
  asIssueId,
  asSessionId,
  asUserId,
  interactionRowId,
  issueUserStateRowId,
  messageRecordRowId,
} from '@podium/model'
import { asCapabilityRef, asDeviceId, type Principal } from '@podium/protocol'
import {
  Authority,
  type EntityRef,
  GrantEdgeVisibilityPolicy,
  NoDelegationsGranted,
} from '@podium/sync'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { makeFeedVisibility } from './feed-visibility'
import type { FeedVisibilityStore, IssueRow, SessionRow } from './hot-path-ports'
import { WorldIndex } from './modules/world-index'
import type { SessionStore } from './store'
import type { GrantRow } from './store/grants'
import { openTestStore } from './test-support/open-test-store'

const owner = asUserId('owner')
const reader = asUserId('reader')
const stranger = asUserId('stranger')
const revoked = asUserId('revoked')
const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

async function fixture() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const world = await WorldIndex.load(store)
  const issue = { id: asIssueId('shared'), ownerUserId: owner } as IssueRow
  const session = { id: asSessionId('shared'), ownerUserId: owner, resumeValue: 'conversation' } as SessionRow
  const rows: FeedVisibilityStore = {
    issues: {
      getIssue: async () => issue,
      getIssues: async () => new Map([[issue.id, issue]]),
    },
    sessions: {
      getSessions: async () => new Map([[session.id, session]]),
      findSessionsByResumeValues: async () => new Map([['conversation', session]]),
      findSessionsByIssueIds: async () => [],
    },
    shipping: { issueIdsForOrders: async () => new Map() },
    automations: { ownerOf: async () => undefined, runOwnerOf: async () => undefined },
    sync: store.sync,
  }
  const policy = makeFeedVisibility({
    store: rows, worldIndex: world.reader,
    audienceResourceIds: (kind) => store.grants.visibilityAudienceResourceIds(kind),
    audienceFor: (kind, id) => store.grants.visibilityAudienceFor(kind, id),
    authorizationRevision: () => store.grants.visibilityRevision(),
  })
  const grant = async (kind: string, grantee: string, verb: GrantRow['verb']) =>
    store.grants.upsert({
      resourceKind: kind, resourceId: 'shared', grantee, verb, owner,
      visibility: 'personal', createdAt: '2026-09-11T00:00:00Z',
      actorKind: 'user', actorId: owner, onBehalfOf: owner,
    })
  return { store, world, policy, grant }
}
const refs: EntityRef[] = [
  { entity: 'issue', entityId: 'shared' },
  { entity: 'session', entityId: 'shared' },
  { entity: 'conversation', entityId: 'conversation' },
]

describe('feed visibility grant semantics', () => {
  it('keeps issue user-state private in bootstrap and delta even when the issue is shared', async () => {
    const { store, policy, grant } = await fixture()
    await grant('issue', reader, 'read')
    const authority = new Authority({
      store: store.sync,
      now: () => 1_000,
      transact: async (fn) => await store.transact(fn),
      visibility: new GrantEdgeVisibilityPolicy(policy.state, new NoDelegationsGranted()),
      anchors: policy.anchors,
    })
    const principal = (user: typeof owner): Principal => ({
      kind: 'user',
      user,
      device: asDeviceId(`device:${user}`),
      capability: asCapabilityRef(`cap:${user}`),
    })
    const id = asIssueId('shared')
    const cursor = await authority.cursor()
    await authority.capture(
      [owner, reader].map((userId) => ({
        entity: 'issueUserState',
        entityId: issueUserStateRowId(userId, id),
        op: 'upsert' as const,
        value: {
          userId,
          entityId: id,
          readAt: userId === owner ? 'owner-read' : null,
          tuckedAt: null,
          pinned: userId === owner,
        },
      })),
    )
    for (const user of [owner, reader]) {
      const bootstrap = await authority.bootstrap(principal(user))
      expect(
        bootstrap.changes.filter((c) => c.entity === 'issueUserState').map((c) => c.entityId),
      ).toEqual([issueUserStateRowId(user, id)])
      const delta = await authority.changesSince(cursor, principal(user))
      expect(delta?.kind).toBe('batch')
      if (delta?.kind !== 'batch') throw new Error('expected delta')
      expect(
        delta.changes.filter((c) => c.entity === 'issueUserState').map((c) => c.entityId),
      ).toEqual([issueUserStateRowId(user, id)])
    }
    expect((await authority.bootstrap(principal(stranger))).changes).toEqual([])
    expect(policy.state.keyedUserOf({ entity: 'issueUserState', entityId: 'malformed' })).toBeNull()
  })

  it('git observations share the issue audience and ride its grant/revoke subjects', async () => {
    const { policy, grant } = await fixture()
    const git = { entity: 'issueGitState', entityId: 'shared' }
    await grant('issue', reader, 'read')
    const state = await policy.state.forBootstrap!([git])
    expect(state.classOf(git.entity)).toBe('personal')
    expect(state.mayRead(owner, git)).toBe(true)
    expect(state.mayRead(reader, git)).toBe(true)
    expect(state.mayRead(stranger, git)).toBe(false)
    expect(
      (await policy.anchors.visibilityEdge({ entity: 'issue', entityId: 'shared' }))?.subjects,
    ).toContainEqual(git)
  })
  it('cannot access grant persistence through its store port', () => {
    expectTypeOf<FeedVisibilityStore>().not.toHaveProperty('grants')
  })

  it('observes committed writes and revocations but not rolled-back grants', async () => {
    const { store, policy, grant } = await fixture()
    await store.transact(async () => { await grant('issue', reader, 'read') })
    expect(await policy.mayReadIssue(reader, asIssueId('shared'))).toBe(true)
    await expect(store.transact(async () => {
      await store.grants.remove('issue', 'shared', reader, 'read')
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    expect(await policy.mayReadIssue(reader, asIssueId('shared'))).toBe(true)
    await store.transact(async () => {
      await store.grants.remove('issue', 'shared', reader, 'read')
    })
    expect(await policy.mayReadIssue(reader, asIssueId('shared'))).toBe(false)
  })

  it.each(['read', 'write', 'manage'] as const)('preserves owner, grantee, stranger and revoked %s edges across kinds', async (verb) => {
    const { store, policy, grant } = await fixture()
    await grant('issue', reader, verb)
    await grant('session', reader, verb)
    await grant('issue', revoked, 'read')
    await grant('session', revoked, 'read')
    const revision = await policy.authorizationRevision()
    await store.grants.remove('issue', 'shared', revoked, 'read')
    await store.grants.remove('session', 'shared', revoked, 'read')
    expect(await policy.authorizationRevision()).toBeGreaterThan(revision)
    for (const prepare of [policy.state.forBootstrap!, policy.state.forBatch!]) {
      const state = await prepare(refs)
      for (const ref of refs) {
        expect(state.mayRead(owner, ref)).toBe(true)
        expect(state.mayRead(reader, ref)).toBe(ref.entity === 'issue' || verb === 'read')
        expect(state.mayRead(stranger, ref)).toBe(false)
        expect(state.mayRead(revoked, ref)).toBe(false)
      }
    }
    expect(await policy.mayReadIssue(reader, asIssueId('shared'))).toBe(true)
    expect(await policy.mayReadIssue(revoked, asIssueId('shared'))).toBe(false)
    // Revoked readers remain in the historical audience so they receive removals.
    expect((await policy.anchors.visibilityEdge(refs[0]!))?.audience).toEqual([reader, revoked])
  })

  it('does not treat an issue or conversation grant as a session grant', async () => {
    const { policy, grant } = await fixture()
    await grant('issue', reader, 'read')
    await grant('conversation', reader, 'read')
    const state = await policy.state.forBatch!(refs)
    expect(refs.map((ref) => state.mayRead(reader, ref))).toEqual([true, false, false])
  })
})

describe('rows scoped by the session named in their id', () => {
  const ask: EntityRef = { entity: 'pendingInteraction', entityId: interactionRowId('shared', 'ixn_1') }
  const sent = (senderUserId: string): EntityRef => ({
    entity: 'message',
    entityId: messageRecordRowId({ sessionId: 'shared', senderUserId, messageId: 'msg_1' }),
  })

  it('shows a blocking ask to whoever may see its session (POD-4764 found the prefetch missing)', async () => {
    const { policy, grant } = await fixture()
    await grant('session', reader, 'read')
    for (const prepare of [policy.state.forBootstrap!, policy.state.forBatch!]) {
      const state = await prepare([ask])
      expect([owner, reader, stranger].map((user) => state.mayRead(user, ask))).toEqual([
        true,
        true,
        false,
      ])
    }
  })

  it('shows a chat message to its sender and the session owner, and to no other reader', async () => {
    const { policy, grant } = await fixture()
    await grant('session', reader, 'read')
    for (const prepare of [policy.state.forBootstrap!, policy.state.forBatch!]) {
      const fromStranger = sent(stranger)
      const state = await prepare([fromStranger])
      expect(policy.state.classOf('message')).toBe('personal')
      expect([owner, reader, stranger].map((user) => state.mayRead(user, fromStranger))).toEqual([
        true,
        false,
        true,
      ])
    }
  })

  it('refuses a message row whose id does not parse', async () => {
    const { policy } = await fixture()
    const broken: EntityRef = { entity: 'message', entityId: 'not-a-row-id' }
    const state = await policy.state.forBatch!([broken])
    expect(state.mayRead(owner, broken)).toBe(false)
  })
})
