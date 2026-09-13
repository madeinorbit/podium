/**
 * WHO RECEIVES A MARKS ROW — the delivery half of PDM-408, against the REAL
 * `makeFeedVisibility` rather than a re-implementation of it.
 *
 * ---------------------------------------------------------------------------
 * THE BOUNDARY, AND WHY IT IS A CONJUNCTION
 * ---------------------------------------------------------------------------
 *
 * Three properties at once, and they are different changes pulling in opposite
 * directions:
 *
 *  1. USER-MATCH — the row reaches only the user named in its own key.
 *  2. AND ISSUE-READ — the recipient must currently be able to read the issue
 *     the row is ABOUT.
 *  3. AND NOT GRANTABLE — the kind stays `per-user-state`, so no grant edge can
 *     widen it.
 *
 * (2) is the one an earlier revision of this file did not have, and the one
 * PDM-139 held the review on. A marks row's PAYLOAD IS AN ISSUE ID, so a member
 * who marked an issue and later lost access would keep learning that the issue
 * exists — from a row that is correctly and exclusively theirs. User-match
 * answers "whose row is this". It does not answer "may they still see what it
 * names", and my earlier witness proved only the first while reading as though
 * it answered both.
 *
 * The conjunction is NARROWER than either half. Falling through to `personal`
 * would be WIDER than both — it would route the row through the issue's
 * audience — which is why (3) is asserted separately rather than assumed.
 *
 * ---------------------------------------------------------------------------
 * WHY THE POSITIVES MATTER AS MUCH AS THE REFUSALS
 * ---------------------------------------------------------------------------
 *
 * A conjunction that refuses EVERYTHING passes every negative test in this file.
 * The prefetch is the way it would happen: if the issue named inside the row id
 * were not prefetched, `mayReadIssueFromSnapshot` would deny every recipient for
 * want of a row rather than for want of a right, and the gate would look
 * perfect while delivering nothing. So every refusal below is paired with a
 * positive on the same fixture.
 *
 * Both the SNAPSHOT path (`forBootstrap`) and the DELTA path (`forBatch`) are
 * exercised, because two arms that disagree is how one of them gets missed.
 */

import { asIssueId, asUserId, issueMarksRowId } from '@podium/model'
import type { EntityRef } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFeedVisibility } from './feed-visibility'
import type { FeedVisibilityStore, IssueRow, SessionRow } from './hot-path-ports'
import { WorldIndex } from './modules/world-index'
import type { SessionStore } from './store'
import type { GrantRow } from './store/grants'
import { openTestStore } from './test-support/open-test-store'

const owner = asUserId('owner')
const reader = asUserId('reader')
const stranger = asUserId('stranger')
const SHARED = asIssueId('shared')
const GHOST = asIssueId('iss_long_gone')

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

async function fixture() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const world = await WorldIndex.load(store)
  const issue = { id: SHARED, ownerUserId: owner } as IssueRow
  const session = { id: 'shared', ownerUserId: owner } as unknown as SessionRow
  const rows: FeedVisibilityStore = {
    issues: {
      // Only SHARED exists. GHOST resolves to nothing, which is the
      // deleted/purged case.
      getIssue: async (id: string) => (id === SHARED ? issue : null),
      getIssues: async () => new Map([[issue.id, issue]]),
    },
    sessions: {
      getSessions: async () => new Map([['shared', session]]),
      findSessionsByResumeValues: async () => new Map(),
      findSessionsByIssueIds: async () => [],
    },
    shipping: { issueIdsForOrders: async () => new Map() },
    automations: { ownerOf: async () => undefined, runOwnerOf: async () => undefined },
    sync: store.sync,
  }
  const policy = makeFeedVisibility({
    store: rows,
    worldIndex: world.reader,
    audienceResourceIds: (kind) => store.grants.visibilityAudienceResourceIds(kind),
    audienceFor: (kind, id) => store.grants.visibilityAudienceFor(kind, id),
    authorizationRevision: () => store.grants.visibilityRevision(),
  })
  const grant = async (grantee: string, verb: GrantRow['verb'] = 'read') =>
    await store.transact(async () => {
      await store.grants.upsert({
        resourceKind: 'issue',
        resourceId: SHARED,
        grantee,
        verb,
        owner,
        visibility: 'personal',
        createdAt: '2026-09-13T00:00:00Z',
        actorKind: 'user',
        actorId: owner,
        onBehalfOf: owner,
      })
    })
  const revoke = async (grantee: string, verb: GrantRow['verb'] = 'read') =>
    await store.transact(async () => {
      await store.grants.remove('issue', SHARED, grantee, verb)
    })
  return { store, policy, grant, revoke }
}

const marksRef = (user: string, issueId: string): EntityRef => ({
  entity: 'issueMarks',
  entityId: issueMarksRowId(asUserId(user), issueId),
})

/**
 * WHO THE POLICY WOULD DELIVER THIS ROW TO, through the REAL prepared port —
 * the snapshot arm and the delta arm, which must agree.
 */
const recipients = async (
  policy: Awaited<ReturnType<typeof fixture>>['policy'],
  ref: EntityRef,
): Promise<{ snapshot: string | null; delta: string | null }> => {
  const forBootstrap = policy.state.forBootstrap
  const forBatch = policy.state.forBatch
  if (forBootstrap === undefined || forBatch === undefined) {
    throw new Error('fixture: the real policy must expose both prepared arms')
  }
  return {
    snapshot: (await forBootstrap([ref])).keyedUserOf(ref),
    delta: (await forBatch([ref])).keyedUserOf(ref),
  }
}

describe('the kind stays non-grantable', () => {
  it('is classified per-user-state, not personal', async () => {
    const { policy } = await fixture()

    expect(policy.state.classOf('issueMarks')).toBe('per-user-state')
    // `personal` is what every issue-shaped kind beside it returns, and it is
    // the class that consults grant edges. It is also WIDER than the
    // conjunction, not narrower — a pin that fell through to it would become
    // shareable AND would reach the issue's whole audience.
    expect(policy.state.classOf('issueMarks')).not.toBe('personal')
  })

  it('is not delivered through mayRead, which stays closed for this kind', async () => {
    const { policy, grant } = await fixture()
    await grant(reader)

    // Even for a reader who CAN read the issue, `mayRead` must stay false: the
    // kernel does not consult it for this class, and if it ever started
    // answering true the row would be deliverable by a second door.
    for (const who of [owner, reader, stranger]) {
      expect(await policy.state.mayRead(who, marksRef(reader, SHARED))).toBe(false)
    }
  })
})

describe('user-match AND issue-read', () => {
  it("delivers the OWNER's own marks on their own issue — the positive", async () => {
    const { policy } = await fixture()

    expect(await recipients(policy, marksRef(owner, SHARED))).toEqual({
      snapshot: owner,
      delta: owner,
    })
  })

  it('delivers a READ-GRANTEE’s marks on an issue they may read — the non-owner positive', async () => {
    // Without this, every refusal below is satisfied by a gate that is
    // vacuously closed — which is precisely what a missing prefetch would do.
    const { policy, grant } = await fixture()
    await grant(reader)

    expect(await recipients(policy, marksRef(reader, SHARED))).toEqual({
      snapshot: reader,
      delta: reader,
    })
  })

  it('REFUSES the same member’s own row once their access is revoked', async () => {
    // THE CASE THE EARLIER REVISION MISSED. Same user, same row, same key — only
    // the right changed. User-match alone answers `reader` here, which is how a
    // member keeps learning that an issue they can no longer read still exists.
    const { policy, grant, revoke } = await fixture()
    await grant(reader)
    expect((await recipients(policy, marksRef(reader, SHARED))).snapshot).toBe(reader)

    await revoke(reader)

    expect(await recipients(policy, marksRef(reader, SHARED))).toEqual({
      snapshot: null,
      delta: null,
    })
  })

  it('refuses a member who never had access', async () => {
    const { policy } = await fixture()

    expect(await recipients(policy, marksRef(stranger, SHARED))).toEqual({
      snapshot: null,
      delta: null,
    })
  })

  it('refuses a row whose issue is gone', async () => {
    // Deleted or purged. The row is still correctly the owner's, and it still
    // names an issue id — which is the thing that must not be disclosed once
    // the issue is unreadable. Cleanup retracts these; this gate is what holds
    // until it does, and the two are not substitutes.
    const { policy } = await fixture()

    expect(await recipients(policy, marksRef(owner, GHOST))).toEqual({
      snapshot: null,
      delta: null,
    })
  })

  it('refuses a malformed row id rather than guessing a recipient', async () => {
    const { policy } = await fixture()
    const ref: EntityRef = { entity: 'issueMarks', entityId: 'no-separator' }

    expect(await recipients(policy, ref)).toEqual({ snapshot: null, delta: null })
  })

  it('still keys to the ROW’s user and never to the issue’s owner', async () => {
    // The original witness, kept: with `reader` granted, a rule that had become
    // owner-matching answers `owner` here. The conjunction narrows WHO may
    // receive; it must not change WHOSE row it is.
    const { policy, grant } = await fixture()
    await grant(reader)

    const got = await recipients(policy, marksRef(reader, SHARED))
    expect(got.snapshot).toBe(reader)
    expect(got.snapshot).not.toBe(owner)
  })

  it('gives two different non-admin members their own rows, not each other’s', async () => {
    // Neither is the earliest admin, which is the pairing that can tell
    // "per-user" from "falls back to the admin".
    const { policy, grant } = await fixture()
    const ben = 'mem_ben'
    const cleo = 'mem_cleo'
    await grant(ben)
    await grant(cleo)

    expect((await recipients(policy, marksRef(ben, SHARED))).snapshot).toBe(ben)
    expect((await recipients(policy, marksRef(cleo, SHARED))).snapshot).toBe(cleo)
  })
})
