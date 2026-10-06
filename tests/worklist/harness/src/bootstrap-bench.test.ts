import { worklistGroups } from '@podium/client-graph/worklist/groups'
/**
 * POD-4934 — the bootstrap bench both pool arms run through, in the node
 * lane: bootstrap wall, retained heap after bootstrap, and first-paint time,
 * hand against MobX, interleaved, at 1x and 4x.
 *
 * Each round boots one arm over the same replay feed (`buildCorpus`), then
 * paints the census's 20-row window without React (the same watchers
 * `tracking-counts.test.ts` counts: one reaction per `observer` for MobX,
 * one subscription per `useSyncExternalStore` for hand), then disposes. Per
 * round and arm: the bootstrap wall (`create()` to a bootstrapped pool), the
 * retained heap (GC, `heapUsed`, boot, GC, `heapUsed` again: the difference),
 * and the first-paint wall (the window's watchers established and first
 * run). Arms interleave with the order rotated per round; every sample
 * records the 1-minute load and the process uptime. A cell whose load
 * exceeded 8 at any sample is FAILED and carries no summary (the
 * methodology's load rule); walls are evidence only from a passing cell.
 *
 * WALLS (`POD_POOL_BOOT_WALLS=1` only): 20 rounds per arm and scale, so the
 * p95 (nearest-rank) is never the max. Median is the middle average. Without
 * the flag the bench boots and paints each arm once as a smoke check. Take
 * `podium lock acquire bench:flatblock` around the walls run, as the
 * per-arm bootstrap tests do.
 */

import { loadavg } from 'node:os'
import { autorun } from 'mobx'
import { describe, expect, it } from 'vitest'
import { MobxPool } from '@podium/client-graph/pool'
import { installMobxWarnTrap } from './mobx-trap'
import { HandPool } from '../../arms/hand/pool/pool'
import { handPoolArm } from '../../arms/hand/pool/arm'
import { DISABLED_READ_FENCE } from '../../shared/src/instrument/reads'
import { settableLocals } from '@podium/client-graph/shared/locals-source'
import { ROW_DISPLAYED_FIELDS } from '@podium/client-graph/shared/row-view'
import type { RowRecord } from '../../shared/src/stats'
import { harnessMobxPoolArm } from './adapters/mobx-pool'
import { createReplaySource } from './count-harness'
import { buildCorpus } from './fixture/index'
import { writeResult } from './results'

installMobxWarnTrap()

const WALLS = process.env['POD_POOL_BOOT_WALLS'] === '1'
const ROUNDS = 20
const LOAD_LIMIT = 8
const SCALES = [1, 4] as const
const WINDOW_ROWS = 20

type Arm = 'mobx' | 'hand'

function feedOf(scale: 1 | 4) {
  const corpus = buildCorpus(scale)
  const rows: { issues: RowRecord[]; sessions: RowRecord[]; worktrees: RowRecord[] } = {
    issues: corpus.sliceIssues.map((value) => ({ kind: 'issue', id: value.id, value })),
    sessions: corpus.sliceSessions.map((value) => ({
      kind: 'session',
      id: value.sessionId,
      value,
    })),
    worktrees: corpus.sliceWorktrees.map((value) => ({ kind: 'worktree', id: value.path, value })),
  }
  return { corpus, replay: createReplaySource(rows) }
}

/** The load window never closes: what is timed is the bootstrap, before loads. */
const NEVER_LOAD = { schedule: () => () => {} } as const

/** The live pool of one bootstrap (the caller paints, then disposes). */
function bootPool(
  arm: Arm,
  feed: ReturnType<typeof feedOf>,
): { pool: MobxPool | HandPool; dispose(): void } {
  const locals = settableLocals({ selectedIssueId: null, coarseNow: feed.corpus.fixedNow })
  if (arm === 'mobx') {
    const handle = harnessMobxPoolArm.create(
      feed.replay.source,
      locals.source,
      DISABLED_READ_FENCE,
      NEVER_LOAD,
    )
    return { pool: handle.pool, dispose: () => handle.dispose() }
  }
  const handle = handPoolArm.create(
    feed.replay.source,
    locals.source,
    DISABLED_READ_FENCE,
    NEVER_LOAD,
  )
  return { pool: handle.pool, dispose: () => handle.dispose() }
}

/**
 * The MobX window's observers, as reactions (the census's first paint,
 * `arms/mobx/pool/tracking-counts.test.ts`): the list, each header in the
 * window, and per row its slot, shell and row. Returns the stops.
 */
function paintMobx(pool: MobxPool): () => void {
  const stops: (() => void)[] = []
  const items: ({ kind: 'row'; id: string } | { kind: 'header'; key: string })[] = []
  stops.push(
    autorun(
      () => {
        items.length = 0
        const groups = worklistGroups(pool)
        for (const id of groups.pinnedIds) items.push({ kind: 'row', id })
        for (const key of groups.keys) {
          const group = groups.group(key)
          items.push({ kind: 'header', key })
          for (const id of group.rowIds) items.push({ kind: 'row', id })
          for (const id of group.closedIds) items.push({ kind: 'row', id })
        }
      },
      { name: 'paint.list' },
    ),
  )
  let rows = 0
  for (const item of items) {
    if (rows === WINDOW_ROWS) break
    if (item.kind === 'header') {
      stops.push(
        autorun(
          () => {
            const group = worklistGroups(pool).group(item.key)
            void group.label
            void group.rowIds.length
            void group.closedIds.length
          },
          { name: `paint.header.${item.key}` },
        ),
      )
      continue
    }
    rows += 1
    const { id } = item
    stops.push(
      autorun(
        () => {
          if (pool.issue(id) === undefined) void pool.resident('issue', id)
        },
        { name: `paint.slot.${id}` },
      ),
    )
    const model = pool.issue(id)
    if (model !== undefined) {
      stops.push(autorun(() => void model.inMemory, { name: `paint.shell.${id}` }))
      stops.push(
        autorun(
          () => {
            if (!model.inMemory) return
            void model.id
            for (const field of ROW_DISPLAYED_FIELDS) void model[field]
          },
          { name: `paint.row.${id}` },
        ),
      )
    }
  }
  expect(rows, 'the window is full').toBe(WINDOW_ROWS)
  return () => {
    for (const stop of stops) stop()
  }
}

/**
 * The hand window's watchers, as subscriptions (the census's first paint,
 * `arms/hand/pool/tracking-counts.test.ts`): the list, each header in the
 * window, and per row its slot plus the drawn fields. Returns the stops.
 */
function paintHand(pool: HandPool): () => void {
  const stops: (() => void)[] = []
  stops.push(pool.subscribeGroups(() => {}))
  const items: ({ kind: 'row'; id: string } | { kind: 'header'; key: string })[] = []
  const view = pool.groupsView()
  for (const id of view.pinnedIds) items.push({ kind: 'row', id })
  for (const key of view.keys) {
    const lanes = pool.groupLanes(key)
    items.push({ kind: 'header', key })
    for (const id of lanes.rowIds) items.push({ kind: 'row', id })
    for (const id of lanes.closedIds) items.push({ kind: 'row', id })
  }
  let rows = 0
  for (const item of items) {
    if (rows === WINDOW_ROWS) break
    if (item.kind === 'header') {
      stops.push(pool.subscribeGroup(item.key, () => {}))
      const lanes = pool.groupLanes(item.key)
      void lanes.label
      void lanes.rowIds.length
      void lanes.closedIds.length
      continue
    }
    rows += 1
    const { id } = item
    stops.push(pool.subscribe(id, () => {}))
    const seen = pool.view(id)
    if (seen === undefined) {
      void pool.resident('issue', id)
    } else {
      const fields = seen as unknown as Record<string, unknown>
      for (const field of ROW_DISPLAYED_FIELDS) void fields[field]
    }
  }
  expect(rows, 'the window is full').toBe(WINDOW_ROWS)
  return () => {
    for (const stop of stops) stop()
  }
}

function paint(arm: Arm, pool: MobxPool | HandPool): () => void {
  return arm === 'mobx' ? paintMobx(pool as MobxPool) : paintHand(pool as HandPool)
}

/** A garbage collection, or a loud failure (heap without GC is meaningless). */
function collectGarbage(): void {
  const bunGc = (globalThis as { Bun?: { gc?: (force?: boolean) => unknown } }).Bun?.gc
  if (typeof bunGc === 'function') {
    bunGc(true)
    return
  }
  const nodeGc = (globalThis as { gc?: () => unknown }).gc
  if (typeof nodeGc === 'function') {
    nodeGc()
    return
  }
  throw new Error('[bench] no garbage collector exposed (neither Bun.gc nor global.gc)')
}

function median(sorted: readonly number[]): number {
  const mid = sorted.length / 2
  return sorted.length % 2 === 1
    ? (sorted[(sorted.length - 1) / 2] as number)
    : (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2)
}

/** Nearest-rank: with 20 samples the p95 is the 19th, never the max. */
function p95(sorted: readonly number[]): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] as number
}

interface Sample {
  bootMs: number
  heapBytes: number
  paintMs: number
  load: number
  uptime: number
}

describe('bootstrap bench: hand against MobX', () => {
  it('boots and paints each arm at 1x and 4x (walls when asked)', () => {
    const cells = []
    for (const scale of SCALES) {
      const feed = feedOf(scale)
      // Smoke, always: one bootstrap and paint per arm (the paint asserts
      // its 20-row window is full, so a broken paint fails here too).
      for (const arm of ['mobx', 'hand'] as const) {
        const { pool, dispose } = bootPool(arm, feed)
        const stop = paint(arm, pool)
        stop()
        dispose()
      }
      const cell: Record<string, unknown> = { scale }
      if (!WALLS) {
        cell['walls'] = 'not asked (POD_POOL_BOOT_WALLS=1)'
        cells.push(cell)
        continue
      }
      collectGarbage()
      const samples: Record<Arm, Sample[]> = { mobx: [], hand: [] }
      for (let round = 0; round < ROUNDS; round += 1) {
        const order: Arm[] = round % 2 === 0 ? ['mobx', 'hand'] : ['hand', 'mobx']
        for (const arm of order) {
          collectGarbage()
          const before = process.memoryUsage().heapUsed
          const started = performance.now()
          const { pool, dispose } = bootPool(arm, feed)
          const bootMs = performance.now() - started
          collectGarbage()
          const heapBytes = process.memoryUsage().heapUsed - before
          const paintStarted = performance.now()
          const stop = paint(arm, pool)
          const paintMs = performance.now() - paintStarted
          stop()
          dispose()
          samples[arm].push({
            bootMs,
            heapBytes,
            paintMs,
            load: loadavg()[0] as number,
            uptime: process.uptime(),
          })
        }
      }
      const summarize = (arm: Arm) => {
        const rounds = samples[arm]
        const by = (pick: (sample: Sample) => number): number[] =>
          rounds.map(pick).sort((a, b) => a - b)
        const boots = by((sample) => sample.bootMs)
        const heaps = by((sample) => sample.heapBytes)
        const paints = by((sample) => sample.paintMs)
        return {
          rounds: ROUNDS,
          bootMs: {
            median: median(boots),
            p95: p95(boots),
            samples: rounds.map((sample) => sample.bootMs),
          },
          heapBytes: {
            median: median(heaps),
            p95: p95(heaps),
            samples: rounds.map((sample) => sample.heapBytes),
          },
          paintMs: {
            median: median(paints),
            p95: p95(paints),
            samples: rounds.map((sample) => sample.paintMs),
          },
          loads: rounds.map((sample) => sample.load),
          uptimes: rounds.map((sample) => sample.uptime),
        }
      }
      const loads = [...samples.mobx, ...samples.hand].map((sample) => sample.load)
      const maxLoad = Math.max(...loads)
      const failed = maxLoad > LOAD_LIMIT
      cell['walls'] =
        failed || !isFinite(maxLoad)
          ? { status: `FAILED: load ${maxLoad.toFixed(2)} > ${LOAD_LIMIT}`, loads }
          : {
              status: 'ok',
              maxLoad,
              mobx: summarize('mobx'),
              hand: summarize('hand'),
            }
      cells.push(cell)
    }
    writeResult(WALLS ? 'pool-bootstrap-bench-walls' : 'pool-bootstrap-bench-smoke', { cells })
    if (WALLS) {
      for (const cell of cells) {
        const walls = cell['walls'] as { status: string }
        expect(walls.status, `scale ${String(cell['scale'])}: ${walls.status}`).toBe('ok')
      }
      console.info(`[bench] ${JSON.stringify(cells, null, 2).slice(0, 2000)}`)
    }
  }, 1_800_000)
})
