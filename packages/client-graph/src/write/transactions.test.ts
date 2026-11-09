import { readFileSync } from 'node:fs'
import { foldRowOverlays, overlaysForOutboxEntry } from '@podium/client-core/command-reducers'
import type { OutboxOutcome } from '@podium/client-core/engine'
import { OUTBOX_COMMANDS } from '@podium/client-core/engine'
import type { OutboxEntry } from '@podium/client-core/outbox'
import { asMutationId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPoolTransactions } from './transactions'

/** Commands with no row to paint: replicated per-user rows reconciled by a
 *  read (pins, tab order, layout, personal settings) and the plain chat send.
 *  ADR 3 D6: absence is valid; they still show as pending. */
const PAINTS_NOTHING = new Set([
  // Effect records paint from their own data (PoolLaunches, POD-6408).
  'effectCreate',
  'effectDismiss',
  'sendText',
])

/** One input that satisfies every reducer's reads. */
const INPUT = {
  id: 'i-1',
  sessionId: 's-1',
  name: ' Renamed ',
  archived: true,
  workState: 'done',
  until: null,
  offerCreatedAt: '2026-10-01T00:00:00.000Z',
  tucked: true,
  patch: { title: 'Renamed', pinned: true },
  reason: 'done',
  labels: ['b', 'a'],
  placement: 'mission',
  originId: 'i-0',
  text: 'hello',
}

describe('PoolTransactions coverage (POD-5431)', () => {
  it('maps every queued command kind through the shared reducers', () => {
    // The per-user marks and the layout keys became generic record edits
    // (POD-6404), painted by the one record case (`records.test.ts`).
    // Pins, tab orders and personal settings followed
    // (POD-6673): generic creates, edits and removes of their own records.
    const kinds = Object.keys(OUTBOX_COMMANDS)
    expect(kinds).toHaveLength(10)
    const silent = kinds.filter(
      (kind) =>
        overlaysForOutboxEntry({
          mutationId: asMutationId(`m-${kind}`),
          kind,
          input: INPUT,
          queuedAt: Date.parse('2026-10-03T00:00:00.000Z'),
        }).length === 0,
    )
    // Every other kind paints at least one row; a new kind must land on one
    // side of this line on purpose.
    expect(new Set(silent)).toEqual(PAINTS_NOTHING)
  })

  it('reaches the reducers without importing an engine value', () => {
    for (const file of ['./transactions.ts', '../shared/row-source.ts']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8')
      const engineImports = [
        ...text.matchAll(/import\s+(type\s+)?\{[^}]*\}\s+from\s+'@podium\/client-core\/engine'/g),
      ]
      for (const match of engineImports) expect(match[1], `${file}: ${match[0]}`).toBe('type ')
      expect(text).toMatch(/from '@podium\/client-core\/command-reducers'/)
    }
  })
})

describe('PoolTransactions refusal (POD-5431)', () => {
  it('enqueues with the mutation id and press time only', async () => {
    const entries: OutboxEntry[] = []
    let publish: (size: number) => void = () => {}
    let serial = 0
    const tx = createPoolTransactions({
      userId: 'u-1',
      outbox: {
        pending: () => entries,
        awaiting: () => [],
        deadLetters: () => [],
        subscribe: (listener) => {
          publish = listener
          return () => {}
        },
      },
      outcomes: () => () => {},
      addressed: () => () => {},
      mintId: () => asMutationId(`m-${++serial}`),
      enqueue: async (kind, input, opts) => {
        expect(Object.keys(opts).sort()).toEqual(['mutationId', 'queuedAt'])
        entries.push({ kind, input, ...opts })
        publish(entries.length)
      },
    })
    tx.bind({ truth: () => ({ id: 'i-1', title: 'Accepted' }), repaint: () => null })
    await tx.write('issueUpdate', { id: 'i-1', patch: { title: 'First' } })
    await tx.write('issueUpdate', { id: 'i-1', patch: { title: 'Second' } })
    expect(entries).toHaveLength(2)
    tx.dispose()
  })
  it('rebases the refused change in the action that records the refusal, then announces it', async () => {
    let queue: OutboxEntry[] = []
    let outcome: (o: OutboxOutcome) => void = () => {}
    let publish: (size: number) => void = () => {}
    const log: string[] = []
    const tx = createPoolTransactions({
      userId: 'u-1',
      outbox: {
        pending: () => queue,
        awaiting: () => [],
        deadLetters: () => [],
        subscribe: (listener) => {
          publish = listener
          return () => {}
        },
      },
      outcomes: (listener) => {
        outcome = listener
        return () => {}
      },
      enqueue: async (kind, input, opts) => {
        queue = [...queue, { mutationId: opts.mutationId, kind, input, queuedAt: opts.queuedAt }]
        publish(queue.length)
      },
      addressed: () => () => {},
      mintId: () => asMutationId('m-b'),
    })
    tx.bind({
      repaint: (rows) => {
        for (const row of rows)
          log.push(
            `repaint ${row.kind}:${row.id} ${tx.pending.byRow('issueProjections').get(row.id)?.length ?? 0}`,
          )
        return null
      },
      truth: () => undefined,
    })
    tx.onRejected((rejection) =>
      log.push(`rejected ${rejection.mutationId} parked=${rejection.parked}`),
    )
    tx.mutate('issueUpdate', { id: 'i-1', patch: { title: 'B' } })
    await Promise.resolve()
    await Promise.resolve()
    // Painted at the press, still painted once the queue holds it.
    expect(log.length).toBeGreaterThan(0)
    expect(log.every((line) => line === 'repaint issue:i-1 1')).toBe(true)
    expect(tx.size()).toBe(1)
    log.length = 0
    // The refusal arrives while the queue still lists the entry: nothing else
    // in this setup would repaint the row.
    outcome({ type: 'rejected', mutationId: asMutationId('m-b'), entry: queue[0]!, parked: true })
    expect(log).toEqual(['repaint issue:i-1 0', 'rejected m-b parked=true'])
    expect(tx.size()).toBe(0)
    tx.dispose()
  })
})

/**
 * An outbox double in the kernel's order: an applied entry leaves `pending()`
 * for `awaiting()` before its outcome fires, then subscribers hear the change;
 * only confirmation (`retire`) takes it out of `awaiting()`.
 */
function confirmationLog(row: Record<string, unknown>) {
  let queue: OutboxEntry[] = []
  let awaiting: OutboxEntry[] = []
  let truth = row
  let publish: (size: number) => void = () => {}
  let outcome: (o: OutboxOutcome) => void = () => {}
  let serial = 0
  const tx = createPoolTransactions({
    userId: 'u-1',
    outbox: {
      pending: () => queue,
      awaiting: () => awaiting,
      deadLetters: () => [],
      subscribe: (listener) => {
        publish = listener
        return () => {}
      },
    },
    outcomes: (listener) => {
      outcome = listener
      return () => {}
    },
    addressed: () => () => {},
    mintId: () => asMutationId(`m-${++serial}`),
    enqueue: async (kind, input, opts) => {
      queue = [...queue, { kind, input, ...opts }]
      publish(queue.length)
    },
  })
  tx.bind({ truth: () => truth, repaint: () => null })
  return {
    tx,
    /** The row as the pool shows it: truth with the log's overlays folded on. */
    shown: () =>
      foldRowOverlays(truth, tx.pending.byRow('issueProjections').get(String(row.id)) ?? []),
    painted: () => tx.pending.byRow('issueProjections').get(String(row.id))?.length ?? 0,
    truth(next: Record<string, unknown>) {
      truth = next
    },
    apply(id: string) {
      const entry = queue.find((e) => e.mutationId === id)!
      queue = queue.filter((e) => e !== entry)
      awaiting = [...awaiting, { ...entry, state: 'awaiting-truth' }]
      outcome({ type: 'applied', mutationId: entry.mutationId, entry })
      publish(queue.length)
    },
    retire(id: string) {
      awaiting = awaiting.filter((e) => e.mutationId !== id)
      publish(queue.length)
    },
  }
}

describe('PoolTransactions confirmation (POD-6279)', () => {
  afterEach(() => vi.useRealTimers())

  it('an applied patch keeps painting until its entry retires, whatever the row shows', async () => {
    const log = confirmationLog({ id: 'i-1', title: 'Old' })
    await log.tx.write('issueUpdate', { id: 'i-1', patch: { title: 'Mine' } })
    log.apply('m-1')
    // Not covered yet, already covered, and moved to a third value: none of
    // them is the entry leaving the outbox, so the overlay stays.
    for (const title of ['Old', 'Mine', 'Theirs']) {
      log.truth({ id: 'i-1', title })
      log.tx.bind({ truth: () => ({ id: 'i-1', title }), repaint: () => null })
      expect(log.painted()).toBe(1)
      expect(log.shown()).toMatchObject({ title: 'Mine' })
    }
    log.retire('m-1')
    expect(log.painted()).toBe(0)
    log.tx.dispose()
  })

  it('a competing write shows once my entry retires; server order wins', async () => {
    const log = confirmationLog({ id: 'i-1', title: 'Old' })
    await log.tx.write('issueUpdate', { id: 'i-1', patch: { title: 'Mine' } })
    log.apply('m-1')
    // Another device wrote after me; the server ordered it last.
    log.truth({ id: 'i-1', title: 'Theirs' })
    expect(log.shown()).toMatchObject({ title: 'Mine' })
    log.retire('m-1')
    expect(log.shown()).toMatchObject({ title: 'Theirs' })
    log.tx.dispose()
  })

  it('no timer retires an awaiting patch', async () => {
    vi.useFakeTimers()
    const log = confirmationLog({ id: 'i-1', title: 'Old' })
    await log.tx.write('issueUpdate', { id: 'i-1', patch: { title: 'Mine' } })
    log.apply('m-1')
    vi.advanceTimersByTime(10 * 60_000)
    expect(log.painted()).toBe(1)
    expect(log.shown()).toMatchObject({ title: 'Mine' })
    log.retire('m-1')
    expect(log.painted()).toBe(0)
    log.tx.dispose()
  })

  it('restores awaiting entries at boot and drops them when they retire', () => {
    const entry: OutboxEntry = {
      mutationId: asMutationId('m-boot'),
      kind: 'issueUpdate',
      input: { id: 'i-1', patch: { title: 'Mine' } },
      queuedAt: 0,
      state: 'awaiting-truth',
    }
    let awaiting = [entry]
    let publish: (size: number) => void = () => {}
    const tx = createPoolTransactions({
      userId: 'u-1',
      outbox: {
        pending: () => [],
        awaiting: () => awaiting,
        deadLetters: () => [],
        subscribe: (listener) => {
          publish = listener
          return () => {}
        },
      },
      outcomes: () => () => {},
      addressed: () => () => {},
      enqueue: async () => {},
    })
    tx.bind({ truth: () => ({ id: 'i-1', title: 'Mine' }), repaint: () => null })
    expect(tx.pending.byRow('issueProjections').get('i-1')).toHaveLength(1)
    awaiting = []
    publish(0)
    expect(tx.pending.byRow('issueProjections').get('i-1')).toBeUndefined()
    tx.dispose()
  })
})
