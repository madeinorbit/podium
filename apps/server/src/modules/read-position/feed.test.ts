/**
 * READ POSITIONS ON THE WATERMARKED SCOPED FEED (POD-1380).
 *
 * The defect this file exists to catch is a PRIVACY defect, and it does not
 * announce itself: a cursor delivered to the wrong principal looks exactly like
 * a working cursor until two people use the system. So every assertion here
 * names TWO principals — a single-actor test cannot tell "per-user" from "there
 * was only one user".
 *
 * Alice's advance reaches Alice's other device (bootstrap and delta) and reaches
 * Bob on neither, while the durable row is a positive control that the write
 * happened at all. A negative-only assertion passes just as well when nothing
 * was ever written.
 *
 * Uses an in-memory Authority (the same double as the layout sibling) so the
 * assertion is about feed scoping, not SQLite.
 */

import { asCapabilityRef, asDeviceId } from '@podium/protocol'
import { type Principal } from '@podium/protocol'
import {
  asUserId,
  type ReadPositionSnapshot,
  readPositionRowId,
  parseReadPositionRowId,
  type UserId,
} from '@podium/model'
import {
  Authority,
  DeviceGradeNoAnchors,
  GrantEdgeVisibilityPolicy,
  type VisibilityStatePort,
  NoDelegationsGranted,
} from '@podium/sync'
import { describe, expect, it } from 'vitest'
import type { StoredReadPosition } from '../../store/user-read-position'
import { ReadPositionService } from './service'

const ALICE: UserId = asUserId('user:alice')
const BOB: UserId = asUserId('user:bob')

type AuthorityStore = ConstructorParameters<typeof Authority>[0]['store']

function humanPrincipal(userId: UserId): Principal {
  return {
    kind: 'user',
    user: userId,
    device: asDeviceId(`dev:${userId}`),
    capability: asCapabilityRef(`cap:${userId}`),
  }
}

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
    appendChanges(
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
    maxChangeSeq: () => nextSeq - 1,
    minChangeSeq: () => rows[0]?.seq ?? null,
    changesSince: (cursor: number) => rows.filter((r) => r.seq > cursor),
    planChangePrune: () => ({ thresholdSeq: 0 }),
    pruneChangeBatch: () => 0,
    latestChangeStates: () => {
      const latest = new Map<string, (typeof rows)[number]>()
      for (const r of rows) latest.set(`${r.entity}/${r.entityId}`, r)
      return [...latest.values()]
    },
  } as AuthorityStore
}

/** Minimal cursor store — only what ReadPositionService calls, monotonic like the real one. */
function memoryCursorRepo() {
  const byUser = new Map<string, Map<string, StoredReadPosition>>()
  return {
    getSnapshot(userId: UserId): ReadPositionSnapshot {
      const m = byUser.get(userId)
      return m ? (Object.fromEntries(m) as ReadPositionSnapshot) : {}
    },
    advance(
      userId: UserId,
      streamId: string,
      proposed: StoredReadPosition,
      _updatedAt: string,
    ): StoredReadPosition | null {
      let m = byUser.get(userId)
      if (!m) {
        m = new Map()
        byUser.set(userId, m)
      }
      const current = m.get(streamId)
      if (current !== undefined && proposed.lastEventId <= current.lastEventId) return null
      m.set(streamId, proposed)
      return proposed
    },
  }
}

function build() {
  const visibilityPort: VisibilityStatePort = {
    classOf: (entity) => (entity === 'userReadPosition' ? 'per-user-state' : null),
    mayRead: () => false,
    keyedUserOf: (ref) => {
      if (ref.entity !== 'userReadPosition') return null
      try {
        return parseReadPositionRowId(ref.entityId).userId
      } catch {
        return null
      }
    },
  }
  const authority = new Authority({
    store: memoryStore(),
    now: () => 1_000,
    transact: (fn) => fn(),
    visibility: new GrantEdgeVisibilityPolicy(visibilityPort, new NoDelegationsGranted()),
    anchors: new DeviceGradeNoAnchors(),
  })
  const repo = memoryCursorRepo()
  const service = new ReadPositionService({
    cursors: repo as never,
    ledger: {
      capture: (specs) => {
        authority.capture(
          specs.map((s) => ({
            entity: s.entity,
            entityId: s.id,
            op: s.op,
            ...(s.value !== undefined ? { value: s.value } : {}),
          })),
        )
        return [] as never
      },
    },
  })
  return { authority, service, repo }
}

describe('read-cursor rows scope to the owning user on the Authority feed', () => {
  it("Alice's advance is on Alice's bootstrap, absent from Bob's, and durably stored", () => {
    const { authority, service, repo } = build()
    service.advance(ALICE, 'issueEvents', { lastEventId: 42, seenAt: '2026-08-02T10:00:00Z' }, 't')

    // Positive control: the write happened. Without this, the Bob assertion
    // below passes just as well when nothing was ever captured.
    expect(repo.getSnapshot(ALICE)).toEqual({
      issueEvents: { lastEventId: 42, seenAt: '2026-08-02T10:00:00Z' },
    })
    expect(repo.getSnapshot(BOB)).toEqual({})

    const aliceWorld = authority.bootstrap(humanPrincipal(ALICE))
    const bobWorld = authority.bootstrap(humanPrincipal(BOB))

    const aliceRows = aliceWorld.changes.filter((c) => c.entity === 'userReadPosition')
    const bobRows = bobWorld.changes.filter((c) => c.entity === 'userReadPosition')

    expect(aliceRows.map((c) => c.entityId)).toEqual([readPositionRowId(ALICE, 'issueEvents')])
    expect(bobRows).toEqual([])

    const row = aliceRows[0]
    expect(row?.op === 'upsert' && row.value).toEqual({
      userId: ALICE,
      streamId: 'issueEvents',
      lastEventId: 42,
      seenAt: '2026-08-02T10:00:00Z',
    })
  })

  it("a later advance reaches Alice's changesSince and Bob receives no cursor delta", () => {
    const { authority, service } = build()
    service.advance(ALICE, 'issueEvents', { lastEventId: 10, seenAt: null }, 't1')
    const before = authority.cursor()
    service.advance(ALICE, 'issueEvents', { lastEventId: 20, seenAt: null }, 't2')

    const delivery = authority.changesSince(before, humanPrincipal(ALICE))
    expect(delivery?.kind).toBe('batch')
    if (delivery?.kind !== 'batch') return
    expect(
      delivery.changes.some(
        (c) =>
          c.entity === 'userReadPosition' && c.entityId === readPositionRowId(ALICE, 'issueEvents'),
      ),
    ).toBe(true)

    const bobDelivery = authority.changesSince(before, humanPrincipal(BOB))
    expect(bobDelivery?.kind).toBe('batch')
    if (bobDelivery?.kind !== 'batch') return
    expect(bobDelivery.changes.filter((c) => c.entity === 'userReadPosition')).toEqual([])
  })

  it('two people reading the same stream hold two independent positions', () => {
    // The shape of the bug this member exists to prevent: one shared cursor.
    // Both users read the SAME log, so a shared row would look correct for
    // whoever wrote last and would silently mark the other's unread events read.
    const { authority, service, repo } = build()
    service.advance(ALICE, 'issueEvents', { lastEventId: 99, seenAt: null }, 't')
    service.advance(BOB, 'issueEvents', { lastEventId: 7, seenAt: null }, 't')

    expect(repo.getSnapshot(ALICE).issueEvents?.lastEventId).toBe(99)
    expect(repo.getSnapshot(BOB).issueEvents?.lastEventId).toBe(7)

    const bobRows = authority
      .bootstrap(humanPrincipal(BOB))
      .changes.filter((c) => c.entity === 'userReadPosition')
    expect(bobRows.map((c) => c.entityId)).toEqual([readPositionRowId(BOB, 'issueEvents')])
    const bobRow = bobRows[0]
    expect(bobRow?.op === 'upsert' && (bobRow.value as { lastEventId: number }).lastEventId).toBe(7)
  })

  it('a no-op advance publishes nothing — a feed row must mean the position moved', () => {
    const { authority, service } = build()
    service.advance(ALICE, 'issueEvents', { lastEventId: 30, seenAt: null }, 't1')
    const before = authority.cursor()
    // Behind the stored position: a second device that wrote before its
    // hydration landed. It must neither store nor publish.
    service.advance(ALICE, 'issueEvents', { lastEventId: 5, seenAt: null }, 't2')

    const delivery = authority.changesSince(before, humanPrincipal(ALICE))
    if (delivery?.kind !== 'batch') return
    expect(delivery.changes.filter((c) => c.entity === 'userReadPosition')).toEqual([])
  })
})
