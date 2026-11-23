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
import { asUserId, layoutRowId } from '@podium/model'
import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
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
  return {
    layout,
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
      const table = rows.get('userLayouts')!
      if (value === GONE) {
        table.delete(ROW)
        exits.set(`userLayout:${ROW}`, 'removed')
      } else {
        table.set(ROW, { userId: USER, key: KEY, value })
        exits.delete(`userLayout:${ROW}`)
      }
      const batch: ReplicaAddressedBatch = {
        type: 'update',
        rows: [{ kind: 'userLayouts', id: ROW }],
      }
      for (const listener of [...addressed]) listener(batch)
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
