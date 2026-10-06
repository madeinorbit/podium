import { worklistGroups } from '@podium/client-graph/worklist/groups'
/**
 * POD-5407 — the heap census of per-cold-row structures (POD-5417 finding
 * 14): outside the row source's cold index, the pool keeps nothing per cold
 * row except what something asked about.
 *
 * WHY. The cold rule's facts used to be mirrored three times: the residency
 * registry (cold ids, declared summaries, finish bounds, member and lane
 * deadlines, `via` dependents), the relation engine's plain twins and
 * summaries, and the cold index. The pool-side copies are gone; the cold
 * index (and the relation index it holds) is the one owner. This census
 * walks everything the pool reaches (its tables, models, residency, relation
 * view, roster, MobX's own state behind them), except the cold index itself,
 * and counts every Map key or value, Set member, array element and record
 * key that is the id of a COLD row (a feed row the pool does not hold).
 *
 * WHAT IT HOLDS. The first paint (the worklist mounted, as the gate mounts
 * it) of the growth grid's base cell and of the same cell with ten times the
 * history (`GROWTH_CELLS`): the cold rows grow about tenfold, the active work
 * does not. The pool's cold-id entries must not follow the history: they are
 * the rows the first paint asked about (a visible issue's closed children,
 * the parents a nest walk reaches), which the active work decides.
 *
 * THE PLANT. A pool that registers every cold row at attach, as the former
 * registry did, must fail the bound.
 */

import { createWorklistPool, type MobxPool } from '@podium/client-graph'
import { rowViewOf } from '@podium/client-graph/models'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource } from '../../shared/src/row-source'
import { reaction, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { startEngineOnCorpus } from '../../shared/src/scenarios'
import { visibleOrderOf } from './adapters/mobx-pool'
import { buildCorpusCell, GROWTH_CELLS } from './fixture'
import { writeResult } from './results'

interface Census {
  /** Cold rows in the feed. */
  coldRows: number
  /** Cold-id entries the pool's structures hold, in all. */
  entries: number
  /** Distinct cold ids those entries name. */
  distinct: number
  /** Entries by the container's path (the first path the walk reached it by), largest first. */
  containers: [string, number][]
}

/**
 * Every cold-id entry reachable from `root`, skipping `skip` (the cold index)
 * and functions (closures are not walked; the pool keeps none per row).
 */
function walk(
  root: object,
  cold: ReadonlySet<string>,
  skip: ReadonlySet<object>,
): Omit<Census, 'coldRows'> {
  const seen = new Set<object>()
  const byContainer = new Map<string, number>()
  const ids = new Set<string>()
  let entries = 0
  const hit = (path: string, value: unknown): void => {
    if (typeof value !== 'string' || !cold.has(value)) return
    entries += 1
    ids.add(value)
    byContainer.set(path, (byContainer.get(path) ?? 0) + 1)
  }
  const queue: [object, string][] = [[root, 'pool']]
  while (queue.length > 0) {
    const [node, path] = queue.pop()!
    if (seen.has(node) || skip.has(node)) continue
    seen.add(node)
    const visit = (value: unknown, at: string): void => {
      if (typeof value === 'object' && value !== null && !seen.has(value)) queue.push([value, at])
    }
    if (node instanceof Map) {
      for (const [key, value] of node) {
        hit(path, key)
        hit(path, value)
        visit(key, `${path}{}`)
        visit(value, `${path}{}`)
      }
      continue
    }
    if (node instanceof Set) {
      for (const value of node) {
        hit(path, value)
        visit(value, `${path}[]`)
      }
      continue
    }
    if (Array.isArray(node)) {
      for (const value of node) {
        hit(path, value)
        visit(value, `${path}[]`)
      }
      continue
    }
    for (const key of Object.getOwnPropertyNames(node)) {
      let value: unknown
      try {
        const descriptor = Object.getOwnPropertyDescriptor(node, key)
        if (descriptor === undefined || descriptor.get !== undefined) continue
        value = descriptor.value
      } catch {
        continue
      }
      if (typeof value === 'function') continue
      hit(path, key)
      visit(value, `${path}.${key}`)
    }
    for (const symbol of Object.getOwnPropertySymbols(node)) {
      const value = (node as Record<symbol, unknown>)[symbol]
      if (typeof value !== 'function') visit(value, `${path}.${String(symbol)}`)
    }
  }
  return {
    entries,
    distinct: ids.size,
    containers: [...byContainer].sort((a, b) => b[1] - a[1]).slice(0, 12),
  }
}

async function census(
  cell: (typeof GROWTH_CELLS)[keyof typeof GROWTH_CELLS],
  plant?: (pool: MobxPool, cold: ReadonlySet<string>) => void,
): Promise<Census> {
  const corpus = buildCorpusCell(cell)
  const ctx = await startEngineOnCorpus(corpus)
  const feed = createRowSource(ctx.engine, ctx.replica, { mode: 'pooled' })
  const locals = createEngineLocals(ctx.engine)
  const handle = createWorklistPool(feed.source, locals.source, { schedule: () => () => {} })
  const { pool } = handle
  // The first paint, kept alive as the mounted list keeps it.
  const stop = reaction(
    () => [visibleOrderOf(pool).map((id) => rowViewOf(pool.issue(id))), worklistGroups(pool).layout],
    () => {},
  )
  try {
    const cold = new Set<string>()
    runInAction(() => {
      for (const kind of ['issue', 'session'] as const) {
        for (const record of feed.source.snapshot(kind)) {
          if (record.value !== undefined && !pool.tables[kind].has(record.id)) cold.add(record.id)
        }
      }
    })
    plant?.(pool, cold)
    const index = pool.coldIndex()
    const found = runInAction(() =>
      walk(pool, cold, new Set<object>([index, feed.source as object, feed])),
    )
    return { coldRows: cold.size, ...found }
  } finally {
    stop()
    handle.dispose()
    locals.dispose()
    feed.dispose()
    ctx.dispose()
  }
}

/** Whether `target` is reachable from `root` through fields, maps, sets and arrays. */
function reaches(root: object, target: object): boolean {
  const seen = new Set<object>()
  const queue: object[] = [root]
  while (queue.length > 0) {
    const node = queue.pop()!
    if (node === target) return true
    if (seen.has(node)) continue
    seen.add(node)
    const visit = (value: unknown): void => {
      if (typeof value === 'object' && value !== null && !seen.has(value)) queue.push(value)
    }
    if (node instanceof Map) {
      for (const [key, value] of node) {
        visit(key)
        visit(value)
      }
    } else if (node instanceof Set || Array.isArray(node)) {
      for (const value of node) visit(value)
    } else {
      for (const key of Object.getOwnPropertyNames(node)) {
        const descriptor = Object.getOwnPropertyDescriptor(node, key)
        if (descriptor !== undefined && descriptor.get === undefined) visit(descriptor.value)
      }
    }
  }
  return false
}

/** The plant: every cold row registered at attach, as the former registry did. */
function registerEveryColdRow(pool: MobxPool, cold: ReadonlySet<string>): void {
  const residency = pool.residency as unknown as { asked: Map<string, Set<string>> }
  for (const id of cold) residency.asked.get(id.startsWith('s') ? 'session' : 'issue')?.add(id)
}

describe('per-cold-row structures outside the cold index (POD-5417 finding 14)', () => {
  it('do not follow the history: base vs ten times the history', async () => {
    const base = await census(GROWTH_CELLS.base)
    const history = await census(GROWTH_CELLS.history10)
    writeResult('cold-structures', { base, history10: history })
    // The cell grows the history, so the census means something.
    expect(history.coldRows).toBeGreaterThan(5 * base.coldRows)
    // The pool's entries follow what the first paint asked about, which the
    // active work decides, never the history.
    expect(history.entries, JSON.stringify(history.containers)).toBeLessThanOrEqual(
      2 * base.entries + 50,
    )
    expect(history.distinct).toBeLessThan(history.coldRows / 10)
  }, 600_000)

  // A retired pool can outlive an account switch (POD-5402's survivors); it
  // must not keep the retired feed's cold index, which holds every row's
  // relations (+16 MiB after a rebuild switch at 1x before the fix).
  it('a disposed pool keeps no reference to the cold index', async () => {
    const corpus = buildCorpusCell(GROWTH_CELLS.base)
    const ctx = await startEngineOnCorpus(corpus)
    const feed = createRowSource(ctx.engine, ctx.replica, { mode: 'pooled' })
    const locals = createEngineLocals(ctx.engine)
    const handle = createWorklistPool(feed.source, locals.source, { schedule: () => () => {} })
    const { pool } = handle
    const index = pool.coldIndex()
    try {
      expect(reaches(pool, index)).toBe(true)
      handle.dispose()
      expect(reaches(pool, index)).toBe(false)
    } finally {
      handle.dispose()
      locals.dispose()
      feed.dispose()
      ctx.dispose()
    }
  }, 600_000)

  it('fails a pool that registers every cold row (the plant)', async () => {
    const planted = await census(GROWTH_CELLS.history10, registerEveryColdRow)
    expect(planted.distinct).toBeGreaterThanOrEqual(planted.coldRows)
    expect(planted.distinct).not.toBeLessThan(planted.coldRows / 10)
  }, 600_000)
})
