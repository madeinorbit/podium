/**
 * POD-4598 (H3) — does the hand pool's correctness gate (L4b,
 * `arms/hand/pool/gate.test.ts`) catch the round-two hand bugs (audit §3.3)
 * and the MobX gates' defect shapes (the LESSONS comment on POD-4598), if
 * they come back?
 *
 * THE CONTROL ARM is the stock gate's checks, rebuilt here because the gate
 * does not export them: `checkArm` with `oracleEvery: 0` (incremental
 * `snapshot()` against `rebuildFromScratch()` after every step), plus every
 * relation against a from-scratch scan of the feed's rows and the hot/cold
 * partition against the feed, per step.
 *
 * WHAT THE STOCK REBUILD COMPARES. The checker compares `snapshot()`, whose
 * rows are `sliceRowOf(view)` (`shared/src/row-view.ts`): id, displayRef,
 * title, phase, progress, working, asking, band, repoKey, closed. A part that
 * reaches no slice field (`activityAt`, `originTick`, `selected`, `pinned`,
 * `sortKey`, `createdAt`, `seq`, `foldAt`, `dismissed`) is never held to the
 * rebuild. So this file also runs a FULL-VIEW arm: the same checks plus, per
 * step, every resident issue's whole `RowView` against the same rule table
 * run directly over the feed's rows (`rebuild.ts`, but keeping the view).
 *
 * THE PLANTS (each applied to the pool instance; no source file is edited):
 * - `clock`: the clock moves but dirties nothing (round two's no-op
 *   `ClockChanged`).
 * - `chain`: a changed cell at level 2 or above does not dirty its readers
 *   (round two's unsound chain early-stop, in the cell graph's terms).
 * - `reseat`: a removed row takes its inverse buckets with it, so an evicted
 *   and re-added parent does not find its children (round two's re-seat bug).
 * - `activity`: `activityAt` caches each member's contribution in a plain
 *   `Map` after the first read (the MobX gate's "plain Map read inside a
 *   derivation goes deaf").
 * - `presence`: a part asks presence from the raw table, untracked (the MobX
 *   gate's "untracked presence check").
 * Order and group maintenance under batched rank moves (round two's third and
 * fifth bugs) have no code to plant into yet: the a-phase pool has no order.
 */

import { describe, expect, it } from 'vitest'
import { type HandPoolHandle, handPoolArm } from '../../arms/hand/pool/arm'
import { diffRelations, diffResidency, knownTables } from '../../arms/hand/pool/enumerate'
import type { HandPool } from '../../arms/hand/pool/pool'
import { PoolRelations } from '../../arms/hand/pool/relations'
import { createTables, ingestOut, ingestRecord } from '../../arms/hand/pool/tables'
import {
  buildRowView,
  directParts,
  type RepoRow,
  sessionActivityOf,
  type ViewInputs,
} from '../../arms/hand/pool/views'
import type { CheckableArm, LocalsSource, RowSource } from '../../shared/src/arm'
import { gen } from '../../shared/src/gen/changes'
import { checkArm } from '../../shared/src/gen/check'
import type { RowView } from '../../shared/src/row-view'
import { coldByRule, type EntityName, SCHEMA } from '../../shared/src/schema'
import type { SliceIssue, SliceSession } from '../../shared/src/slice-types'
import { report } from './h3-witness'

/** Seeds `H3_GATE_FIRST_SEED`..`H3_GATE_SEEDS` (default 1..5), so a long run can go in chunks. */
const FIRST_SEED = Number(process.env['H3_GATE_FIRST_SEED'] ?? 1)
const SEEDS = Array.from(
  { length: Number(process.env['H3_GATE_SEEDS'] ?? 5) - FIRST_SEED + 1 },
  (_, i) => i + FIRST_SEED,
)
const STEPS = Number(process.env['H3_GATE_STEPS'] ?? 300)

// ------------------------------------------------------------ full views

/** Every resident issue's whole row view, from the rule table run directly over the feed. */
function rebuildViews(
  source: RowSource,
  locals: LocalsSource,
  resident: ReadonlySet<string>,
): Map<string, RowView> {
  const tables = createTables()
  const relations = new PoolRelations({
    rows: tables,
    roots: tables,
    present: (entity, id) => tables[entity].has(id),
  })
  const target = { read: tables, write: tables, relations }
  const out = ingestOut()
  const issues = source.snapshot('issue')
  for (const record of source.snapshot('session')) ingestRecord(target, record, out)
  for (const record of issues) ingestRecord(target, record, out)
  for (const record of source.snapshot('worktree')) ingestRecord(target, record, out)
  const { coarseNow, selectedIssueId } = locals.get()
  const inputs: ViewInputs = {
    relations,
    issue: (id) => tables.issue.get(id) as SliceIssue | undefined,
    session: (id) => tables.session.get(id) as SliceSession | undefined,
    repo: (id) => tables.repo.get(id) as RepoRow | undefined,
    sessionActivity: (id) => sessionActivityOf(tables.session.get(id) as SliceSession | undefined),
    present: (entity, id) => tables[entity].has(id),
    loading: () => false,
    parts: (id) => (tables.issue.has(id) ? directParts(inputs, id) : undefined),
    selected: (id) => id === selectedIssueId,
    reached: (t) => coarseNow >= t,
    passed: (t) => coarseNow > t,
  }
  const coldTarget = (to: EntityName, id: string): boolean => {
    const row = tables[to].get(id)
    return row !== undefined && coldByRule(SCHEMA, to, row, coldTarget)
  }
  const views = new Map<string, RowView>()
  for (const { id } of issues) {
    if (!resident.has(id) && coldTarget('issue', id)) continue
    const view = buildRowView(inputs, id, directParts(inputs, id))
    if (view !== undefined) views.set(id, view)
  }
  return views
}

/** Up to 6 lines: resident issues whose live view differs from the direct one, field by field. */
function diffViews(pool: HandPool, want: Map<string, RowView>): string[] {
  const out: string[] = []
  for (const [id, expected] of want) {
    const got = pool.view(id) as Record<string, unknown> | undefined
    if (got === undefined) {
      if (out.length < 6) out.push(`${id}: live has no view`)
      continue
    }
    const want = expected as unknown as Record<string, unknown>
    for (const field of new Set([...Object.keys(want), ...Object.keys(got)])) {
      const value = want[field]
      if (JSON.stringify(got[field]) === JSON.stringify(value)) continue
      if (out.length < 6)
        out.push(
          `${id}.${field}: live ${JSON.stringify(got[field])}, direct ${JSON.stringify(value)}`,
        )
    }
  }
  return out
}

// ----------------------------------------------------------- the checks

type Plant = (pool: HandPool) => void

/** The stock gate's per-step checks around `plant`; with `fullViews`, whole row views too. */
function gated(plant: Plant | null, fullViews: boolean): CheckableArm & { snapshots: number } {
  const wrapper = {
    snapshots: 0,
    create(source: RowSource, locals: LocalsSource, reads?: Parameters<CheckableArm['create']>[2]) {
      const handle = handPoolArm.create(source, locals, reads) as HandPoolHandle
      plant?.(handle.pool)
      return {
        ...handle,
        snapshot() {
          wrapper.snapshots += 1
          const settled = handle.snapshot()
          const { pool } = handle
          const relations = diffRelations(pool.engine, knownTables(source))
          if (relations.length > 0)
            throw new Error(`relations (snapshot ${wrapper.snapshots}): ${relations.join(' | ')}`)
          const partition = diffResidency(pool, source)
          if (partition.length > 0)
            throw new Error(`partition (snapshot ${wrapper.snapshots}): ${partition.join(' | ')}`)
          if (fullViews) {
            const views = diffViews(pool, rebuildViews(source, locals, pool.residentIssueIds()))
            if (views.length > 0)
              throw new Error(`views (snapshot ${wrapper.snapshots}): ${views.join(' | ')}`)
          }
          return settled
        },
      }
    },
  }
  return wrapper
}

interface Outcome {
  seed: number
  caught: boolean
  by: string
  step: number | null
  diff: string
}

async function outcome(seed: number, arm: CheckableArm): Promise<Outcome> {
  try {
    const result = await checkArm(arm, gen(seed, STEPS), { oracleEvery: 0, shrink: false })
    if (result.ok) return { seed, caught: false, by: '-', step: null, diff: '' }
    return {
      seed,
      caught: true,
      by: result.against,
      step: result.step,
      diff: result.diff.slice(0, 300),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const step = /snapshot (\d+)/.exec(message)
    return {
      seed,
      caught: true,
      by: message.split(' ')[0] ?? '?',
      step: step === null ? null : Number(step[1]) - 2,
      diff: message.slice(0, 300),
    }
  }
}

// ---------------------------------------------------------------- plants

interface GraphInside {
  run(cell: { level: number }): void
  invalidate(cell: unknown): void
}

const PLANTS: Record<string, Plant> = {
  clock(pool) {
    const clock = pool.clock as unknown as { now: number; move(now: number): void }
    clock.move = (now) => {
      clock.now = now
    }
  },
  chain(pool) {
    const graph = pool.graph as unknown as GraphInside
    const run = graph.run.bind(graph)
    const invalidate = graph.invalidate.bind(graph)
    let changing: { level: number } | null = null
    graph.run = (cell) => {
      const outer = changing
      changing = cell
      try {
        run(cell)
      } finally {
        changing = outer
      }
    }
    graph.invalidate = (cell) => {
      if (changing !== null && changing.level >= 2) return
      invalidate(cell)
    }
  },
  reseat(pool) {
    const engine = pool.engine as unknown as {
      changed: HandPool['engine']['changed']
      links: Map<string, { spec: { to: EntityName }; buckets: Map<string, Set<string>> }>
    }
    const changed = engine.changed.bind(pool.engine)
    engine.changed = (entity, id, prev, next) => {
      changed(entity, id, prev, next)
      if (next !== undefined) return
      for (const link of engine.links.values()) if (link.spec.to === entity) link.buckets.delete(id)
    }
  },
  activity(pool) {
    const inputs = pool.inputs as { sessionActivity: (id: string) => number | null }
    const original = inputs.sessionActivity
    const cache = new Map<string, number | null>()
    inputs.sessionActivity = (id) => {
      if (cache.has(id)) return cache.get(id) as number | null
      const value = original(id)
      cache.set(id, value)
      return value
    }
  },
  presence(pool) {
    const inputs = pool.inputs as { present: ViewInputs['present'] }
    inputs.present = (entity, id) => pool.tables[entity].has(id)
  },
}

// ----------------------------------------------------------------- tests

describe(`the hand gate's reach (${SEEDS.length} seeds x ${STEPS} steps, rebuild-only)`, () => {
  it('clean: the stock checks and the full-view check pass every seed', async () => {
    const rows = []
    for (const seed of SEEDS) {
      const full = await outcome(seed, gated(null, true))
      rows.push(full)
      expect(full, `seed ${seed}`).toMatchObject({ caught: false })
    }
    report(`[h3-gate] clean full-view ${JSON.stringify(rows)}`)
  }, 3_600_000)

  for (const [name, plant] of Object.entries(PLANTS)) {
    it(`plant ${name}: the stock checks, then the full-view check on any seed they miss`, async () => {
      const rows = []
      for (const seed of SEEDS) {
        const stock = await outcome(seed, gated(plant, false))
        const full = stock.caught ? null : await outcome(seed, gated(plant, true))
        rows.push({ seed, stock, full })
      }
      report(`[h3-gate] plant ${name} ${JSON.stringify(rows)}`)
      // Every seed is caught by one of the two; the doc records which.
      for (const row of rows) {
        expect(row.stock.caught || row.full?.caught, `${name} seed ${row.seed}`).toBe(true)
      }
    }, 3_600_000)
  }
})
