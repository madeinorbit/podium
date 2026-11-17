/** LiveStore replacement: the two-axis startup corpus keeps the old answers. */
import { knownReading, LiveStore, unknownReading } from '@podium/client-core/live'
import type { MobxPool } from '@podium/client-graph/pool'
import { describe, expect, it } from 'vitest'
import { LegacyLiveStore } from '../../../../../packages/client-core/src/live/live-store.before.test.fixture'
import type { CorpusCell } from '../fixture'
import {
  ask,
  assertNoWrongNumber,
  checkNoWrongNumber,
  startupQuestions,
  startupTargets,
} from './no-wrong-number'
import {
  collectGarbage,
  fullPool,
  hydrateAll,
  lazyPool,
  openStartupFeed,
  type StartupFeed,
} from './startup-states'

/** The same live fixtures reach the old full-load control and each new candidate. */
function seed(store: LiveStore | LegacyLiveStore, feed: StartupFeed) {
  store.setConnection({ state: 'online', since: 1 })
  for (const row of feed.rows) {
    if (row.kind === 'session') {
      store.applyTopic(
        'session.condition',
        row.id,
        knownReading(
          {
            busy: true,
            requestsGated: 1,
            lastInputAt: '2026-10-01T12:00:00Z',
            contextUsagePercent: 47,
          },
          2,
        ),
      )
      store.applyTopic(
        'session.terminalState',
        row.id,
        knownReading({ controller: null, geometry: { cols: 132, rows: 43 } }, 2),
      )
      const machineId = (row.value as { machineId?: string }).machineId
      if (machineId)
        store.applyTopic(
          'machine.condition',
          machineId,
          knownReading({ online: true, since: null }, 2),
        )
    }
  }
}

function lose(store: LiveStore | LegacyLiveStore) {
  store.setConnection({ state: 'offline', since: 3 })
  for (const [kind, map] of [
    ['machine.condition', store.machineConditions],
    ['session.condition', store.sessionConditions],
    ['session.terminalState', store.sessionTerminalStates],
  ] as const)
    for (const id of map.keys()) store.applyTopic(kind, id, unknownReading(3))
}

const cells: CorpusCell[] = [
  { history: 1, active: 1 },
  { history: 10, active: 1 },
  { history: 1, active: 4 },
  { history: 10, active: 4 },
]

describe('declared live parts against the old full-load control', () => {
  for (const cell of cells) {
    const label = `h${cell.history}a${cell.active}`
    it(`${label}: full and lazy startup answers equal the control or are LOADING`, async () => {
      const feed = await openStartupFeed(cell)
      const questions = startupQuestions(startupTargets(feed.rows))
      const controlPool = fullPool(feed)
      const old = new LegacyLiveStore({ now: () => 1 })
      // Only this test binds the frozen previous implementation to the pool.
      // Its public model-facing readers are the contract being compared.
      controlPool.bindLive(old as unknown as LiveStore)
      seed(old, feed)
      const control = ask(controlPool, questions)
      lose(old)
      const disconnected = ask(controlPool, questions)
      controlPool.dispose()
      old.dispose()
      collectGarbage()
      const compare = (pool: MobxPool, label: string, expected: Map<string, unknown>) => {
        const report = checkNoWrongNumber(expected, ask(pool, questions))
        assertNoWrongNumber(report, label)
        return report
      }
      const full = fullPool(feed)
      const current = new LiveStore({ now: () => 1 })
      full.bindLive(current)
      seed(current, feed)
      try {
        expect(compare(full, `${label} full`, control).loading).toEqual([])
        lose(current)
        expect(compare(full, `${label} disconnected`, disconnected).loading).toEqual([])
      } finally {
        full.dispose()
        current.dispose()
        collectGarbage()
      }
      const handle = lazyPool(feed)
      const live = new LiveStore({ now: () => 1 })
      handle.pool.bindLive(live)
      seed(live, feed)
      try {
        compare(handle.pool, `${label} before loading`, control)
        hydrateAll(handle.pool, questions)
        expect(compare(handle.pool, `${label} loaded`, control).loading).toEqual([])
        lose(live)
        expect(compare(handle.pool, `${label} loaded disconnected`, disconnected).loading).toEqual(
          [],
        )
      } finally {
        handle.dispose()
        live.dispose()
        collectGarbage()
      }
    }, 600_000)
  }
})
