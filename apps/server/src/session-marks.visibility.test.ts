/**
 * WHO RECEIVES A SESSION-MARKS ROW — the delivery half of PDM-424, against the
 * REAL `makeFeedVisibility` rather than a re-implementation of it.
 *
 * ---------------------------------------------------------------------------
 * THE BOUNDARY, AND WHY IT IS A CONJUNCTION
 * ---------------------------------------------------------------------------
 *
 * Three properties at once, and they are different changes pulling in opposite
 * directions:
 *
 *  1. USER-MATCH — the row reaches only the user named in its own key.
 *  2. AND SESSION-READ — the recipient must currently be able to see the session
 *     the row is ABOUT. A marks row's payload names a session id, so a member
 *     who opened a session and later lost access would keep learning that the
 *     session exists — from a row that is correctly and exclusively theirs.
 *     User-match answers "whose row is this". It does not answer "may they still
 *     see what it names".
 *  3. AND NOT GRANTABLE — the kind stays `per-user-state`, so no grant edge can
 *     widen it.
 *
 * The conjunction is NARROWER than either half. Falling through to `personal`
 * would be WIDER than both — it would route the row through the SESSION's
 * audience — which is why (3) is asserted separately rather than assumed.
 *
 * ---------------------------------------------------------------------------
 * WHY THE POSITIVES MATTER AS MUCH AS THE REFUSALS
 * ---------------------------------------------------------------------------
 *
 * A conjunction that refuses EVERYTHING passes every negative test in this file.
 * The prefetch is the way it would happen: if the session named inside the row
 * id were not prefetched, `maySeeSession` would deny every recipient for want of
 * a row rather than for want of a right, and the gate would look perfect while
 * delivering nothing. So every refusal below is paired with a positive on the
 * same fixture, and `the two complementary plants` at the foot of this file
 * assert that each half is load-bearing ON ITS OWN.
 *
 * Both PREPARED ARMS — `forBootstrap` and `forBatch` — are exercised, because
 * two arms that disagree is how one of them gets missed.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT PROVE
 * ---------------------------------------------------------------------------
 *
 * These cases call `forBootstrap` / `forBatch` and then `keyedUserOf` DIRECTLY.
 * That is the arm ANSWERING, not the feed SERVING: they do not go through
 * `GrantEdgeVisibilityPolicy.decide`, and they are not bootstrap or delta
 * delivery. A prepared hook can be perfectly correct and never consulted.
 * `session-marks.feed.test.ts` is the other half — a real `Authority` over this
 * same policy. Keep both: this file localises WHICH arm is wrong, that one
 * proves anything asks it at all.
 *
 * It also says nothing about WHAT the rows carry. That is
 * `modules/sessions/session-overlay.broadcast.test.ts`, at the producer.
 */

import { asUserId, sessionMarksRowId } from '@podium/model'
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
const LIVE = 'ses_live'
/** Resolves to nothing — the purged case. */
const GHOST = 'ses_long_gone'
/** Resolves, but carries a tombstone — the SOFT-deleted case, which is the one a
 *  person can actually cause. `getSessions` returns it. */
const DELETED = 'ses_soft_deleted'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

async function fixture() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const world = await WorldIndex.load(store)
  const session = { id: LIVE, ownerUserId: owner } as unknown as SessionRow
  const deletedSession = {
    id: DELETED,
    ownerUserId: owner,
    deletedAt: '2026-09-13T00:00:00.000Z',
  } as unknown as SessionRow
  const rows: FeedVisibilityStore = {
    issues: {
      getIssue: async () => null,
      getIssues: async () => new Map<string, IssueRow>(),
    },
    sessions: {
      // Only LIVE exists. An id the map does not answer for is the purged case,
      // and `getSessions` returning a partial map is exactly what the real store
      // does for an id that is gone.
      // LIVE and DELETED both resolve; DELETED carries a tombstone, exactly as
      // `readSessions` returns it (no `deleted_at` filter anywhere on that path).
      getSessions: async (ids: readonly string[]) =>
        new Map(
          ids.flatMap<[string, SessionRow]>((id) =>
            id === LIVE
              ? [[LIVE, session]]
              : id === DELETED
                ? [[DELETED, deletedSession]]
                : [],
          ),
        ),
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
  const grant = async (
    grantee: string,
    resourceId: string = LIVE,
    verb: GrantRow['verb'] = 'read',
  ) =>
    await store.transact(async () => {
      await store.grants.upsert({
        resourceKind: 'session',
        resourceId,
        grantee,
        verb,
        owner,
        visibility: 'private',
        createdAt: '2026-09-13T00:00:00Z',
        actorKind: 'user',
        actorId: owner,
        onBehalfOf: owner,
      })
    })
  const revoke = async (
    grantee: string,
    resourceId: string = LIVE,
    verb: GrantRow['verb'] = 'read',
  ) =>
    await store.transact(async () => {
      await store.grants.remove('session', resourceId, grantee, verb)
    })
  return { store, policy, grant, revoke }
}

const marksRef = (user: string, sessionId: string): EntityRef => ({
  entity: 'sessionMarks',
  entityId: sessionMarksRowId(asUserId(user), sessionId),
})

/**
 * WHO THE ARM ANSWERS for this row, through the REAL prepared port — both arms,
 * which must agree. NOT a delivery assertion; see the header.
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

    expect(policy.state.classOf('sessionMarks')).toBe('per-user-state')
    // `personal` is the class that consults grant edges. It is also WIDER than
    // the conjunction, not narrower — an unread mark that fell through to it
    // would become shareable AND would reach the session's whole audience.
    expect(policy.state.classOf('sessionMarks')).not.toBe('personal')
  })

  it('is not delivered through mayRead, which stays closed for this kind', async () => {
    const { policy, grant } = await fixture()
    await grant(reader)

    // Even for a reader who CAN see the session, `mayRead` must stay false: the
    // kernel does not consult it for this class, and if it ever started
    // answering true the row would be deliverable by a second door.
    for (const who of [owner, reader, stranger]) {
      expect.soft(await policy.state.mayRead(who, marksRef(reader, LIVE))).toBe(false)
    }
  })
})

describe('user-match: a row reaches the person named in its own key', () => {
  it('answers the owner for their own row, on both arms', async () => {
    const { policy } = await fixture()

    expect(await recipients(policy, marksRef(owner, LIVE))).toEqual({
      snapshot: owner,
      delta: owner,
    })
  })

  it('answers a GRANTEE for their own row — the positive that keeps the refusals honest', async () => {
    const { policy, grant } = await fixture()
    await grant(reader)

    // Without this, every refusal below is satisfied by a gate that delivers
    // nothing at all. A grantee is the discriminating positive: unlike the
    // owner, their admission comes from an edge the revocation case removes.
    expect(await recipients(policy, marksRef(reader, LIVE))).toEqual({
      snapshot: reader,
      delta: reader,
    })
  })

  it('refuses a row whose key names somebody who cannot see the session', async () => {
    const { policy } = await fixture()

    // The row is exclusively the stranger's, correctly keyed, and still refused:
    // user-match alone would have delivered it.
    expect(await recipients(policy, marksRef(stranger, LIVE))).toEqual({
      snapshot: null,
      delta: null,
    })
  })

  it('refuses a malformed row id rather than guessing whose it is', async () => {
    const { policy } = await fixture()

    // A best-effort split is a row delivered to whoever the garbage happened to
    // name, which is the defect this issue exists to close.
    expect(await recipients(policy, { entity: 'sessionMarks', entityId: 'no-separator' })).toEqual({
      snapshot: null,
      delta: null,
    })
  })
})

describe('session-read: the conjunction, and it is not user-match twice', () => {
  it('refuses a revoked grantee their OWN row, with the positive alongside it', async () => {
    const { policy, grant, revoke } = await fixture()
    await grant(reader)
    // PRECONDITION — the row WAS served while the grant stood. Without this the
    // refusal below is satisfied by a gate that never delivered it at all.
    expect((await recipients(policy, marksRef(reader, LIVE))).snapshot).toBe(reader)

    await revoke(reader)

    expect.soft(await recipients(policy, marksRef(reader, LIVE))).toEqual({
      snapshot: null,
      delta: null,
    })
    // AND THE OWNER IS UNAFFECTED. A revocation must narrow WHICH people, never
    // switch the gate off — this is the control that says the refusal above came
    // from the read conjunct and not from the arm breaking.
    expect.soft((await recipients(policy, marksRef(owner, LIVE))).snapshot).toBe(owner)
  })

  it('refuses a row naming a session that is GONE, even to a surviving grantee', async () => {
    const { policy, grant } = await fixture()
    // THE GRANT IS RETAINED, and WHICH CLAUSE REFUSES matters here. Deleting a
    // session does not delete its grant edges, so a previously admitted grantee
    // stays admitted by a surviving edge — `maySeeSession` returns TRUE for them
    // — and only the explicit still-exists condition refuses it.
    //
    // THE OWNER IS THE WEAK CASE and is kept as a control rather than as the
    // point: they are refused by the accident of which check fails first (their
    // branch reads a row that is gone), not by a property of the gate. MEASURED
    // by a plant that removes ONLY the still-exists line and keeps
    // `maySeeSession`: this test is the ONLY one that reddens, on the GRANTEE
    // assertion (`expected { snapshot: 'reader', … } to deeply equal
    // { snapshot: null, … }`), while the owner assertion below stays green. So
    // this negative is not one reason wide.
    await grant(reader, GHOST)

    expect.soft(await recipients(policy, marksRef(reader, GHOST))).toEqual({
      snapshot: null,
      delta: null,
    })
    expect.soft(await recipients(policy, marksRef(owner, GHOST))).toEqual({
      snapshot: null,
      delta: null,
    })
    // The live session is still served on the same fixture, so this is a refusal
    // about the GHOST and not about the policy having stopped answering.
    expect.soft((await recipients(policy, marksRef(owner, LIVE))).snapshot).toBe(owner)
  })

  it('ADMITS a row whose session is SOFT-DELETED — PDM-459: leave it', async () => {
    // A SOFT-DELETED SESSION STILL RESOLVES. `getSessions` applies no
    // `deleted_at` filter and `maySeeSession` checks asked-for, then owner, then
    // grants — never the tombstone. So a marks row for a session the client has
    // been told to DROP is still admitted to its owner and to a surviving
    // grantee.
    //
    // PDM-459 ENDORSED THIS. The previous text called it observed-not-endorsed
    // because client eviction and durable destruction are different, and an
    // evicted row can be re-delivered on restore. That distinction stands; the
    // decision is that we still ADMIT during the tombstone window, so a
    // reconnecting client is served the same marks a held client kept. Tightening
    // the gate to `deletedAt == null` would split those two answers. The PURGE
    // case (`GHOST`, the test above) is the one that must stay refused.
    const { policy, grant } = await fixture()
    await grant(reader, DELETED)

    expect.soft((await recipients(policy, marksRef(owner, DELETED))).snapshot).toBe(owner)
    expect.soft((await recipients(policy, marksRef(reader, DELETED))).snapshot).toBe(reader)
    // The stranger is still refused, so admission still tracks the person.
    expect.soft((await recipients(policy, marksRef(stranger, DELETED))).snapshot).toBeNull()
  })

  it('does not let a grant on ANOTHER session admit this row', async () => {
    const { policy, grant } = await fixture()
    await grant(stranger, GHOST)

    expect((await recipients(policy, marksRef(stranger, LIVE))).snapshot).toBeNull()
  })
})
