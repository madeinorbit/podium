/**
 * SESSION-MARKS ROWS ON THE REAL AUTHORITY FEED (PDM-424) — delivery, not the
 * hook.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS BESIDE `session-marks.visibility.test.ts`
 * ---------------------------------------------------------------------------
 *
 * That file calls `policy.state.forBootstrap(...)` / `forBatch(...)` and then
 * `keyedUserOf` directly. A prepared hook tested in isolation can be UNUSED by a
 * serving path: it establishes that the ARM answers correctly, never that
 * anything ASKS it.
 *
 * So this file drives a real `Authority` over the real `makeFeedVisibility`
 * policy and asserts on what a principal is actually SERVED:
 *
 *   - `authority.bootstrap(principal)` — the fresh-client path.
 *   - `authority.changesSince(cursor, principal)` — the delta path.
 *
 * Both run through `GrantEdgeVisibilityPolicy.decide`, which the unit file never
 * touches. A conjunction wired into an arm the serving path does not consult
 * would pass every assertion there and fail every assertion here.
 *
 * THE STUB IS THE CHANGE LOG, NOT THE POLICY, and the ANCHORS ARE REAL. PDM-408
 * shipped this file's twin with `DeviceGradeNoAnchors` in that slot, which meant
 * the retraction path could not fire at all and the test that was supposed to
 * prove it passed on a different route entirely. PDM-139 caught it. The same
 * mistake is available here — the eviction below is derived from the marks row's
 * OWN audience — so the real `policy.anchors` is wired and the plant at the foot
 * of the file is what shows it is load-bearing.
 */

import { asUserId, sessionMarksRowId, type UserId } from '@podium/model'
import { asCapabilityRef, asDeviceId, type Principal } from '@podium/protocol'
import { Authority, GrantEdgeVisibilityPolicy, NoDelegationsGranted } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFeedVisibility } from './feed-visibility'
import type { FeedVisibilityStore, IssueRow, SessionRow } from './hot-path-ports'
import { WorldIndex } from './modules/world-index'
import type { SessionStore } from './store'
import type { GrantRow } from './store/grants'
import { openTestStore } from './test-support/open-test-store'

const owner = asUserId('owner')
const reader = asUserId('reader')
const SHARED = 'ses_shared'
/** A second visible session the deletion must not touch. */
const KEPT = 'ses_kept'

type AuthorityStore = ConstructorParameters<typeof Authority>[0]['store']

const humanPrincipal = (userId: UserId): Principal => ({
  kind: 'user',
  user: userId,
  device: asDeviceId(`dev:${userId}`),
  capability: asCapabilityRef(`cap:${userId}`),
})

function memoryStore(): AuthorityStore {
  const rows: {
    seq: number
    entity: string
    entityId: string
    op: string
    payload: string | null
  }[] = []
  let nextSeq = 1
  return {
    async appendChanges(
      batch: ReadonlyArray<{
        entity: string
        entityId: string
        op: string
        payload: string | null
      }>,
    ) {
      const seqs: number[] = []
      for (const r of batch) {
        rows.push({ seq: nextSeq, ...r })
        seqs.push(nextSeq)
        nextSeq += 1
      }
      return seqs
    },
    maxChangeSeq: async () => nextSeq - 1,
    minChangeSeq: async () => rows[0]?.seq ?? null,
    changesSince: async (cursor: number) => rows.filter((r) => r.seq > cursor),
    planChangePrune: async () => ({ thresholdSeq: 0 }),
    pruneChangeBatch: async () => 0,
    latestChangeStates: async () => {
      const latest = new Map<string, (typeof rows)[number]>()
      for (const r of rows) latest.set(`${r.entity}/${r.entityId}`, r)
      return [...latest.values()]
    },
  } as AuthorityStore
}

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

async function build() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const world = await WorldIndex.load(store)
  const shared = { id: SHARED, ownerUserId: owner } as unknown as SessionRow
  const kept = { id: KEPT, ownerUserId: owner } as unknown as SessionRow
  /** Flipped by `deleteSession()` below: afterwards SHARED resolves to nothing,
   *  which is the state the retraction has to be delivered IN. KEPT is
   *  unaffected, so "the deletion took everything" cannot pass. */
  let sharedExists = true
  const rows: FeedVisibilityStore = {
    issues: {
      getIssue: async () => null,
      getIssues: async () => new Map<string, IssueRow>(),
    },
    sessions: {
      getSessions: async (ids: readonly string[]) =>
        new Map(
          ids.flatMap<[string, SessionRow]>((id) =>
            id === KEPT ? [[KEPT, kept]] : id === SHARED && sharedExists ? [[SHARED, shared]] : [],
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
  const authority = new Authority({
    store: memoryStore(),
    now: () => 1_000,
    transact: (fn) => fn(),
    visibility: new GrantEdgeVisibilityPolicy(policy.state, new NoDelegationsGranted()),
    // THE REAL ANCHORS — see this file's header for what a stub here costs.
    anchors: policy.anchors,
  })
  const grant = async (grantee: string, resourceId: string = SHARED) =>
    await store.transact(async () => {
      await store.grants.upsert({
        resourceKind: 'session',
        resourceId,
        grantee,
        verb: 'read' as GrantRow['verb'],
        owner,
        visibility: 'private',
        createdAt: '2026-09-13T00:00:00Z',
        actorKind: 'user',
        actorId: owner,
        onBehalfOf: owner,
      })
    })
  const revoke = async (grantee: string) =>
    await store.transact(async () => {
      await store.grants.remove('session', SHARED, grantee, 'read')
    })
  const publishMarks = async (user: UserId, readAt: string, sessionId: string = SHARED) =>
    await authority.capture([
      {
        entity: 'sessionMarks',
        entityId: sessionMarksRowId(user, sessionId),
        op: 'upsert',
        value: { userId: user, sessionId, readAt },
      },
    ])
  /**
   * A DELETION, in the order the repository does it: the session row is gone by
   * the time the tombstone is emitted. That ordering is the whole question — a
   * read gate that must fail closed cannot also carry the retraction.
   */
  const deleteSession = async (holders: readonly UserId[]) => {
    sharedExists = false
    await authority.capture([
      { entity: 'session', entityId: SHARED, op: 'remove' },
      ...holders.map((h) => ({
        entity: 'sessionMarks' as const,
        entityId: sessionMarksRowId(h, SHARED),
        op: 'remove' as const,
      })),
    ])
  }
  return { authority, grant, revoke, publishMarks, deleteSession }
}

/** The marks rows a FRESH CLIENT is served — the cold-bootstrap path. */
const bootstrapMarks = async (
  authority: Awaited<ReturnType<typeof build>>['authority'],
  user: UserId,
): Promise<string[]> =>
  (await authority.bootstrap(humanPrincipal(user))).changes
    .filter((c) => c.entity === 'sessionMarks')
    .map((c) => c.entityId)

describe('what a principal is actually SERVED', () => {
  it('serves the owner their own marks on a fresh bootstrap', async () => {
    // The positive, and the one that fails if the conjunction is wired into an
    // arm nothing consults — or if it denies for want of a prefetched row rather
    // than for want of a right.
    const { authority, publishMarks } = await build()
    await publishMarks(owner, 'T-owner')

    expect(await bootstrapMarks(authority, owner)).toEqual([sessionMarksRowId(owner, SHARED)])
  })

  it('serves a READ-GRANTEE their own marks, and never the owner’s', async () => {
    const { authority, grant, publishMarks } = await build()
    await grant(reader)
    await publishMarks(owner, 'T-owner')
    await publishMarks(reader, 'T-reader')

    // Each gets exactly their own row: the positive AND the cross-user negative
    // in one assertion, which is what "per-user" has to mean on a real feed.
    expect
      .soft(await bootstrapMarks(authority, reader))
      .toEqual([sessionMarksRowId(reader, SHARED)])
    expect.soft(await bootstrapMarks(authority, owner)).toEqual([sessionMarksRowId(owner, SHARED)])
  })

  it('STOPS serving a member their own row once their access is revoked', async () => {
    // THE REVOCATION CASE, on the serving path. Same user, same row, same key —
    // only the right changed, and no deletion has run. The row is still
    // correctly theirs; what it must no longer do is tell them the session
    // exists.
    const { authority, grant, revoke, publishMarks } = await build()
    await grant(reader)
    await publishMarks(reader, 'T-reader')
    expect(await bootstrapMarks(authority, reader)).toEqual([sessionMarksRowId(reader, SHARED)])

    await revoke(reader)

    expect.soft(await bootstrapMarks(authority, reader)).toEqual([])
    // The owner is untouched — the control that says the refusal came from the
    // revocation and not from the feed having stopped serving this kind.
    expect.soft(await bootstrapMarks(authority, owner)).toEqual([])
  })

  it('serves each person their own row on the DELTA path too, not only bootstrap', async () => {
    // Two arms that disagree is how one of them gets missed, and `forBatch` is
    // the one a running client actually uses.
    const { authority, grant, publishMarks } = await build()
    await grant(reader)
    const before = await authority.cursor()
    await publishMarks(owner, 'T-owner')
    await publishMarks(reader, 'T-reader')

    // ASSERT THE RESPONSE SHAPE BEFORE NARROWING TO IT. A bare
    // `if (res?.kind !== 'batch') return` would finish GREEN on a `reset`, an
    // `undefined`, or any unexpected shape, without ever reaching the assertion
    // below — a delivery test that passes because nothing was examined.
    // `batch` is the only legitimate outcome: the cursor was taken before two
    // appends, so there is a contiguous window and no reason to reset.
    const served = async (user: UserId) => {
      const res = await authority.changesSince(before, humanPrincipal(user))
      expect(res?.kind).toBe('batch')
      if (res?.kind !== 'batch') return null
      return res.changes.filter((c) => c.entity === 'sessionMarks').map((c) => c.entityId)
    }

    expect.soft(await served(reader)).toEqual([sessionMarksRowId(reader, SHARED)])
    expect.soft(await served(owner)).toEqual([sessionMarksRowId(owner, SHARED)])
  })
})

describe('a deleted session retracts the marks it carried', () => {
  it('delivers the OWNER their removal, though the read gate refuses the row', async () => {
    // THE CASE THE ANCHOR EXISTS FOR. The session row is gone before the
    // tombstone is emitted, so `keyedUserOf` — which sees a ref and cannot tell
    // a removal from an upsert — refuses it. Without the anchor the owner's
    // client keeps an unread dot for a session that no longer exists, forever.
    //
    // THE OWNER IS THE DISCRIMINATING CASE, not the grantee: a grant outlives
    // the session row, so a grantee's `remove` can still travel the ordinary
    // path. The owner's admission came from the row that was just deleted.
    const { authority, publishMarks, deleteSession } = await build()
    await publishMarks(owner, 'T-owner')
    await publishMarks(owner, 'T-kept', KEPT)
    const before = await authority.cursor()
    // PRECONDITION — the row WAS served while the session existed. Without it
    // "the removal arrives" is satisfied by a feed that never delivered the row.
    expect((await bootstrapMarks(authority, owner)).sort()).toEqual(
      [sessionMarksRowId(owner, KEPT), sessionMarksRowId(owner, SHARED)].sort(),
    )

    await deleteSession([owner])

    const res = await authority.changesSince(before, humanPrincipal(owner))
    // Shape first, for the reason the delta case above spells out.
    expect(res?.kind).toBe('batch')
    if (res?.kind !== 'batch') return
    const delta = res.changes.filter((c) => c.entity === 'sessionMarks')
    expect.soft(delta.map((c) => c.entityId)).toContain(sessionMarksRowId(owner, SHARED))
    expect.soft(delta.every((c) => c.op !== 'upsert')).toBe(true)
    // AND THE KEPT SESSION'S ROW IS UNDISTURBED. Without this, "everything was
    // retracted" passes — which is the failure a retraction mechanism invites.
    expect.soft(await bootstrapMarks(authority, owner)).toEqual([sessionMarksRowId(owner, KEPT)])
  })

  it('does not serve an ORDINARY upsert for a session that is gone', async () => {
    // The other half of the same boundary, and why the read gate is not relaxed
    // for the missing-session case: an escape there would admit ordinary upserts
    // and bootstrap rows exactly as readily as a retraction, and the boot
    // reconcile republishes pre-existing rows.
    const { authority, publishMarks, deleteSession } = await build()
    await publishMarks(owner, 'T-owner')
    await deleteSession([])

    // A stale upsert — exactly what a boot reconcile racing a deletion produces.
    await publishMarks(owner, 'T-stale')

    expect(await bootstrapMarks(authority, owner)).toEqual([])
  })
})
