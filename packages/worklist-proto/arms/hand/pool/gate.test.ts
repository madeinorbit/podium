/**
 * POD-4578 (Ha1) — the correctness gate (L4b, `shared/src/gen/check.ts`) on
 * the pool, and the pool's own-row and one-hop fields against the legacy
 * oracle.
 *
 * GATE. Incremental versus rebuild after EVERY step, on generated sequences
 * of every change kind (the pool sees each as an upsert, a removal or a
 * `replace` on reload). `oracleEvery: 0` (coordinator ruling, a1 only): the
 * oracle compares order and roll-ups, which are the worklist phase's
 * (Hb1-Hb3). The gate's NO on this arm: the same pool planted deaf to
 * removals (the feed's `value: undefined` records dropped) must fail it, on
 * the same sequences.
 *
 * RELATIONS (POD-4579). The gated arm also holds every relation of every
 * row to a from-scratch scan (`diffRelations`, `enumerate.ts`) at every step
 * the checker compares: its `snapshot()` throws on the first relation that
 * differs, naming the step. The rebuild replays the feed through a fresh
 * engine, so it agrees with a live engine that is wrong in the same way the
 * replay is; the scan shares nothing with the engine's maintenance. Its NO:
 * the same pool planted to skip relation upkeep on every UPDATE of a row it
 * already holds (inserts and removals still maintained) must fail every seed.
 *
 * Defaults are 3 seeds x 200 steps; `POD_POOL_GATE_SEEDS=<n>` runs seeds
 * 1..n, `POD_POOL_GATE_FIRST_SEED=<k>` starts at k instead (a long run in
 * chunks), and `POD_POOL_GATE_STEPS=<n>` sets the length (`README.md`,
 * "Gates").
 *
 * FIDELITY. The fields a1 derives from the row, one hop and the locals are
 * compared with the oracle's row views (`rowViewsFromStore`) for every
 * visible row. `closed` is compared one way only (oracle closed ⇒ pool
 * closed): the pool's "nothing waiting" conjunct is the Hb3 stub. A draft's
 * title is compared only where it needs no member session: which member the
 * legacy runtime shows first is its replica order, which no pool has (the
 * pool shows the lowest session id, `views.ts`).
 */

import { describe, expect, it } from 'vitest'
import { engineLocals, openFenceFeeds } from '../../../harness/src/fence-scenarios'
import { rowViewsFromStore } from '../../../harness/src/oracle/index'
import { writeResult } from '../../../harness/src/results'
import type { CheckableArm, RowSource } from '../../../shared/src/arm'
import { countKinds, gen } from '../../../shared/src/gen/changes'
import { checkArm, describeSequence } from '../../../shared/src/gen/check'
import type { RowView } from '../../../shared/src/row-view'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import { type HandPoolHandle, handPoolArm } from './arm'
import { diffRelations } from './enumerate'

const FIRST_SEED = Number(process.env['POD_POOL_GATE_FIRST_SEED'] ?? 1)
const SEEDS = Array.from(
  { length: Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3) - FIRST_SEED + 1 },
  (_, i) => i + FIRST_SEED,
)
const STEPS = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)

/** The planted mistake: removals never reach the pool. */
function deafToRemovals(source: RowSource): RowSource {
  return {
    snapshot: (kind) => source.snapshot(kind),
    subscribe: (listener) =>
      source.subscribe((event) =>
        listener({ ...event, rows: event.rows.filter((row) => row.value !== undefined) }),
      ),
  }
}

const planted: CheckableArm = {
  create: (source, locals, reads) => handPoolArm.create(deafToRemovals(source), locals, reads),
}

/** `arm`, with every relation checked against a from-scratch scan at each snapshot. */
function relationChecked(arm: CheckableArm): CheckableArm & { snapshots: number } {
  const wrapper = {
    snapshots: 0,
    create(...args: Parameters<CheckableArm['create']>) {
      const handle = arm.create(...args) as HandPoolHandle
      return {
        ...handle,
        snapshot() {
          wrapper.snapshots += 1
          const settled = handle.snapshot()
          const diff = diffRelations(handle.pool.engine, handle.pool.tables)
          if (diff.length > 0) {
            throw new Error(
              `relations diverged from the scan (snapshot ${wrapper.snapshots}):\n${diff.join('\n')}`,
            )
          }
          return settled
        },
      }
    },
  }
  return wrapper
}

/** The relation plant: an update of a row the pool already holds maintains no relation. */
const relinkSkipped: CheckableArm = {
  create(source, locals, reads) {
    const handle = handPoolArm.create(source, locals, reads)
    const { engine } = handle.pool
    const changed = engine.changed.bind(engine)
    engine.changed = (entity, id, prev, next) => {
      if (prev !== undefined && next !== undefined) return
      changed(entity, id, prev, next)
    }
    return handle
  },
}

/** Whether `arm` fails the check on `sequence` (a divergence, or a throw from its checks). */
async function fails(
  arm: CheckableArm,
  sequence: Parameters<typeof checkArm>[1],
): Promise<number | null> {
  try {
    const result = await checkArm(arm, sequence, { oracleEvery: 0, shrink: false })
    return result.ok ? null : result.step
  } catch (error) {
    const match = /snapshot (\d+)/.exec(String(error))
    return match === null ? -1 : Number(match[1]) - 2
  }
}

describe('correctness gate (L4b), rebuild-only', () => {
  it('passes every seed, and the removal-deaf plant fails', async () => {
    const cells = []
    let plantedFailures = 0
    let relinkFailures = 0
    for (const seed of SEEDS) {
      const sequence = gen(seed, STEPS)
      const gated = relationChecked(handPoolArm)
      const result = await checkArm(gated, sequence, { oracleEvery: 0 })
      if (!result.ok) {
        throw new Error(
          `seed ${seed}: step ${result.step} diverged from the ${result.against}:\n${result.diff}\n` +
            `shrunk:\n${describeSequence(result.shrunk)}`,
        )
      }
      const plantStep = await fails(planted, sequence)
      if (plantStep !== null) plantedFailures += 1
      const relinkStep = await fails(relationChecked(relinkSkipped), sequence)
      if (relinkStep !== null) relinkFailures += 1
      cells.push({
        seed,
        steps: STEPS,
        counts: result.counts,
        relationChecks: gated.snapshots,
        kinds: countKinds(sequence),
        plantFailed: plantStep !== null,
        plantStep,
        relinkPlantFailed: relinkStep !== null,
        relinkPlantStep: relinkStep,
      })
    }
    const name = FIRST_SEED === 1 ? 'hand-pool-gate-1x' : `hand-pool-gate-1x-from-${FIRST_SEED}`
    writeResult(name, { seeds: SEEDS, steps: STEPS, cells })
    expect(plantedFailures).toBe(SEEDS.length)
    expect(relinkFailures).toBe(SEEDS.length)
  }, 3_600_000)
})

describe('own-row and one-hop fields against the oracle', () => {
  it('matches the oracle on every visible row', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = handPoolArm.create(feeds.rows.source, feeds.locals.source)
    try {
      const expected = rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx))
      const ids = Object.keys(expected)
      expect(ids.length).toBeGreaterThan(100)
      const same: (keyof RowView)[] = [
        'id',
        'displayRef',
        'band',
        'repoKey',
        'selected',
        'pinned',
        'sortKey',
        'createdAt',
        'seq',
        'foldAt',
      ]
      let closedByOracle = 0
      for (const id of ids) {
        const want = expected[id]!
        const got = handle.pool.view(id)
        expect(got, id).toBeDefined()
        for (const field of same) expect(got![field], `${id}.${field}`).toEqual(want[field])
        if (!got!.title.startsWith('New ')) expect(got!.title, `${id}.title`).toBe(want.title)
        if (want.closed) {
          closedByOracle += 1
          expect(got!.closed, `${id}.closed`).toBe(true)
        }
        if (want.originTick === null) expect(got!.originTick, `${id}.originTick`).toBeNull()
        else expect(got!.originTick?.ref, `${id}.originTick`).toBe(want.originTick.ref)
      }
      expect(closedByOracle).toBeGreaterThan(0)
      expect(ids.filter((id) => expected[id]!.originTick !== null).length).toBeGreaterThan(0)
      expect(new Set(ids.map((id) => expected[id]!.band)).size).toBeGreaterThan(1)
    } finally {
      handle.dispose()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
