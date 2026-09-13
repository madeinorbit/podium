/**
 * MARKS ROWS ON THE REAL AUTHORITY FEED (PDM-408) — delivery, not the hook.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS BESIDE `issue-marks.visibility.test.ts`
 * ---------------------------------------------------------------------------
 *
 * That file calls `policy.state.forBootstrap(...)` / `forBatch(...)` and then
 * `keyedUserOf` directly. PDM-139's words for what that is worth: *a prepared
 * hook tested in isolation can be unused by a serving path*. It establishes that
 * the ARM answers correctly. It does not establish that anything ASKS it.
 *
 * So this file drives a real `Authority` over the real `makeFeedVisibility`
 * policy and asserts on what a principal is actually SERVED:
 *
 *   - `authority.bootstrap(principal)` — the FRESH-CLIENT path, a cold client
 *     asking for its world.
 *   - `authority.changesSince(cursor, principal)` — the DELTA path.
 *
 * Both run through `GrantEdgeVisibilityPolicy.decide`, which is the function the
 * unit file never touches. If the conjunction were wired into an arm the serving
 * path does not consult, every assertion there would still pass and every
 * assertion here would fail.
 *
 * The stub is the CHANGE LOG, not the policy — same arrangement as
 * `modules/read-position/feed.test.ts`, whose per-user-state shape this follows.
 * The thing under test is which rows come back for whom, so the visibility
 * policy is the real one and only the storage beneath it is in-memory.
 */

import { asIssueId, asUserId, issueMarksRowId, type UserId } from '@podium/model'
import { asCapabilityRef, asDeviceId, type Principal } from '@podium/protocol'
import {
  Authority,
  DeviceGradeNoAnchors,
  GrantEdgeVisibilityPolicy,
  NoDelegationsGranted,
} from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFeedVisibility } from './feed-visibility'
import type { FeedVisibilityStore, IssueRow, SessionRow } from './hot-path-ports'
import { WorldIndex } from './modules/world-index'
import type { SessionStore } from './store'
import type { GrantRow } from './store/grants'
import { openTestStore } from './test-support/open-test-store'

const owner = asUserId('owner')
const reader = asUserId('reader')
const SHARED = asIssueId('shared')
/** A second readable issue that the purge must not touch. */
const KEPT = asIssueId('kept')
const strangerUser = asUserId('stranger')

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
  const issue = { id: SHARED, ownerUserId: owner } as IssueRow
  const kept = { id: KEPT, ownerUserId: owner } as IssueRow
  /** Flipped by `purge()` below: after a hard delete SHARED resolves to nothing,
   *  which is the state the retraction has to be delivered IN. KEPT is
   *  unaffected, so "the purge took everything" cannot pass. */
  let issueExists = true
  const session = { id: 'shared', ownerUserId: owner } as unknown as SessionRow
  const rows: FeedVisibilityStore = {
    issues: {
      getIssue: async (id: string) =>
        id === KEPT ? kept : id === SHARED && issueExists ? issue : null,
      getIssues: async () =>
        new Map(
          issueExists
            ? [
                [issue.id, issue],
                [kept.id, kept],
              ]
            : [[kept.id, kept]],
        ),
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
  const authority = new Authority({
    store: memoryStore(),
    now: () => 1_000,
    transact: (fn) => fn(),
    // THE REAL POLICY. Only the change log above is a double.
    visibility: new GrantEdgeVisibilityPolicy(policy.state, new NoDelegationsGranted()),
    anchors: new DeviceGradeNoAnchors(),
  })
  const grant = async (grantee: string, resourceId: string = SHARED) =>
    await store.transact(async () => {
      await store.grants.upsert({
        resourceKind: 'issue',
        resourceId,
        grantee,
        verb: 'read' as GrantRow['verb'],
        owner,
        visibility: 'personal',
        createdAt: '2026-09-13T00:00:00Z',
        actorKind: 'user',
        actorId: owner,
        onBehalfOf: owner,
      })
    })
  const revoke = async (grantee: string) =>
    await store.transact(async () => {
      await store.grants.remove('issue', SHARED, grantee, 'read')
    })
  const publishMarks = async (user: UserId, readAt: string, issueId: string = SHARED) =>
    await authority.capture([
      {
        entity: 'issueMarks',
        entityId: issueMarksRowId(user, issueId),
        op: 'upsert',
        value: { userId: user, issueId, readAt, tuckedAt: null, pinned: false },
      },
    ])
  /**
   * A PURGE, in the order `purgeEmptyDraft` does it: the issue row is gone by the
   * time the tombstone is emitted. That ordering is the whole question — see the
   * describe block at the bottom of this file.
   */
  const purge = async (holders: readonly UserId[]) => {
    issueExists = false
    await authority.capture([
      { entity: 'issue', entityId: SHARED, op: 'remove' },
      ...holders.map((h) => ({
        entity: 'issueMarks' as const,
        entityId: issueMarksRowId(h, SHARED),
        op: 'remove' as const,
      })),
    ])
  }
  return { authority, grant, revoke, publishMarks, purge }
}

/** The marks rows a FRESH CLIENT is served — the cold-bootstrap path. */
const bootstrapMarks = async (
  authority: Awaited<ReturnType<typeof build>>['authority'],
  user: UserId,
): Promise<string[]> =>
  (await authority.bootstrap(humanPrincipal(user))).changes
    .filter((c) => c.entity === 'issueMarks')
    .map((c) => c.entityId)

describe('what a principal is actually SERVED', () => {
  it('serves the owner their own marks on a fresh bootstrap', async () => {
    // The positive, and the one that would fail if the conjunction were wired
    // into an arm nothing consults — or if it denied for want of a prefetched
    // row rather than for want of a right.
    const { authority, publishMarks } = await build()
    await publishMarks(owner, 'T-owner')

    expect(await bootstrapMarks(authority, owner)).toEqual([issueMarksRowId(owner, SHARED)])
  })

  it('serves a READ-GRANTEE their own marks, and never the owner’s', async () => {
    const { authority, grant, publishMarks } = await build()
    await grant(reader)
    await publishMarks(owner, 'T-owner')
    await publishMarks(reader, 'T-reader')

    // Each gets exactly their own row: the positive AND the cross-user negative
    // in one assertion, which is what "per-user" has to mean on a real feed.
    expect(await bootstrapMarks(authority, reader)).toEqual([issueMarksRowId(reader, SHARED)])
    expect(await bootstrapMarks(authority, owner)).toEqual([issueMarksRowId(owner, SHARED)])
  })

  it('STOPS serving a member their own row once their access is revoked', async () => {
    // THE REVOCATION CASE, on the serving path. Same user, same row, same key —
    // only the right changed, and no purge has run. The row is still correctly
    // theirs; what it must no longer do is tell them the issue exists.
    const { authority, grant, revoke, publishMarks } = await build()
    await grant(reader)
    await publishMarks(reader, 'T-reader')
    expect(await bootstrapMarks(authority, reader)).toEqual([issueMarksRowId(reader, SHARED)])

    await revoke(reader)

    expect(await bootstrapMarks(authority, reader)).toEqual([])
    // …and the owner is unaffected, so this is a narrowing rather than the feed
    // having stopped serving the kind altogether.
    await publishMarks(owner, 'T-owner')
    expect(await bootstrapMarks(authority, owner)).toEqual([issueMarksRowId(owner, SHARED)])
  })

  it('applies the same rule to DELTAS as to the bootstrap', async () => {
    // Two arms that disagree is how one of them gets missed. The mark is
    // published AFTER the cursor is taken, so it can only arrive as a delta.
    const { authority, grant, revoke, publishMarks } = await build()
    await grant(reader)
    const before = await authority.cursor()
    await publishMarks(reader, 'T-reader')

    const granted = await authority.changesSince(before, humanPrincipal(reader))
    expect(granted?.kind).toBe('batch')
    if (granted?.kind !== 'batch') return
    expect(granted.changes.filter((c) => c.entity === 'issueMarks').map((c) => c.entityId)).toEqual(
      [issueMarksRowId(reader, SHARED)],
    )

    // Revoke, then publish again: the delta path must refuse it too.
    await revoke(reader)
    const afterRevoke = await authority.cursor()
    await publishMarks(reader, 'T-reader-2')

    const denied = await authority.changesSince(afterRevoke, humanPrincipal(reader))
    // ASSERT THE RESPONSE BEFORE NARROWING TO IT (PDM-139). The granted arm
    // above does this; this one used to open with a bare
    // `if (denied?.kind !== 'batch') return`, so a `reset`, an `undefined`, or
    // any unexpected shape would have finished GREEN without ever reaching the
    // no-marks assertion — a refusal test that passes because nothing was
    // examined is the failure this whole file exists to rule out.
    //
    // `batch` is the only legitimate outcome here: the cursor was taken after
    // the revoke and one change has been appended since, so there is a
    // contiguous window to serve and no reason for the Authority to reset.
    expect(denied?.kind).toBe('batch')
    if (denied?.kind !== 'batch') return
    expect(denied.changes.filter((c) => c.entity === 'issueMarks')).toEqual([])
  })
})

describe('a purge actually RETRACTS the marks it published', () => {
  /**
   * PDM-139's source concern, and it is a real interaction between two things I
   * built: `keyedUserOf` for `issueMarks` requires the issue-read snapshot, but
   * a purge DELETES the issue before the tombstone is emitted — and
   * `Authority.scopeBatch` runs `policy.decide` over REMOVALS too. If the
   * conjunction refuses the removal for want of an issue that no longer exists,
   * the tombstone is published and never delivered, and a cached client keeps
   * its marks for a deleted issue forever. That is the exact failure the
   * tombstone path was added to prevent, reintroduced by the gate.
   *
   * The previous evidence collected `MetadataChange` through
   * `issueTestPlumbing`, which proves the PURGE and the EMISSION. It cannot
   * prove RETRACTION, because nothing in it crosses the scoping boundary. These
   * do: same real `Authority` over the same real policy as the rest of this file.
   *
   * Measured rather than presumed either way.
   */
  it('delivers the removal to the holder even though the issue is gone', async () => {
    const { authority, grant, publishMarks, purge } = await build()
    await grant(reader)
    await publishMarks(reader, 'T-reader')
    // Precondition: the client HOLDS the mark. Without this the retraction
    // assertion below is satisfied by a feed that never delivered anything.
    expect(await bootstrapMarks(authority, reader)).toEqual([issueMarksRowId(reader, SHARED)])

    const before = await authority.cursor()
    await purge([reader])

    const delivery = await authority.changesSince(before, humanPrincipal(reader))
    expect(delivery?.kind).toBe('batch')
    if (delivery?.kind !== 'batch') return
    const marks = delivery.changes.filter((c) => c.entity === 'issueMarks')
    // The retraction has to ARRIVE. A silently-dropped removal leaves the stale
    // row painted forever, which is worse than never having published it.
    expect(marks.map((c) => ({ id: c.entityId, op: c.op }))).toEqual([
      { id: issueMarksRowId(reader, SHARED), op: 'remove' },
    ])
  })

  it('delivers the OWNER’s removal too — the case with no grant edge to lean on', async () => {
    // THE DISCRIMINATING CASE, and the one the grantee case above cannot reach.
    // `mayReadIssueFromSnapshot` admits a reader either because they OWN the
    // issue or because a grant edge admits them. A purge deletes the issue row
    // but NOT its grants, so a grantee is still admitted by a surviving edge —
    // which is why their retraction arrives, and why that passing proves less
    // than it looks.
    //
    // The owner has no edge to lean on: their admission came from the row that
    // was just deleted. If the conjunction refuses here, the owner's own client
    // keeps its pin and read mark for an issue that is gone, forever, and the
    // grantee case would have reported the tombstone working.
    const { authority, publishMarks, purge } = await build()
    await publishMarks(owner, 'T-owner')
    expect(await bootstrapMarks(authority, owner)).toEqual([issueMarksRowId(owner, SHARED)])

    const before = await authority.cursor()
    await purge([owner])

    const delivery = await authority.changesSince(before, humanPrincipal(owner))
    expect(delivery?.kind).toBe('batch')
    if (delivery?.kind !== 'batch') return
    expect(
      delivery.changes
        .filter((c) => c.entity === 'issueMarks')
        .map((c) => ({ id: c.entityId, op: c.op })),
    ).toEqual([{ id: issueMarksRowId(owner, SHARED), op: 'remove' }])
  })

  it('leaves a SECOND issue’s marks alone, and tells a stranger nothing', async () => {
    // Two controls in one: a purge that retracted everything would pass the case
    // above, and a removal delivered to someone who never held the row would
    // disclose that the issue had existed.
    const { authority, grant, publishMarks, purge } = await build()
    await grant(reader)
    await publishMarks(reader, 'T-reader')
    await grant(reader, KEPT)
    await publishMarks(reader, 'T-kept', KEPT)

    const before = await authority.cursor()
    await purge([reader])

    const delivery = await authority.changesSince(before, humanPrincipal(reader))
    if (delivery?.kind !== 'batch') return
    const removed = delivery.changes
      .filter((c) => c.entity === 'issueMarks' && c.op === 'remove')
      .map((c) => c.entityId)
    expect(removed).not.toContain(issueMarksRowId(reader, KEPT))

    const stranger = await authority.changesSince(before, humanPrincipal(strangerUser))
    if (stranger?.kind !== 'batch') return
    expect(stranger.changes.filter((c) => c.entity === 'issueMarks')).toEqual([])
  })
})
