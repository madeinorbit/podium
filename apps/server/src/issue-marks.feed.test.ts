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
  const session = { id: 'shared', ownerUserId: owner } as unknown as SessionRow
  const rows: FeedVisibilityStore = {
    issues: {
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
  const authority = new Authority({
    store: memoryStore(),
    now: () => 1_000,
    transact: (fn) => fn(),
    // THE REAL POLICY. Only the change log above is a double.
    visibility: new GrantEdgeVisibilityPolicy(policy.state, new NoDelegationsGranted()),
    anchors: new DeviceGradeNoAnchors(),
  })
  const grant = async (grantee: string) =>
    await store.transact(async () => {
      await store.grants.upsert({
        resourceKind: 'issue',
        resourceId: SHARED,
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
  const publishMarks = async (user: UserId, readAt: string) =>
    await authority.capture([
      {
        entity: 'issueMarks',
        entityId: issueMarksRowId(user, SHARED),
        op: 'upsert',
        value: { userId: user, issueId: SHARED, readAt, tuckedAt: null, pinned: false },
      },
    ])
  return { authority, grant, revoke, publishMarks }
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
