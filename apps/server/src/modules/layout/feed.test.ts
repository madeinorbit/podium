/**
 * Layout on the watermarked scoped feed (POD-402 review gap 2).
 *
 * Alice device 1 writes → Alice device 2's bootstrap/delta sees the row;
 * Bob sees nothing. Positive control: the durable row exists for Alice.
 *
 * Uses an in-memory Authority (same double as packages/sync authority tests) so
 * the assertion is about feed scoping, not SQLite.
 */

import {
  asUserId,
  layoutRowId,
  parseLayoutRowId,
  type UserId,
} from '@podium/model'
import {
  Authority,
  DeviceGradeNoAnchors,
  GrantEdgeVisibilityPolicy,
  type ChangeLogStore,
  type FeedPrincipal,
  type VisibilityStatePort,
} from '@podium/sync'
import { describe, expect, it } from 'vitest'
import { LayoutService } from './service'
import type { UserLayoutRepository } from '../../store/user-layout'

const ALICE: UserId = asUserId('user:alice')
const BOB: UserId = asUserId('user:bob')

function humanPrincipal(userId: UserId): FeedPrincipal {
  return { kind: 'user', userId }
}

function memoryStore(): ChangeLogStore {
  const rows: {
    seq: number
    entity: string
    entityId: string
    op: string
    payload: string | null
  }[] = []
  let nextSeq = 1
  return {
    appendChanges(batch) {
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
    changesSince: (cursor) => rows.filter((r) => r.seq > cursor),
    planChangePrune: () => ({ thresholdSeq: 0 }),
    pruneChangeBatch: () => 0,
    latestChangeStates: () => {
      const latest = new Map<string, (typeof rows)[number]>()
      for (const r of rows) latest.set(`${r.entity}/${r.entityId}`, r)
      return [...latest.values()]
    },
  }
}

function memoryLayoutRepo(): UserLayoutRepository {
  const byUser = new Map<string, Map<string, unknown>>()
  return {
    getSnapshot(userId) {
      const m = byUser.get(userId)
      return m ? Object.fromEntries(m) : {}
    },
    get(userId, key) {
      return byUser.get(userId)?.get(key)
    },
    set(userId, key, value) {
      let m = byUser.get(userId)
      if (!m) {
        m = new Map()
        byUser.set(userId, m)
      }
      m.set(key, value)
    },
    setMany(userId, values) {
      for (const [k, v] of Object.entries(values)) this.set(userId, k, v)
    },
    clear(userId, key) {
      byUser.get(userId)?.delete(key)
    },
    clearMany(userId, keys) {
      for (const k of keys) this.clear(userId, k)
    },
    keysFor(userId) {
      return [...(byUser.get(userId)?.keys() ?? [])]
    },
  } as UserLayoutRepository
}

function build() {
  const visibilityPort: VisibilityStatePort = {
    classOf: (entity) => (entity === 'userLayout' ? 'per-user-state' : null),
    mayRead: () => false,
    keyedUserOf: (ref) => {
      if (ref.entity !== 'userLayout') return null
      try {
        return parseLayoutRowId(ref.entityId).userId
      } catch {
        return null
      }
    },
  }
  const authority = new Authority({
    store: memoryStore(),
    now: () => 1_000,
    transact: (fn) => fn(),
    visibility: new GrantEdgeVisibilityPolicy(visibilityPort),
    anchors: new DeviceGradeNoAnchors(),
  })
  const repo = memoryLayoutRepo()
  const service = new LayoutService({
    layout: repo,
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

describe('layout rows scope to the owning user on the Authority feed', () => {
  it('Alice write is on Alice bootstrap; Bob bootstrap is empty; row exists', () => {
    const { authority, service, repo } = build()
    service.set(ALICE, { dockTab: 'files', superOpen: true }, 't')

    // Positive control: durable storage holds the row for Alice.
    expect(repo.getSnapshot(ALICE)).toEqual({ dockTab: 'files', superOpen: true })
    expect(repo.getSnapshot(BOB)).toEqual({})

    const aliceWorld = authority.bootstrap(humanPrincipal(ALICE))
    const bobWorld = authority.bootstrap(humanPrincipal(BOB))

    const aliceLayout = aliceWorld.changes.filter((c) => c.entity === 'userLayout')
    const bobLayout = bobWorld.changes.filter((c) => c.entity === 'userLayout')

    expect(aliceLayout.map((c) => c.entityId).sort()).toEqual(
      [layoutRowId(ALICE, 'dockTab'), layoutRowId(ALICE, 'superOpen')].sort(),
    )
    expect(bobLayout).toEqual([])

    const dock = aliceLayout.find((c) => c.entityId === layoutRowId(ALICE, 'dockTab'))
    expect(dock?.op === 'upsert' && dock.value).toEqual({
      userId: ALICE,
      key: 'dockTab',
      value: 'files',
    })
  })

  it('a later write is visible on Alice changesSince; Bob receives no layout delta', () => {
    const { authority, service } = build()
    service.set(ALICE, { dockTab: 'chat' }, 't1')
    const before = authority.cursor()
    service.set(ALICE, { dockTab: 'files' }, 't2')

    const delivery = authority.changesSince(before, humanPrincipal(ALICE))
    expect(delivery?.kind).toBe('batch')
    if (delivery?.kind !== 'batch') return
    expect(
      delivery.changes.some(
        (c) => c.entity === 'userLayout' && c.entityId === layoutRowId(ALICE, 'dockTab'),
      ),
    ).toBe(true)

    const bobDelivery = authority.changesSince(before, humanPrincipal(BOB))
    expect(bobDelivery?.kind).toBe('batch')
    if (bobDelivery?.kind !== 'batch') return
    expect(bobDelivery.changes.filter((c) => c.entity === 'userLayout')).toEqual([])
  })
})
