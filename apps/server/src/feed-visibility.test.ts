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

/** This block's OWN ref list. Deliberately not an entry appended to the shared
 *  `refs` above: two tests there map over it POSITIONALLY and assert a
 *  three-element result, so widening it would redden them for a reason that has
 *  nothing to do with what they check. */
const executionRefs: EntityRef[] = [
  { entity: 'issue', entityId: 'shared' },
  { entity: 'issueExecution', entityId: 'shared' },
]

describe("the issue's private execution half is owner-scoped [B4, PDM-136]", () => {
  /**
   * THE PROPERTY, AND WHY IT NEEDS A COUNTERFACTUAL RATHER THAN A POSITIVE.
   *
   * `issueExecution` carries `worktreePath`, `machineId`, `coordinatorSessionId`
   * and `startedBySession`. It used to ride the `issue`/`issueProjection`
   * payloads, whose predicate is owner-OR-GRANT and which C4 (PDM-144) replaces
   * with the active-member class policy. The whole value of the split is that
   * this kind does NOT move when that predicate does — so the load-bearing
   * assertion is the one about a person who may read the issue and may not read
   * its private half. A test that only checked the owner would pass just as
   * happily against an arm that called `mayReadIssueFromSnapshot`, which is the
   * exact defect the split exists to prevent (catalogue shape 4: a guard that
   * cannot fail for the reason it exists).
   *
   * Both directions are asserted against ONE fixture and with `expect.soft`, so
   * a failure reports which half broke rather than stopping at the first
   * (catalogue: "hard assert hides the negative half").
   */
  it('admits the owner and refuses a read-grantee of the very same issue', async () => {
    const { store, policy, grant } = await fixture()
    await store.transact(async () => {
      await grant('issue', reader, 'read')
    })
    const state = await policy.state.forBootstrap!(executionRefs)

    const sharedIssue = { entity: 'issue', entityId: 'shared' } as const
    const privateHalf = { entity: 'issueExecution', entityId: 'shared' } as const

    // THE POSITIVE HALF: the grant works, and it works on the shared row. If
    // this went false the negative below would be vacuous — a grantee refused
    // the private half of a task they cannot read either proves nothing.
    expect.soft(state.mayRead(reader, sharedIssue)).toBe(true)
    // THE NEGATIVE HALF, and the point of the issue: the SAME grant, the SAME
    // person, the SAME issue id — and the private half is refused.
    expect.soft(state.mayRead(reader, privateHalf)).toBe(false)

    // The owner keeps both. Absence would be its own regression: the owner's
    // client reads `worktreePath` to key its workspace tabs.
    expect.soft(state.mayRead(owner, sharedIssue)).toBe(true)
    expect.soft(state.mayRead(owner, privateHalf)).toBe(true)

    // And a stranger gets neither, which pins that the refusal above is the
    // owner check answering and not a ref that fell off the prefetch.
    expect.soft(state.mayRead(stranger, sharedIssue)).toBe(false)
    expect.soft(state.mayRead(stranger, privateHalf)).toBe(false)
  })

  it('is not opened by a write or manage grant either', async () => {
    // `issueGrantAdmits` accepts read, write AND manage for the shared row. The
    // private half must refuse all three, or the split leaks through whichever
    // verb nobody tested — the same shape as a census that stops at one caller.
    const { store, policy, grant } = await fixture()
    await store.transact(async () => {
      await grant('issue', reader, 'write')
      await grant('issue', revoked, 'manage')
    })
    const state = await policy.state.forBootstrap!(executionRefs)
    const privateHalf = { entity: 'issueExecution', entityId: 'shared' } as const

    expect.soft(state.mayRead(reader, { entity: 'issue', entityId: 'shared' })).toBe(true)
    expect.soft(state.mayRead(revoked, { entity: 'issue', entityId: 'shared' })).toBe(true)
    expect.soft(state.mayRead(reader, privateHalf)).toBe(false)
    expect.soft(state.mayRead(revoked, privateHalf)).toBe(false)
  })

  it('is classified so the kernel scopes it at all', async () => {
    // `classOf` returning null would take the kind OUT of the scoped decision
    // entirely, and a row nothing classifies is not a row nothing delivers.
    // Pinned beside the arm above because a class change is silent here.
    const { policy } = await fixture()
    expect(policy.state.classOf('issueExecution')).toBe('personal')
  })

  it('rides the issue anchor, so ownership changes move it [D14.3]', async () => {
    // The sidecar must be a SUBJECT of the issue's visibility edge. Without it,
    // a change that moves who owns an issue moves the shared half and leaves the
    // private half sitting in the old owner's replica with nothing to evict it.
    const { store, policy, grant } = await fixture()
    await store.transact(async () => {
      await grant('issue', reader, 'read')
    })
    const edge = await policy.anchors.visibilityEdge({ entity: 'issue', entityId: 'shared' })
    expect(edge).not.toBeNull()
    expect(edge?.subjects).toContainEqual({ entity: 'issueExecution', entityId: 'shared' })
  })
})
