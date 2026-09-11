import { asIssueId, asSessionId, asUserId } from '@podium/model'
import type { EntityRef } from '@podium/sync'
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
