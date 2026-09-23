/**
 * POD-4565 (Ma1) — the correctness gate (L4b, `shared/src/gen/check.ts`) on
 * the pool, and the pool's own-row fields against the legacy oracle.
 *
 * GATE. Incremental versus rebuild after EVERY step, on generated sequences
 * of every change kind (the pool sees each as an upsert, a removal or a
 * `replace` on reload). `oracleEvery: 0`: the oracle compares order and
 * roll-ups, which are the worklist phase's (Mb1-Mb3). The gate's NO on this
 * arm: the same pool planted deaf to removals (the feed's `value: undefined`
 * records dropped) must fail it, on the same sequences.
 *
 * RELATIONS (POD-4566). The gated arm also holds every relation of every row
 * to a from-scratch resolution (`diffRelations`, `enumerate.ts`) at every
 * step the checker compares: its `snapshot()` throws on the first relation
 * that differs, naming the step. The rebuild resolves relations from scratch
 * too (`rebuild.ts`), so a relation the engine gets wrong that reaches a row
 * view (`activityAt`, a draft's title) also fails the snapshot comparison.
 *
 * RESIDENCY (POD-4567). The pool holds only its resident rows, so the
 * relation check scans the FEED's current rows (`feedTables`: cold rows
 * included, which the engine links by id), and every compared step also
 * holds the hot/cold partition to the feed (`diffResidency`). The rebuild's
 * rows are the issues the rule keeps hot plus the ones the pool has loaded
 * (`rebuild.ts`). A second plant is deaf to updates of COLD rows only (a
 * cold row's reparent, removal or reopen never reaches the pool): it must
 * fail every seed too. The cells record how much each seed touched cold rows
 * (registry writes, loads, rows warmed by a reopen or removal).
 *
 * FIDELITY. The fields Ma1 derives from the row, one hop and the locals are
 * compared with the oracle's row views (`rowViewsFromStore`) for every
 * visible row. `closed` is compared one way only (oracle closed ⇒ pool
 * closed): the pool's "nothing waiting" conjunct is the Mb3 stub.
 */

import { runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { engineLocals, openFenceFeeds } from '../../../harness/src/fence-scenarios'
import { rowViewsFromStore } from '../../../harness/src/oracle/index'
import { writeResult } from '../../../harness/src/results'
import type { CheckableArm, RowSource } from '../../../shared/src/arm'
import { countKinds, gen } from '../../../shared/src/gen/changes'
import { checkArm, describeSequence } from '../../../shared/src/gen/check'
import type { RowView } from '../../../shared/src/row-view'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import { type MobxPoolHandle, mobxPoolArm } from './arm'
import { diffRelations, diffResidency, feedTables } from './enumerate'
import { installMobxWarnTrap } from './mobx-trap'
import { tracked } from './pool'

installMobxWarnTrap()

/** Three seeds by default (~8 min at load 8 with the per-step relation check); `POD_POOL_GATE_SEEDS=<n>` runs seeds 1..n. */
const SEEDS = Array.from(
  { length: Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3) },
  (_, i) => i + 1,
)
const STEPS = 200

/** The planted mistake: removals never reach the pool. */
function deafToRemovals(source: RowSource): RowSource {
  return {
    snapshot: (kind) => source.snapshot(kind),
    ...(source.row === undefined ? {} : { row: source.row.bind(source) }),
    subscribe: (listener) =>
      source.subscribe((event) =>
        listener({ ...event, rows: event.rows.filter((row) => row.value !== undefined) }),
      ),
  }
}

const planted: CheckableArm = {
  create: (source, locals, reads) => mobxPoolArm.create(deafToRemovals(source), locals, reads),
}

/** The residency plant: an update to a row the pool holds cold never reaches it. */
const coldDeaf: CheckableArm = {
  create(source, locals, reads) {
    let handle: MobxPoolHandle | null = null
    const filtered: RowSource = {
      snapshot: (kind) => source.snapshot(kind),
      ...(source.row === undefined ? {} : { row: source.row.bind(source) }),
      subscribe: (listener) =>
        source.subscribe((event) => {
          const residency = handle?.pool.residency
          if (event.type === 'replace' || residency == null) return listener(event)
          listener({
            ...event,
            rows: event.rows.filter(
              (row) => row.kind === 'worktree' || !residency.isCold(row.kind, row.id),
            ),
          })
        }),
    }
    handle = mobxPoolArm.create(filtered, locals, reads)
    return handle
  },
}

/** What the gated arms did with cold rows, summed over every arm a run created. */
interface ColdTally {
  coldWrites: number
  requests: number
  batches: number
  hydrated: number
  warmed: number
}

function emptyTally(): ColdTally {
  return { coldWrites: 0, requests: 0, batches: 0, hydrated: 0, warmed: 0 }
}

/**
 * `arm`, with every relation checked against a scan of the feed and the
 * hot/cold partition checked against the feed, at each snapshot.
 */
function checked(arm: CheckableArm): CheckableArm & { snapshots: number; cold: ColdTally } {
  const wrapper = {
    snapshots: 0,
    cold: emptyTally(),
    create(source: RowSource, ...rest: [Parameters<CheckableArm['create']>[1], Parameters<CheckableArm['create']>[2]?]) {
      const handle = arm.create(source, ...rest) as MobxPoolHandle
      const tally = (): void => {
        const counters = handle.pool.residency?.counters
        if (counters === undefined) return
        for (const key of Object.keys(wrapper.cold) as (keyof ColdTally)[]) {
          wrapper.cold[key] += counters[key]
          counters[key] = 0
        }
      }
      return {
        ...handle,
        snapshot() {
          wrapper.snapshots += 1
          const { pool } = handle
          const settled = handle.snapshot()
          // In an action, not a reaction: the check reads every relation of
          // every row, and a reaction would subscribe to all of them.
          const diff = runInAction(() => diffRelations(pool.graph, feedTables(source)))
          if (diff.length > 0) {
            throw new Error(
              `relations diverged from the scan (snapshot ${wrapper.snapshots}):\n${diff.join('\n')}`,
            )
          }
          const partition = diffResidency(pool, source)
          if (partition.length > 0) {
            throw new Error(
              `residency diverged from the feed (snapshot ${wrapper.snapshots}):\n${partition.join('\n')}`,
            )
          }
          tally()
          return settled
        },
        dispose() {
          tally()
          handle.dispose()
        },
      }
    },
  }
  return wrapper
}

const relationChecked = checked(mobxPoolArm)

/**
 * A plant's run: a checked arm's relation or partition check THROWS from its
 * snapshot, which is a detection too (the checker does not catch it).
 */
async function plantOutcome(
  arm: CheckableArm,
  sequence: ReturnType<typeof gen>,
): Promise<{ ok: true } | { ok: false; step: number | null; against: string; diff: string }> {
  try {
    const result = await checkArm(arm, sequence, { oracleEvery: 0, shrink: false })
    return result.ok
      ? { ok: true }
      : { ok: false, step: result.step, against: result.against, diff: result.diff }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const step = /snapshot (\d+)/.exec(message)
    return {
      ok: false,
      // The checker snapshots once at boot, then once per step.
      step: step === null ? null : Number(step[1]) - 2,
      against: message.startsWith('residency') ? 'partition' : 'relations',
      diff: message,
    }
  }
}

describe('correctness gate (L4b), rebuild-only', () => {
  it('passes every seed, and the removal-deaf plant fails', async () => {
    const cells = []
    let plantedFailures = 0
    let coldPlantFailures = 0
    for (const seed of SEEDS) {
      const sequence = gen(seed, STEPS)
      relationChecked.snapshots = 0
      relationChecked.cold = emptyTally()
      const result = await checkArm(relationChecked, sequence, { oracleEvery: 0 })
      expect(relationChecked.snapshots).toBeGreaterThan(STEPS)
      if (!result.ok) {
        throw new Error(
          `seed ${seed}: step ${result.step} diverged from the ${result.against}:\n${result.diff}\n` +
            `shrunk:\n${describeSequence(result.shrunk)}`,
        )
      }
      const cold = { ...relationChecked.cold }
      // The run must have exercised cold rows, or its green says nothing about them.
      expect(cold.coldWrites, `seed ${seed} touched no cold row`).toBeGreaterThan(0)
      const plant = await checkArm(planted, sequence, { oracleEvery: 0, shrink: false })
      if (!plant.ok) plantedFailures += 1
      const coldPlant = await plantOutcome(checked(coldDeaf), sequence)
      if (!coldPlant.ok) coldPlantFailures += 1
      cells.push({
        seed,
        steps: STEPS,
        counts: result.counts,
        relationChecks: relationChecked.snapshots,
        cold,
        kinds: countKinds(sequence),
        plantFailed: !plant.ok,
        plantStep: plant.ok ? null : plant.step,
        coldPlantFailed: !coldPlant.ok,
        coldPlantStep: coldPlant.ok ? null : coldPlant.step,
        coldPlantCaughtBy: coldPlant.ok ? null : coldPlant.against,
        coldPlantDiff: coldPlant.ok ? null : coldPlant.diff.split('\n').slice(0, 2).join(' | '),
      })
    }
    writeResult('mobx-pool-gate-1x', { seeds: SEEDS, cells })
    expect(plantedFailures).toBe(SEEDS.length)
    expect(coldPlantFailures).toBe(SEEDS.length)
  }, 1_500_000)
})

describe('own-row fields against the oracle', () => {
  it('matches the oracle on every visible row', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = mobxPoolArm.create(feeds.rows.source, feeds.locals.source)
    try {
      const expected = rowViewsFromStore(ctx.engine.getSnapshot(), engineLocals(ctx))
      const ids = Object.keys(expected)
      expect(ids.length).toBeGreaterThan(100)
      // Visible closed rows (the grace window, the fold) are cold: a reader
      // asks for them, and the settled snapshot loads them and what they read.
      tracked(() => {
        for (const id of ids) handle.pool.resident('issue', id)
      })
      handle.pool.snapshot()
      const actual = tracked(() =>
        Object.fromEntries(ids.map((id) => [id, handle.pool.issue(id)?.view])),
      )
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
        const got = actual[id]
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
