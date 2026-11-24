import { observableFixtureKeys } from '@podium/client-core/test-support/ui'
import type { RoutedUiState } from '@podium/client-core/ui-state'
import { autorun, runInAction } from 'mobx'
import { afterEach, describe, expect, it } from 'vitest'
import { fullDevice } from './full-device-fixture'
import { MissionScreen } from './mission-screen'
import { settled } from './mission-view'
import { MobxPool } from './pool'
import { attachPreferenceSource } from './preference-source'
import type { RowRecord } from './shared/source'

/**
 * POD-7178 — a drawn deck over a flat tree re-derives, per burst, the rows the
 * burst moved, not the tree. The operator's 970-issue deck is one root with
 * 969 children, and every burst of its answer built a new deck shape. Every
 * row read that whole shape (its children, its parent, whether the tree
 * overlaps), so each burst re-derived about fifteen roll-ups on every row.
 * Counted here as the row roll-ups derived while one burst is published and
 * the drawn deck settles, at two tree sizes with the same burst.
 */
const stamp = '2026-11-18T12:00:00Z'
const longAgo = '2025-10-14T12:00:00Z'
const OPEN = 3

const issue = (id: string, seq: number, patch: object): RowRecord => ({
  kind: 'issue',
  id,
  value: {
    id,
    seq,
    title: `Task ${id}`,
    audience: 'human',
    repoPath: '/synthetic/flat',
    deps: [],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: stamp,
    readAt: stamp,
    ...patch,
  } as never,
})
const child = (n: number): RowRecord => {
  const open = n < OPEN
  return issue(`child-${n}`, n + 2, {
    parentId: 'root',
    sortKey: `k${String(n).padStart(5, '0')}`,
    stage: open ? 'in_progress' : 'done',
    ...(open ? {} : { closedReason: 'completed', closedAt: longAgo, updatedAt: longAgo }),
  })
}

const flush = async () => {
  for (let turn = 0; turn < 40; turn++) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop()
})

/** Open the deck over `children` with every row drawn, publish `burst`, count the row roll-ups. */
async function rollupsPerBurst(
  children: number,
  burst: (size: number) => RowRecord[],
): Promise<{ rollups: number; rows: number; tasks: number }> {
  const values = new Map<string, string>()
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const ui: RoutedUiState = {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      if (value === null) values.delete(key)
      else values.set(key, value)
      for (const listener of listeners) listener(new Set([key]))
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const pool = fullDevice(new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }))
  attachPreferenceSource(pool, observableFixtureKeys(ui))
  const tree = [issue('root', 1, { stage: 'in_progress', parentId: null })]
  for (let n = 0; n < children; n += 1) tree.push(child(n))
  pool.apply({ type: 'replace', rows: tree })
  const screen = new MissionScreen(pool, 'root', { setPreference: (key, raw) => ui.set(key, raw) })
  let rows = 0,
    tasks = 0
  // What the web Full deck draws: the settled screen, each row's open state,
  // crew, word, title and counter, and the header's totals.
  const stop = autorun(() => {
    const drawn = settled(() => {
      if (!screen.ready || !screen.full.ready) return null
      for (const id of screen.full.rowIds) {
        const task = screen.full.task(id)
        void [task.open, task.sessionIds, task.word, task.counter, task.row.title]
      }
      const root = screen.deck.model('root')
      void [root.tasks, root.done, root.liveAgentCount, root.workingAgentCount, root.kinds]
      void [screen.full.counts, screen.deck.progress]
      return { rows: screen.full.rowIds.length, tasks: settled(() => root.tasks) }
    })
    if (drawn && typeof drawn === 'object') {
      rows = drawn.rows
      tasks = typeof drawn.tasks === 'number' ? drawn.tasks : -1
    }
  })
  cleanups.push(() => {
    stop()
    screen.close()
    pool.dispose()
  })
  await flush()
  // The screen's own reader derives the deck's roll-ups.
  const stats = screen.reader.stats
  let rollups = 0
  stats.onRollup = () => {
    rollups += 1
  }
  runInAction(() => pool.apply({ type: 'update', rows: burst(children) }))
  await flush()
  stats.onRollup = undefined
  return { rollups, rows, tasks }
}

/** Twenty more children arrive, as a burst of the tree's answer brings them. */
const arrive = (size: number) => Array.from({ length: 20 }, (_, n) => child(size + n))
/** One child moves to the front of its siblings. */
const reorder = () => [{ ...child(OPEN + 1), value: { ...child(OPEN + 1).value, sortKey: 'a' } }]

describe('a drawn deck over a flat tree works in proportion to the burst (POD-7178)', () => {
  it('twenty arriving children re-derive as many roll-ups under 1,000 children as under 250', async () => {
    const small = await rollupsPerBurst(250, arrive)
    const large = await rollupsPerBurst(1000, arrive)
    expect(small.rows).toBe(270)
    expect(large.rows).toBe(1020)
    expect(large.tasks).toBe(1021)
    expect(small.rollups).toBeGreaterThan(0)
    expect(large.rollups).toBe(small.rollups)
  })

  it('a child that moves among its siblings re-derives roll-ups by the burst, not the tree', async () => {
    const small = await rollupsPerBurst(250, reorder)
    const large = await rollupsPerBurst(1000, reorder)
    expect(large.rows).toBe(1000)
    expect(small.rollups).toBeGreaterThan(0)
    expect(large.rollups).toBe(small.rollups)
  })
})
