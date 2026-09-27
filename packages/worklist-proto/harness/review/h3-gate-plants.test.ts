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
 *
 * THE MISS RULE (coordinator ruling on POD-4587, 2026-09-25): no seed swap
 * and no longer run. When neither the stock check nor the full-view check
 * catches a plant on a seed, the same seed runs twice side by side —
 * planted arm versus clean arm — and their whole live views must be equal
 * at every step (`differential`). That independently proves the plant never
 * changed anything the user could see on that seed; the gate's silence is
 * never the proof. Every plant must still be caught on at least 4 of the 5
 * seeds (asserted per plant).
 *
 * INERT RECORD. `activity` on seed 1: missed by both checks, proven inert
 * by the differential (planted and clean whole views equal at every step).
 * Reason: that sequence has no session change after a read, so the caching
 * plant never diverges. Generator coverage, filed as POD-4681.
 */

import { describe, expect, it } from 'vitest'
import { type HandPoolHandle, handPoolArm } from '../../arms/hand/pool/arm'
import { diffRelations, diffResidency, knownTables } from '../../arms/hand/pool/enumerate'
import type { HandPool } from '../../arms/hand/pool/pool'
import { rebuildResidentViews } from '../../arms/hand/pool/rebuild'
import type { ViewInputs } from '../../arms/hand/pool/views'
import { createEngineLocals } from '../src/engine-locals'
import type { CheckableArm, LocalsSource, RowSource } from '../../shared/src/arm'
import { gen, type Change } from '../../shared/src/gen/changes'
import { checkArm, diffViews as diffWholeViews } from '../../shared/src/gen/check'
import { startGenRun } from '../../shared/src/gen/run'
import type { RowView } from '../../shared/src/row-view'
import { type EntityName } from '../../shared/src/schema'
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
  // The hand arm's own rebuild path (`rebuild.ts`), from scratch over the
  // feed's rows — never the live pool's lazy cells. (This used to build the
  // `ViewInputs` by hand and went stale when Hb3 added `rollup`; sharing the
  // rebuild's construction keeps the probe on the current input shape.)
  return rebuildResidentViews(source, locals, resident)
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

/** Every resident issue's whole LIVE view, settling loads first (as the full-view check does). */
function liveViews(handle: HandPoolHandle): Map<string, RowView> {
  const { pool } = handle
  for (let round = 0; ; round += 1) {
    for (const id of pool.residentIssueIds()) pool.view(id)
    if (pool.pendingLoads() === 0) break
    if (round >= 64) throw new InstrumentError('differential: loads did not settle')
    handle.settleLoads()
  }
  const views = new Map<string, RowView>()
  for (const id of pool.residentIssueIds()) {
    const view = pool.view(id)
    if (view !== undefined) views.set(id, view)
  }
  return views
}

/** The live whole views after the bootstrap and every settled step, for one arm shape. */
async function recordViews(
  sequence: readonly Change[],
  plant: Plant | null,
): Promise<Map<string, RowView>[]> {
  const run = await startGenRun({ feedMode: 'overlaid' })
  let feed = run.feed()
  let locals = createEngineLocals(run.ctx.engine)
  const create = (): HandPoolHandle => {
    const handle = handPoolArm.create(feed.source, locals.source) as HandPoolHandle
    plant?.(handle.pool)
    return handle
  }
  let handle = create()
  const records: Map<string, RowView>[] = []
  try {
    locals.flush()
    records.push(liveViews(handle))
    for (const change of sequence) {
      await run.apply(change)
      if (run.feed() !== feed) {
        // A reload: a new page, so a new arm — planted again, as the gate does.
        handle.dispose()
        locals.dispose()
        feed = run.feed()
        locals = createEngineLocals(run.ctx.engine)
        handle = create()
      }
      locals.flush()
      records.push(liveViews(handle))
    }
    return records
  } finally {
    handle.dispose()
    locals.dispose()
    run.dispose()
  }
}

/**
 * The miss rule (coordinator ruling on POD-4587): when neither the stock
 * check nor the full-view check catches the plant on a seed, the SAME seed
 * runs twice side by side — planted arm versus clean arm — and their whole
 * live views must be equal at every step. That independently proves the
 * plant never changed anything the user could see on that seed. A difference
 * at any step is a real blind spot and fails.
 */
async function differential(
  seed: number,
  sequence: readonly Change[],
  plant: Plant,
): Promise<{ seed: number; inert: boolean; step: number | null; diff: string }> {
  const clean = await recordViews(sequence, null)
  const planted = await recordViews(sequence, plant)
  if (clean.length !== planted.length) {
    return {
      seed,
      inert: false,
      step: null,
      diff: `step counts differ: clean ${clean.length}, planted ${planted.length}`,
    }
  }
  for (let index = 0; index < clean.length; index += 1) {
    const want = clean[index]!
    const got = planted[index]!
    const step = index - 1
    const onlyClean = [...want.keys()].filter((id) => !got.has(id))
    const onlyPlanted = [...got.keys()].filter((id) => !want.has(id))
    if (onlyClean.length > 0 || onlyPlanted.length > 0) {
      return {
        seed,
        inert: false,
        step,
        diff:
          `step ${step}: rows only clean (${onlyClean.join(', ')}) ` +
          `vs only planted (${onlyPlanted.join(', ')})`,
      }
    }
    const diffs = diffWholeViews((id) => got.get(id), want)
    if (diffs.length > 0) return { seed, inert: false, step, diff: `step ${step}: ${diffs.join(' | ')}` }
  }
  return { seed, inert: true, step: null, diff: '' }
}

/** Thrown when this file's own check fails to run: never a catch. */
class InstrumentError extends Error {}

/** Run a check of this file's own; its crash is the instrument's, not the arm's. */
function instrument<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    throw new InstrumentError(
      `instrument crashed: ${error instanceof Error ? error.message : error}`,
    )
  }
}

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
            // Since POD-4582 the snapshot reads only the VISIBLE rows' views,
            // so a hidden resident row's view is first read here, and reading
            // it asks for its cold inputs (a ⤷ origin or member: `loading`
            // until it lands). A cell re-runs only when read, so a landing
            // that dirties a view asks for its next input on the NEXT read:
            // read every resident view and land what that queued until a
            // read queues nothing, as a list that drew those rows redraws,
            // then compare.
            for (let round = 0; ; round += 1) {
              for (const id of pool.residentIssueIds()) pool.view(id)
              if (pool.pendingLoads() === 0) break
              if (round >= 64) throw new InstrumentError('full views: loads did not settle')
              handle.settleLoads()
            }
            const views = instrument(() =>
              diffViews(pool, rebuildViews(source, locals, pool.residentIssueIds())),
            )
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

async function outcome(
  seed: number,
  arm: CheckableArm,
  sequence: readonly Change[],
): Promise<Outcome> {
  try {
    const result = await checkArm(arm, sequence, { oracleEvery: 0, shrink: false })
    if (result.ok) return { seed, caught: false, by: '-', step: null, diff: '' }
    return {
      seed,
      caught: true,
      by: result.against,
      step: result.step,
      diff: result.diff.slice(0, 300),
    }
  } catch (error) {
    // The full-view check crashing (a stale call into the shared cold rule
    // after POD-4665 did) is not the gate catching the arm (POD-4582).
    if (error instanceof InstrumentError) throw error
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

describe('the full-view instrument', () => {
  // POD-4582: after POD-4665 changed the cold rule's context, the full-view
  // check crashed on the first cold row and `outcome` recorded the TypeError
  // as the gate catching the clean arm. A crash of this file's own check
  // must fail the run instead; an arm's own throw still counts as a catch.
  function throwing(error: Error): CheckableArm {
    return {
      create(source, locals, reads) {
        const handle = handPoolArm.create(source, locals, reads)
        return {
          ...handle,
          snapshot() {
            throw error
          },
        }
      },
    }
  }

  it('a crash of the instrument is not a catch; an arm error is', async () => {
    await expect(
      outcome(1, throwing(new InstrumentError('instrument crashed: x')), gen(1, STEPS)),
    ).rejects.toBeInstanceOf(InstrumentError)
    expect(await outcome(1, throwing(new Error('[pool] order lost i1')), gen(1, STEPS))).toMatchObject({
      caught: true,
      by: '[pool]',
    })
    expect(() => instrument(() => (undefined as unknown as () => void)())).toThrow(InstrumentError)
  })
})

describe(`the hand gate's reach (${SEEDS.length} seeds x ${STEPS} steps, rebuild-only)`, () => {
  it('clean: the stock checks and the full-view check pass every seed', async () => {
    const rows = []
    for (const seed of SEEDS) {
      const full = await outcome(seed, gated(null, true), gen(seed, STEPS))
      rows.push(full)
      expect(full, `seed ${seed}`).toMatchObject({ caught: false })
    }
    report(`[h3-gate] clean full-view ${JSON.stringify(rows)}`)
  }, 3_600_000)

  for (const [name, plant] of Object.entries(PLANTS)) {
    it(`plant ${name}: the stock checks, then the full-view check on any seed they miss`, async () => {
      const rows = []
      for (const seed of SEEDS) {
        const sequence = gen(seed, STEPS)
        const stock = await outcome(seed, gated(plant, false), sequence)
        const full = stock.caught ? null : await outcome(seed, gated(plant, true), sequence)
        // A miss is proven inert by a planted-versus-clean differential over
        // the same seed — never by the gate's silence (ruling on POD-4587).
        const inert = stock.caught || full?.caught ? null : await differential(seed, sequence, plant)
        rows.push({ seed, stock, full, inert })
      }
      report(`[h3-gate] plant ${name} ${JSON.stringify(rows)}`)
      // Every seed is caught by one of the two checks, or proven inert.
      for (const row of rows) {
        expect(
          row.stock.caught || row.full?.caught || row.inert?.inert === true,
          `${name} seed ${row.seed}`,
        ).toBe(true)
      }
      // Non-vacuity: every plant is really caught on at least 4 of 5 seeds.
      if (SEEDS.length >= 4) {
        const caught = rows.filter((row) => row.stock.caught || row.full?.caught).length
        expect(caught, `${name}: caught on ${caught} of ${SEEDS.length} seeds`).toBeGreaterThanOrEqual(4)
      }
    }, 3_600_000)
  }
})
