import { readFileSync } from 'node:fs'
import { overlaysForOutboxEntry } from '@podium/client-core/command-reducers'
import type { OutboxOutcome } from '@podium/client-core/engine'
import { OUTBOX_COMMANDS } from '@podium/client-core/engine'
import type { OutboxEntry } from '@podium/client-core/outbox'
import { asMutationId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { createPoolTransactions } from './transactions'

/** Commands with no row to paint: replicated per-user rows reconciled by a
 *  read (pins, tab order, layout, personal settings) and the plain chat send.
 *  ADR 3 D6: absence is valid; they still show as pending. */
const PAINTS_NOTHING = new Set([
  'pinSet',
  'tabSetOrder',
  'layoutSet',
  'layoutClear',
  'settingsUpdatePersonal',
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
    const kinds = Object.keys(OUTBOX_COMMANDS)
    expect(kinds).toHaveLength(27)
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
