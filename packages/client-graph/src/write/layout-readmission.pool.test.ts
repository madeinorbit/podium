/**
 * A CLEARED LAYOUT CHOICE CAN BE MADE AGAIN (POD-7422).
 *
 * Opening a sidebar section clears its fold (`records.userLayout.remove`), so
 * the replica records the row's exit as `removed`. Closing it again writes the
 * same key. Through the production wiring (`createRuntimeWorklistPool`) over
 * the real feed (`createRowSource`), with the server's confirmation held back:
 * the close shows at once, stays shown while the write waits, and the
 * confirming feed row, equal to what the close painted, keeps it shown. A
 * refused close goes back to open.
 */

import type { OutboxEntry } from '@podium/client-core/outbox'
import { createRecordsApi } from '@podium/client-core/records'
import type { ReplicaAddressedBatch, ReplicaKind } from '@podium/client-core/replica'
import type { OutboxOutcome } from '@podium/client-core/runtime-root'
import { fixtureRoot } from '@podium/client-core/test-support/command-hooks'
import { LayoutAccess } from '@podium/client-core/ui'
import {
  asUserId,
  layoutRowId,
  pinRowId,
  readPositionRowId,
  tabOrderRowId,
  userPreferencesRowId,
} from '@podium/model'
import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { LOADING } from '../loading'
import { isGone, requireHere } from '../lookup'
import { createRuntimeWorklistPool, type WorklistRuntime } from '../runtime-pool'
import type { PoolTransactions } from './transactions'

const USER = 'u-1'
const KEY = 'sidebar.section.project-repo'
const ROW = layoutRowId(asUserId(USER), KEY)

type Row = Readonly<Record<string, unknown>>

function runtime() {
  const rows = new Map<ReplicaKind, Map<string, Row>>([['userLayouts', new Map()]])
  const exits = new Map<string, 'removed' | 'evicted'>()
  const addressed: ((batch: ReplicaAddressedBatch) => void)[] = []
  let queue: OutboxEntry[] = []
  let awaiting: OutboxEntry[] = []
  const outboxListeners = new Set<(size: number) => void>()
  const outcomeListeners = new Set<(outcome: OutboxOutcome) => void>()
  const publishOutbox = () => {
    for (const listener of [...outboxListeners]) listener(queue.length)
  }
  let transactions: PoolTransactions | undefined
  const records = createRecordsApi((kind, input) => transactions!.write(kind, input))
  const layout = new LayoutAccess(asUserId(USER), records)
  const rt = {
    principal: { userId: USER },
    readLocal: (key: string) => (key === 'repos' ? [] : null),
    onLocals: () => () => {},
    layout,
    replica: {
      rows: (kind: ReplicaKind) => [...(rows.get(kind)?.values() ?? [])],
      row: (kind: ReplicaKind, id: string) => rows.get(kind)?.get(id),
      exitKind: (entity: string, id: string) => exits.get(`${entity}:${id}`),
      subscribeAddressedBatch(listener: (batch: ReplicaAddressedBatch) => void) {
        addressed.push(listener)
        return () => {
          addressed.splice(addressed.indexOf(listener), 1)
        }
      },
    },
    outbox: {
      pending: () => queue,
      awaiting: () => awaiting,
      deadLetters: () => [],
      subscribe(listener: (size: number) => void) {
        outboxListeners.add(listener)
        return () => {
          outboxListeners.delete(listener)
        }
      },
      enqueue: async (
        kind: string,
        input: unknown,
        opts: { mutationId: string; queuedAt: number },
      ) => {
        queue = [...queue, { kind, input, ...opts } as OutboxEntry]
        publishOutbox()
      },
    },
    subscribeOutboxOutcomes(listener: (outcome: OutboxOutcome) => void) {
      outcomeListeners.add(listener)
      return () => {
        outcomeListeners.delete(listener)
      }
    },
    attachPoolWriter: () => () => {},
    notices: { error: () => {}, info: () => {} },
  }
  const handle = createRuntimeWorklistPool(fixtureRoot(rt) as unknown as WorklistRuntime)
  transactions = handle.transactions
  const answer = (outcome: OutboxOutcome) => {
    for (const listener of [...outcomeListeners]) listener(outcome)
  }
  function feedRecord(
    kind: Choice['kind'],
    replicaKind: ReplicaKind,
    id: string,
    value: Row | typeof GONE,
  ) {
    let table = rows.get(replicaKind)
    if (table === undefined) {
      table = new Map()
      rows.set(replicaKind, table)
    }
    if (value === GONE) {
      table.delete(id)
      exits.set(`${kind}:${id}`, 'removed')
    } else {
      table.set(id, value)
      exits.delete(`${kind}:${id}`)
    }
    const batch: ReplicaAddressedBatch = { type: 'update', rows: [{ kind: replicaKind, id }] }
    for (const listener of [...addressed]) listener(batch)
  }
  return {
    layout,
    records,
    pool: handle.pool,
    transactions: handle.transactions,
    feedRecord,
    /** The server applied the oldest queued write; its feed row is not here yet. */
    apply() {
      const entry = queue[0]!
      queue = queue.slice(1)
      awaiting = [...awaiting, { ...entry, state: 'awaiting-truth' }]
      answer({ type: 'applied', mutationId: entry.mutationId, entry })
      publishOutbox()
    },
    /** The server refused the oldest queued write. */
    refuse() {
      const entry = queue[0]!
      queue = queue.slice(1)
      answer({ type: 'rejected', mutationId: entry.mutationId, entry, parked: false })
      publishOutbox()
    },
    /** The feed carries the layout row (or its removal), as the kernel applies it. */
    feed(value: unknown | typeof GONE) {
      feedRecord(
        'userLayout',
        'userLayouts',
        ROW,
        value === GONE ? GONE : { userId: USER, key: KEY, value },
      )
    },
    /** The replica's confirmation retired every awaiting entry. */
    confirm() {
      awaiting = []
      publishOutbox()
    },
    dispose: () => handle.dispose(),
  }
}

const GONE = Symbol('gone')

/** The feed publishes on a microtask; let it. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

/** What the section header shows, every time it changed. */
function header(layout: LayoutAccess) {
  const seen: unknown[] = []
  const stop = autorun(() => {
    seen.push(layout.get(KEY))
  })
  return { seen, now: () => seen.at(-1), stop }
}

async function closeThenOpen(rt: ReturnType<typeof runtime>) {
  rt.layout.set(KEY, true)
  await settled()
  rt.apply()
  rt.feed(true)
  rt.confirm()
  await settled()
  rt.layout.clear(KEY)
  await settled()
  rt.apply()
  rt.feed(GONE)
  rt.confirm()
  await settled()
}

describe('a cleared layout choice made again (POD-7422)', () => {
  it('close, open, close again: shown at once and kept through a held, equal confirmation', async () => {
    const rt = runtime()
    const shown = header(rt.layout)
    try {
      await settled()
      await closeThenOpen(rt)
      expect(shown.now()).toBeUndefined()

      rt.layout.set(KEY, true)
      await settled()
      expect(shown.now()).toBe(true)
      // The reply is slow; nothing moves.
      rt.apply()
      await settled()
      expect(shown.now()).toBe(true)
      // The confirming row equals what the close painted.
      rt.feed(true)
      await settled()
      expect(shown.now()).toBe(true)
      rt.confirm()
      await settled()
      expect(shown.now()).toBe(true)
      expect(shown.seen.slice(-4)).not.toContain(undefined)
    } finally {
      shown.stop()
      rt.dispose()
    }
  })

  it('the layout subscription hears the close once when confirmation and retirement share a tick', async () => {
    const rt = runtime()
    const notified: string[][] = []
    // The header has read its fold once, as a mounted section does.
    rt.layout.get(KEY)
    const stop = rt.layout.subscribe((keys) => notified.push([...keys]))
    try {
      await settled()
      await closeThenOpen(rt)
      notified.length = 0
      rt.layout.set(KEY, true)
      await settled()
      expect(notified).toEqual([[KEY]])
      rt.apply()
      rt.feed(true)
      rt.confirm()
      await settled()
      expect(notified).toEqual([[KEY]])
      expect(rt.layout.get(KEY)).toBe(true)
    } finally {
      stop()
      rt.dispose()
    }
  })

  it('a refused close goes back to open', async () => {
    const rt = runtime()
    const shown = header(rt.layout)
    try {
      await settled()
      await closeThenOpen(rt)
      rt.layout.set(KEY, true)
      await settled()
      expect(shown.now()).toBe(true)
      rt.refuse()
      await settled()
      expect(shown.now()).toBeUndefined()
    } finally {
      shown.stop()
      rt.dispose()
    }
  })

  it('a removal from elsewhere still reads as gone while nothing paints the row', async () => {
    const rt = runtime()
    const shown = header(rt.layout)
    try {
      await settled()
      rt.feed(true)
      await settled()
      expect(shown.now()).toBe(true)
      rt.feed(GONE)
      await settled()
      expect(shown.now()).toBeUndefined()
      // Another device closes it again: an ordinary readmission.
      rt.feed(true)
      await settled()
      expect(shown.now()).toBe(true)
    } finally {
      shown.stop()
      rt.dispose()
    }
  })
})

interface Choice {
  kind: 'userLayout' | 'pin' | 'tabOrder' | 'userPreferences' | 'userReadPosition'
  replica: 'userLayouts' | 'pins' | 'tabOrders' | 'userPreferences' | 'userReadPositions'
  id: string
  row: Row
  read(row: Row): unknown
  expected: unknown
  choose(rt: ReturnType<typeof runtime>): unknown
}

const PIN = pinRowId(asUserId(USER), 'issue', 'i-1')
const TABS = tabOrderRowId(asUserId(USER), '/project')
const PREFS = userPreferencesRowId(asUserId(USER))
const POSITION = readPositionRowId(asUserId(USER), 'issueEvents')
const choices: readonly Choice[] = [
  {
    kind: 'userLayout',
    replica: 'userLayouts',
    id: ROW,
    row: { userId: USER, key: KEY, value: true },
    read: (row) => row.value,
    expected: true,
    choose: (rt) => rt.layout.set(KEY, true),
  },
  {
    kind: 'pin',
    replica: 'pins',
    id: PIN,
    row: { userId: USER, kind: 'issue', entityId: 'i-1', pinnedAt: '2026-11-01T00:00:00Z' },
    read: (row) => row.entityId,
    expected: 'i-1',
    choose: (rt) =>
      rt.records.create('pin', PIN, { userId: asUserId(USER), kind: 'issue', entityId: 'i-1' }),
  },
  {
    kind: 'tabOrder',
    replica: 'tabOrders',
    id: TABS,
    row: { userId: USER, entityId: '/project', sessionIds: ['s-2', 's-1'] },
    read: (row) => row.sessionIds,
    expected: ['s-2', 's-1'],
    choose: (rt) => rt.records.edit({ kind: 'tabOrder', id: TABS }, { sessionIds: ['s-2', 's-1'] }),
  },
  {
    kind: 'userPreferences',
    replica: 'userPreferences',
    id: PREFS,
    row: { userId: USER, 'sidebar.repoSort': 'alphabetical' },
    read: (row) => (row.sidebar as { repoSort: string }).repoSort,
    expected: 'alphabetical',
    choose: (rt) =>
      rt.records.edit(
        { kind: 'userPreferences', id: PREFS },
        { 'sidebar.repoSort': 'alphabetical' },
      ),
  },
  {
    kind: 'userReadPosition',
    replica: 'userReadPositions',
    id: POSITION,
    row: { userId: USER, streamId: 'issueEvents', lastEventId: 42, seenAt: null },
    read: (row) => row.lastEventId,
    expected: 42,
    choose: (rt) =>
      rt.records.edit(
        { kind: 'userReadPosition', id: POSITION },
        { lastEventId: 42, seenAt: null },
      ),
  },
]

describe.each(choices)('$kind readmission through the runtime pool', (choice) => {
  function observe(rt: ReturnType<typeof runtime>) {
    const seen: unknown[] = []
    const stop = autorun(() => {
      const row = rt.pool.row(choice.kind, choice.id)
      seen.push(row === LOADING ? LOADING : isGone(row) ? row.reason : choice.read(row))
    })
    return { seen, stop, now: () => seen.at(-1) }
  }

  async function remove(rt: ReturnType<typeof runtime>) {
    rt.feedRecord(choice.kind, choice.replica, choice.id, choice.row)
    await settled()
    rt.feedRecord(choice.kind, choice.replica, choice.id, GONE)
    await settled()
  }

  it('recreates immediately, holds its paint, then keeps equal truth through retirement', async () => {
    const rt = runtime()
    const shown = observe(rt)
    try {
      await remove(rt)
      expect(shown.now()).toBe('removed')
      const writing = choice.choose(rt)
      // The paint is synchronous, before the enqueue promise resolves.
      expect(shown.now()).toEqual(choice.expected)
      await writing
      await settled()
      const painted = requireHere(rt.pool.row(choice.kind, choice.id))
      const sinceRecreate = shown.seen.length
      rt.apply()
      await settled()
      expect(shown.now()).toEqual(choice.expected)
      expect(rt.transactions.pending.byRow(choice.replica).has(choice.id)).toBe(true)
      // Pin time is chosen at the press; preferences travel flat on the wire.
      const confirmation =
        choice.kind === 'pin' ? { ...choice.row, pinnedAt: painted.pinnedAt } : choice.row
      rt.feedRecord(choice.kind, choice.replica, choice.id, confirmation)
      await settled()
      expect(requireHere(rt.pool.row(choice.kind, choice.id))).toBe(painted)
      expect(shown.now()).toEqual(choice.expected)
      rt.confirm()
      await settled()
      expect(rt.transactions.pending.byRow(choice.replica).has(choice.id)).toBe(false)
      expect(shown.now()).toEqual(choice.expected)
      expect(
        shown.seen.slice(sinceRecreate).every((value) => value !== 'removed' && value !== LOADING),
      ).toBe(true)
      // Retirement really released the paint: a later external removal wins.
      rt.feedRecord(choice.kind, choice.replica, choice.id, GONE)
      await settled()
      expect(shown.now()).toBe('removed')
    } finally {
      shown.stop()
      rt.dispose()
    }
  })

  it('returns to removed when recreation is refused', async () => {
    const rt = runtime()
    const shown = observe(rt)
    try {
      await remove(rt)
      expect(shown.now()).toBe('removed')
      await choice.choose(rt)
      await settled()
      expect(shown.now()).toEqual(choice.expected)
      rt.refuse()
      await settled()
      expect(shown.now()).toBe('removed')
    } finally {
      shown.stop()
      rt.dispose()
    }
  })
})
