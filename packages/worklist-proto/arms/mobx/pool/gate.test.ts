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
 * relation check scans every row the pool KNOWS (`knownTables`: the feed's
 * issues and sessions, cold ones included, which the engine links by id;
 * the pool's own lanes and repos), and every compared step also
 * holds the hot/cold partition to the feed (`diffResidency`). The rebuild's
 * rows are the issues the rule keeps hot plus the ones the pool has loaded
 * (`rebuild.ts`). A second plant is deaf to updates of COLD rows only (a
 * cold row's reparent, removal or reopen never reaches the pool): it must
 * fail every seed too. The cells record how much each seed touched cold rows
 * (registry writes, loads, rows warmed by a reopen or removal).
 *
 * FULL-RESIDENCY CHECKPOINT (coordinator's safeguard). Passing the pool's
 * resident set into the rebuild lets the rebuild lean on the state it checks.
 * So at the run's last compared step the gated arm loads EVERY cold row,
 * settles, and is held, with no input from the pool, to: no row left cold (a
 * row that cannot load is one the pool should have forgotten), every relation
 * against a scan, and its snapshot against a rebuild with every row resident.
 * It runs at the last step because loading everything ends the run's cold
 * state, and not at a reload because the checker has already replaced the
 * engine by the time it disposes the old arm (its feed is dead).
 *
 * THE PLANTS, each of which must fail every seed:
 * - `planted`: deaf to removals (Ma1's; the rebuild catches it).
 * - `coldDeaf`: an update to a row the pool holds cold never reaches it.
 * - `coldRelinkSkipped`: a cold row's update skips relation maintenance only.
 *   Checked per step with the checkpoint OFF: the per-step relation check,
 *   which reads no residency from the pool, must catch a relation error
 *   confined to cold rows. (The checkpoint cannot: loading a row relinks it
 *   from its current value, so this error heals when everything loads.)
 * - `promoteSkipped`: a SESSION that becomes resident keeps its relation
 *   slots in the plain twins. Checked with the per-step checks OFF: the
 *   checkpoint alone must catch it. Sessions only since the POD-4568 rework
 *   (M3 F2): the row views now read the engine's `issue.repo` forward slot,
 *   so an issue's skipped promotion breaks `displayRef` and the per-step
 *   rebuild catches it first (all three seeds of the default run, e.g. seed 1
 *   `i168: displayRef "#169" (expected "POD-169")`). No view reads a
 *   session's forward slots, so the checkpoint stays the only catcher.
 * The cells count cold-row work AFTER each bootstrap and before the
 * checkpoint: registry writes (a cold row's update, insert or removal), loads
 * on access, rows warmed by a reopen or removal.
 *
 * FIDELITY. The fields Ma1 derives from the row, one hop and the locals, and
 * the roll-ups Mb3 derives (`phase`, progress, `working`, `asking`,
 * `workingSince`, and `closed` / `dismissed` with their "nothing waiting"
 * conjunct), are compared with the oracle's row views (`rowViewsFromStore`)
 * for every visible row.
 */

import { runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { engineLocals, openFenceFeeds } from '../../../harness/src/fence-scenarios'
import { rowViewsFromStore, snapshotFromStore } from '../../../harness/src/oracle/index'
import { writeResult } from '../../../harness/src/results'
import type { CheckableArm, RowSource } from '../../../shared/src/arm'
import { countKinds, gen } from '../../../shared/src/gen/changes'
import { checkArm, describeSequence, diffSnapshots } from '../../../shared/src/gen/check'
import type { RowView } from '../../../shared/src/row-view'
import { startScenarioEngine } from '../../../shared/src/scenarios'
import { type MobxPoolHandle, mobxPoolArm } from './arm'
import { diffRelations, diffResidency, knownTables } from './enumerate'
import { installMobxWarnTrap } from './mobx-trap'
import { tracked } from './pool'
import { rebuildSnapshot } from './rebuild'
import { acceptUnscannedGap } from './worklist/known-gaps'

installMobxWarnTrap()

/**
 * Three seeds of 200 steps by default (~8 min at load 8 with the per-step
 * relation check); `POD_POOL_GATE_SEEDS=<n>` runs seeds 1..n and
 * `POD_POOL_GATE_STEPS=<n>` sets the steps per seed. The gate of record
 * (POD-4568) is 20 x 300: `docs/measurements/POD-4568-a.md` has the command.
 */
const SEEDS = Array.from(
  { length: Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3) },
  (_, i) => i + 1,
)
const STEPS = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)
/**
 * 5 s per seed-step (was 2.5 s): since Mb3 (POD-4571) every snapshot and
 * every rebuild of the five arms per seed also derives the roll-ups, and the
 * gate's arms are unobserved, so each snapshot re-derives them. At load ~9
 * the default 3 x 200 ran past the old 25 min.
 */
const GATE_TIMEOUT_MS = Math.max(1_500_000, SEEDS.length * STEPS * 5_000)

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

/**
 * The checkpoint's plant: once bootstrapped, a COLD row's update skips
 * relation maintenance (its registry entry still moves). Nothing else.
 */
const coldRelinkSkipped: CheckableArm = {
  create(source, locals, reads) {
    const handle = mobxPoolArm.create(source, locals, reads)
    const { graph, residency } = handle.pool
    const changed = graph.changed.bind(graph)
    graph.changed = (entity, id, prev, next) => {
      if (residency?.isCold(entity, id) === true && next !== undefined) return
      changed(entity, id, prev, next)
    }
    return handle
  },
}

/** The checkpoint's plant: resident sessions keep their relation slots plain. */
const promoteSkipped: CheckableArm = {
  create(source, locals, reads) {
    const handle = mobxPoolArm.create(source, locals, reads)
    const graph = handle.pool.graph as unknown as {
      promote: (entity: string, id: string) => void
    }
    const promote = graph.promote.bind(graph)
    graph.promote = (entity, id) => {
      if (entity !== 'session') promote(entity, id)
    }
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
  /** Full-residency checkpoints passed. */
  checkpoints: number
}

function emptyTally(): ColdTally {
  return { coldWrites: 0, requests: 0, batches: 0, hydrated: 0, warmed: 0, checkpoints: 0 }
}

/**
 * The full-residency checkpoint: load every cold row, settle, then hold the
 * pool to the feed with no input from the pool. Throws on any difference.
 */
function fullResidencyCheck(
  handle: MobxPoolHandle,
  source: RowSource,
  locals: Parameters<CheckableArm['create']>[1],
  label: string,
): void {
  const { pool } = handle
  const residency = pool.residency
  if (residency === null) throw new Error(`${label}: the pool has no residency`)
  for (const entity of ['issue', 'session'] as const) {
    for (const id of residency.ids(entity)) residency.request(entity, id)
  }
  pool.hydrate()
  const settled = pool.snapshot()
  const left = [...residency.ids('issue'), ...residency.ids('session')]
  if (left.length > 0) {
    throw new Error(
      `full residency (${label}): ${left.length} rows never loaded: ${left.slice(0, 6).join(', ')}`,
    )
  }
  const relations = runInAction(() => diffRelations(pool.graph, knownTables(pool, source)))
  if (relations.length > 0) {
    throw new Error(`full residency (${label}): relations diverged:\n${relations.join('\n')}`)
  }
  const diff = diffSnapshots(settled, rebuildSnapshot(source, locals))
  if (diff !== null) throw new Error(`full residency (${label}): snapshot diverged:\n${diff}`)
}

/**
 * `arm`, with every relation checked against a scan of the feed and the
 * hot/cold partition checked against the feed, at each snapshot.
 */
function checked(
  arm: CheckableArm,
  checks: { perStep: boolean; full: boolean } = { perStep: true, full: true },
): CheckableArm & { snapshots: number; cold: ColdTally } {
  const wrapper = {
    snapshots: 0,
    cold: emptyTally(),
    create(
      source: RowSource,
      locals: Parameters<CheckableArm['create']>[1],
      reads?: Parameters<CheckableArm['create']>[2],
    ) {
      const handle = arm.create(source, locals, reads) as MobxPoolHandle
      const tally = (count = true): void => {
        const counters = handle.pool.residency?.counters
        if (counters === undefined) return
        for (const key of Object.keys(counters) as (keyof typeof counters)[]) {
          if (count) wrapper.cold[key] += counters[key]
          counters[key] = 0
        }
      }
      // The bootstrap's registrations are the bootstrap test's, not the run's.
      tally(false)
      return {
        ...handle,
        snapshot() {
          wrapper.snapshots += 1
          const { pool } = handle
          // The checker snapshots once at boot and once per step.
          if (checks.full && wrapper.snapshots === STEPS + 1) {
            tally()
            fullResidencyCheck(handle, source, locals, `step ${STEPS - 1}`)
            tally(false)
            wrapper.cold.checkpoints += 1
          }
          const settled = handle.snapshot()
          if (!checks.perStep) return settled
          // In an action, not a reaction: the check reads every relation of
          // every row, and a reaction would subscribe to all of them.
          const diff = runInAction(() => diffRelations(pool.graph, knownTables(pool, source)))
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

/** Which check caught a plant, from the error it threw. */
function caughtBy(message: string): string {
  if (message.startsWith('full residency')) return 'checkpoint'
  if (message.startsWith('residency')) return 'partition'
  return 'relations'
}

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
      against: caughtBy(message),
      diff: message,
    }
  }
}

describe('correctness gate (L4b), rebuild-only', () => {
  it(
    'passes every seed, and the removal-deaf plant fails',
    async () => {
      const cells = []
      let plantedFailures = 0
      let coldPlantFailures = 0
      let checkpointPlantFailures = 0
      let relinkPlantFailures = 0
      for (const seed of SEEDS) {
        const sequence = gen(seed, STEPS)
        relationChecked.snapshots = 0
        relationChecked.cold = emptyTally()
        const result = await checkArm(relationChecked, sequence, { oracleEvery: 0 })
        if (!result.ok) {
          throw new Error(
            `seed ${seed}: step ${result.step} diverged from the ${result.against}:\n${result.diff}\n` +
              `shrunk:\n${describeSequence(result.shrunk)}`,
          )
        }
        expect(relationChecked.snapshots).toBeGreaterThan(STEPS)
        const cold = { ...relationChecked.cold }
        // The run must have exercised cold rows, or its green says nothing about them.
        expect(cold.coldWrites, `seed ${seed} touched no cold row`).toBeGreaterThan(0)
        expect(cold.checkpoints, `seed ${seed} ran no full-residency checkpoint`).toBeGreaterThan(0)
        const plant = await checkArm(planted, sequence, { oracleEvery: 0, shrink: false })
        if (!plant.ok) plantedFailures += 1
        const coldPlant = await plantOutcome(checked(coldDeaf), sequence)
        if (!coldPlant.ok) coldPlantFailures += 1
        const relinkPlant = await plantOutcome(
          checked(coldRelinkSkipped, { perStep: true, full: false }),
          sequence,
        )
        if (!relinkPlant.ok && relinkPlant.against === 'relations') relinkPlantFailures += 1
        const checkpointPlant = await plantOutcome(
          checked(promoteSkipped, { perStep: false, full: true }),
          sequence,
        )
        if (!checkpointPlant.ok && checkpointPlant.against === 'checkpoint')
          checkpointPlantFailures += 1
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
          relinkPlantFailed: !relinkPlant.ok,
          relinkPlantStep: relinkPlant.ok ? null : relinkPlant.step,
          relinkPlantCaughtBy: relinkPlant.ok ? null : relinkPlant.against,
          relinkPlantDiff: relinkPlant.ok
            ? null
            : relinkPlant.diff.split('\n').slice(0, 2).join(' | '),
          checkpointPlantFailed: !checkpointPlant.ok,
          checkpointPlantCaughtBy: checkpointPlant.ok ? null : checkpointPlant.against,
          checkpointPlantDiff: checkpointPlant.ok
            ? null
            : checkpointPlant.diff.split('\n').slice(0, 2).join(' | '),
        })
      }
      writeResult(`mobx-pool-gate-1x-${SEEDS.length}x${STEPS}`, {
        seeds: SEEDS,
        steps: STEPS,
        cells,
      })
      expect(plantedFailures).toBe(SEEDS.length)
      expect(coldPlantFailures).toBe(SEEDS.length)
      expect(relinkPlantFailures).toBe(SEEDS.length)
      expect(checkpointPlantFailures).toBe(SEEDS.length)
    },
    GATE_TIMEOUT_MS,
  )
})

describe('row fields against the oracle', () => {
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
        // Mb3's roll-ups (POD-4571).
        'phase',
        'progressDone',
        'progressTotal',
        'working',
        'asking',
        'workingSince',
        'closed',
        'dismissed',
      ]
      let closedByOracle = 0
      // POD-4671 (`worklist/known-gaps.ts`): the unscanned-worktree orphan has
      // no seat in the schema's R3 relation; its issue's seat-fed fields are
      // left out here, and the exception itself throws once the seat exists.
      const snapshot = handle.pool.snapshot()
      const gap = acceptUnscannedGap(ctx.corpus, handle.pool, snapshotFromStore(ctx.engine.getSnapshot(), { selectedIssueId: null, coarseNow: engineLocals(ctx).coarseNow }), snapshot).applied
      for (const id of ids) {
        const want = expected[id]!
        const got = actual[id]
        expect(got, id).toBeDefined()
        for (const field of same) {
          if (id === gap && (field === 'phase' || field === 'working' || field === 'asking' || field === 'workingSince')) continue
          expect(got![field], `${id}.${field}`).toEqual(want[field])
        }
        if (!got!.title.startsWith('New ')) expect(got!.title, `${id}.title`).toBe(want.title)
        if (want.closed) closedByOracle += 1
        expect(got!.loading, `${id}.loading`).toBeUndefined()
        if (want.originTick === null) expect(got!.originTick, `${id}.originTick`).toBeNull()
        else expect(got!.originTick?.ref, `${id}.originTick`).toBe(want.originTick.ref)
      }
      expect(closedByOracle).toBeGreaterThan(0)
      // Every roll-up value the fixture can show is exercised.
      expect(new Set(ids.map((id) => expected[id]!.phase)).size).toBe(4)
      expect(ids.some((id) => expected[id]!.asking && expected[id]!.working)).toBe(true)
      expect(ids.some((id) => expected[id]!.progressTotal > 1)).toBe(true)
      expect(ids.filter((id) => expected[id]!.originTick !== null).length).toBeGreaterThan(0)
      expect(new Set(ids.map((id) => expected[id]!.band)).size).toBeGreaterThan(1)
    } finally {
      handle.dispose()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
