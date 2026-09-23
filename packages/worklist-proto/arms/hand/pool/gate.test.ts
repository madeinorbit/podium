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
 * Defaults are 3 seeds x 200 steps; `POD_POOL_GATE_SEEDS=<n>` runs seeds
 * 1..n and `POD_POOL_GATE_STEPS=<n>` sets the length (`README.md`, "Gates").
 *
 * FIDELITY. The fields a1 derives from the row, one hop and the locals are
 * compared with the oracle's row views (`rowViewsFromStore`) for every
 * visible row. `closed` is compared one way only (oracle closed ⇒ pool
 * closed): the pool's "nothing waiting" conjunct is the Hb3 stub, and a
 * draft's title only where it does not need a member session (Ha2).
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
import { handPoolArm } from './arm'

const SEEDS = Array.from(
  { length: Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3) },
  (_, i) => i + 1,
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

describe('correctness gate (L4b), rebuild-only', () => {
  it('passes every seed, and the removal-deaf plant fails', async () => {
    const cells = []
    let plantedFailures = 0
    for (const seed of SEEDS) {
      const sequence = gen(seed, STEPS)
      const result = await checkArm(handPoolArm, sequence, { oracleEvery: 0 })
      if (!result.ok) {
        throw new Error(
          `seed ${seed}: step ${result.step} diverged from the ${result.against}:\n${result.diff}\n` +
            `shrunk:\n${describeSequence(result.shrunk)}`,
        )
      }
      const plant = await checkArm(planted, sequence, { oracleEvery: 0, shrink: false })
      if (!plant.ok) plantedFailures += 1
      cells.push({
        seed,
        steps: STEPS,
        counts: result.counts,
        kinds: countKinds(sequence),
        plantFailed: !plant.ok,
        plantStep: plant.ok ? null : plant.step,
      })
    }
    writeResult('hand-pool-gate-1x', { seeds: SEEDS, steps: STEPS, cells })
    expect(plantedFailures).toBe(SEEDS.length)
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
