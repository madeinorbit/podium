import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
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
 * WHOLE VIEWS (POD-4674, H3-F3). The checker compares `snapshot()`, whose
 * rows are `sliceRowOf(view)`: the 11 slice fields. `activityAt`,
 * `originTick`, `selected`, `pinned`, `sortKey`, `createdAt`, `seq`, `foldAt`
 * and `dismissed` reach none of them, so the rebuild alone holds them to
 * nothing. Every compared step also holds every visible issue's whole
 * `RowView` to the same rule table run directly over the feed's rows
 * (`rebuildViews`), field by field (the shared `diffViews`, `check.ts`). Its NO: member activity
 * cached in a plain `Map`, which the rebuild and the scans all miss.
 *
 * RESIDENCY (POD-4580, Ha3). The pool holds only its resident rows, so the
 * relation check scans every row the pool KNOWS (`knownTables`: the feed's
 * rows, cold ones included, which the engine links by id), and every compared
 * step also holds the hot/cold partition to the feed (`diffResidency`). The
 * rebuild's rows are the issues the rule keeps hot plus the ones the pool has
 * loaded (`rebuild.ts`).
 *
 * FULL-RESIDENCY CHECKPOINT (the coordinator's safeguard, as in Ma3). Passing
 * the pool's resident set into the rebuild lets the rebuild lean on the state
 * it checks. So at the run's last compared step the gated arm loads EVERY
 * cold row, settles, and is held, with no input from the pool, to: no row
 * left cold, every relation against a scan, and its snapshot against a
 * rebuild with every row resident. It runs at the last step because loading
 * everything ends the run's cold state.
 *
 * THE PLANTS, each of which must fail every seed:
 * - `activityCached`: each member's `activityAt` contribution cached in a
 *   plain `Map` after its first read (the MobX gates' deaf plain-Map read,
 *   H3's `activity` plant). No slice field and no relation moves, so only
 *   the per-step view check can catch it; it must be the one that does.
 * - `chainCut` and `presenceUntracked` (H3's `chain` and `presence`
 *   plants, `harness/review/h3-gate-plants.test.ts`): a changed cell at
 *   level >= 2 dirties none of its readers; a part asks presence from the raw
 *   table, untracked. Both passed the stock checks before the view check; the
 *   cell records which check catches each now.
 * - `planted`: deaf to removals (Ha1's; the rebuild catches it).
 * - `relinkSkipped`: an update of a row the pool HOLDS maintains no relation
 *   (Ha2's; the per-step relation check).
 * - `coldDeaf`: an update to a row the pool holds cold never reaches it.
 * - `coldRelinkSkipped`: a cold row's update skips relation maintenance only.
 *   Checked per step with the checkpoint OFF: the per-step relation check,
 *   which reads no residency from the pool, must catch a relation error
 *   confined to cold rows. (The checkpoint cannot: loading a row relinks it
 *   from its current value, so this error heals when everything loads.)
 * - `registryKept`: a SESSION loaded on access is installed but keeps its
 *   cold-registry entry (a promotion done by half: the hand pool has no
 *   relation twins to promote, so this is its error that survives loading).
 *   Checked with the per-step relation and partition checks OFF: the
 *   checkpoint must catch it (a row that never leaves the registry). The
 *   per-step rebuild cannot: the row's data is resident, and the stray
 *   `loading` flag is not a slice field. Session loads happen on every seed
 *   (loaded closed origins read their sessions), so the plant always fires;
 *   the first version (a cold session's update forgotten) did not fire on
 *   seed 5 of the 20 x 300 run, whose last arm saw no such update.
 * The cells count cold-row work AFTER each bootstrap and before the
 * checkpoint: registry writes, loads on access, rows warmed by a reopen or
 * removal.
 *
 * Defaults are 3 seeds x 200 steps; the gate of record is 20 x 300 (Ma4's
 * lesson: 3 x 200 missed a relation bug seed 8 found); `POD_POOL_GATE_SEEDS=<n>` runs seeds
 * 1..n, `POD_POOL_GATE_FIRST_SEED=<k>` starts at k instead (a long run in
 * chunks), and `POD_POOL_GATE_STEPS=<n>` sets the length (`README.md`,
 * "Gates").
 *
 * FIDELITY (POD-4714). Every `RowView` field (`ROW_VIEW_FIELDS`,
 * `shared/src/row-view.ts`) is compared with the oracle's row views
 * (`rowViewsFromStore`) for every visible row, except the `ORACLE_EXEMPT`
 * list below, each entry with its reason (`title` draft variance,
 * `originTick` title variance with ref + null-ness still held, `loading` with
 * no oracle counterpart checked as undefined). A new contract field is
 * compared by default: the exhaustiveness test fails until it is.
 */

import { describe, expect, it } from 'vitest'
import { engineLocals, openFenceFeeds, parityLocals } from '../../../harness/src/fence-scenarios'
import {
  legacyDerivationFromStore,
  rowViewsFromStore,
  visibleIssueRows,
} from '../../../harness/src/oracle/index'
import { writeResult } from '../../../harness/src/results'
import type { CheckableArm, RowSource } from '../../../shared/src/arm'
import { countKinds, gen } from '../../../shared/src/gen/changes'
import { checkArm, describeSequence, diffSnapshots, diffViews } from '../../../shared/src/gen/check'
import { ROW_VIEW_FIELDS, type RowView } from '@podium/client-graph/shared/row-view'
import { type ScenarioEngine, startScenarioEngine } from '../../../shared/src/scenarios'
import { harnessHandPoolArm, snapshotPool, type HarnessHandPoolHandle } from '../../../harness/src/adapters/hand-pool'
import { diffRelations, diffResidency, knownTables } from './enumerate'
import { rebuildSnapshot, rebuildViews } from './rebuild'
import type { Residency } from './residency'
import { VISIBLE_RULES, type VisibleInputs, type VisibleParts } from './worklist/visible'

const FIRST_SEED = Number(process.env['POD_POOL_GATE_FIRST_SEED'] ?? 1)
const SEEDS = Array.from(
  { length: Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3) - FIRST_SEED + 1 },
  (_, i) => i + FIRST_SEED,
)
const STEPS = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)
/** 2.5 s per seed-step, never under 25 min. */
const GATE_TIMEOUT_MS = Math.max(1_500_000, SEEDS.length * STEPS * 2_500)

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
  create: (source, locals, reads) => harnessHandPoolArm.create(deafToRemovals(source), locals, reads),
}

/** The relation plant: an update of a row the pool already holds maintains no relation. */
const relinkSkipped: CheckableArm = {
  create(source, locals, reads) {
    const handle = harnessHandPoolArm.create(source, locals, reads)
    const { engine } = handle.pool
    const changed = engine.changed.bind(engine)
    engine.changed = (entity, id, prev, next) => {
      if (prev !== undefined && next !== undefined) return
      changed(entity, id, prev, next)
    }
    return handle
  },
}

/** The residency plant: an update to a row the pool holds cold never reaches it. */
const coldDeaf: CheckableArm = {
  create(source, locals, reads) {
    let handle: HarnessHandPoolHandle | null = null
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
              (row) =>
                row.kind === 'worktree' ||
                row.kind === 'machine' ||
                row.kind === 'repo' ||
                !residency.isCold(row.kind, row.id),
            ),
          })
        }),
    }
    handle = harnessHandPoolArm.create(filtered, locals, reads)
    return handle
  },
}

/** Once bootstrapped, a COLD row's update skips relation maintenance (its registry entry still moves). */
const coldRelinkSkipped: CheckableArm = {
  create(source, locals, reads) {
    const handle = harnessHandPoolArm.create(source, locals, reads)
    const { engine, residency } = handle.pool
    const changed = engine.changed.bind(engine)
    engine.changed = (entity, id, prev, next) => {
      if (residency?.isCold(entity, id) === true && next !== undefined) return
      changed(entity, id, prev, next)
    }
    return handle
  },
}

/** A session loaded on access is installed, but its registry entry stays. */
const registryKept: CheckableArm = {
  create(source, locals, reads) {
    const handle = harnessHandPoolArm.create(source, locals, reads)
    const residency = handle.pool.residency as unknown as {
      hydrate: (target: unknown, entity: string, id: string, out: unknown) => void
      unregister: (entity: string, id: string) => void
    }
    const hydrate = residency.hydrate.bind(residency)
    const unregister = residency.unregister.bind(residency)
    let loadingSession = false
    residency.unregister = (entity, id) => {
      if (!loadingSession) unregister(entity, id)
    }
    residency.hydrate = (target, entity, id, out) => {
      loadingSession = entity === 'session'
      try {
        hydrate(target, entity, id, out)
      } finally {
        loadingSession = false
      }
    }
    return handle
  },
}

/**
 * The view plant: each member's activity is cached in a plain `Map` after its
 * first read, on EVERY path that reads it — the own-row half, the subtree
 * half and the unread rollup all read the per-session cell. Caching fewer
 * paths is masked by the rest: the view is their max, and a live seat's
 * stamp reaches it through more than one (as Mb3's gate found: one path
 * alone cached passed a seed).
 */
const activityCached: CheckableArm = {
  create(source, locals, reads) {
    const handle = harnessHandPoolArm.create(source, locals, reads)
    const read = handle.pool.sessionActivity.bind(handle.pool)
    const cache = new Map<string, number | null>()
    handle.pool.sessionActivity = (id) => {
      if (!cache.has(id)) cache.set(id, read(id))
      return cache.get(id) as number | null
    }
    return handle
  },
}

/**
 * H3's chain plant: a changed cell at level 2 or above does not dirty its
 * readers (round two's unsound chain early-stop, in the cell graph's terms).
 */
const chainCut: CheckableArm = {
  create(source, locals, reads) {
    const handle = harnessHandPoolArm.create(source, locals, reads)
    const graph = handle.pool.graph as unknown as {
      run(cell: { level: number }): void
      invalidate(cell: unknown): void
    }
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
    return handle
  },
}

/** H3's presence plant: a part asks presence from the raw table, untracked. */
const presenceUntracked: CheckableArm = {
  create(source, locals, reads) {
    const handle = harnessHandPoolArm.create(source, locals, reads)
    const { pool } = handle
    const inputs = pool.inputs as { present: (entity: 'issue' | 'session', id: string) => boolean }
    inputs.present = (entity, id) => pool.tables[entity].has(id)
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
  /** Cold rows read by id without loading (POD-4582, the worklist's walks). */
  peeks: number
  /** Full-residency checkpoints passed. */
  checkpoints: number
}

function emptyTally(): ColdTally {
  return {
    coldWrites: 0,
    requests: 0,
    batches: 0,
    hydrated: 0,
    warmed: 0,
    peeks: 0,
    checkpoints: 0,
  }
}

/**
 * The full-residency checkpoint: load every cold row, settle, then hold the
 * pool to the feed with no input from the pool. Throws on any difference.
 */
function fullResidencyCheck(
  handle: HarnessHandPoolHandle,
  source: RowSource,
  locals: Parameters<CheckableArm['create']>[1],
  label: string,
): void {
  const { pool } = handle
  const residency = pool.residency as Residency
  for (const entity of ['issue', 'session'] as const) {
    for (const id of residency.ids(entity)) residency.request(entity, id)
  }
  pool.hydrate()
  const settled = snapshotPool(pool)
  const left = [...residency.ids('issue'), ...residency.ids('session')]
  if (left.length > 0) {
    throw new Error(
      `full residency (${label}): ${left.length} rows never loaded: ${left.slice(0, 6).join(', ')}`,
    )
  }
  const relations = diffRelations(pool.engine, knownTables(source))
  if (relations.length > 0) {
    throw new Error(`full residency (${label}): relations diverged:\n${relations.join('\n')}`)
  }
  const diff = diffSnapshots(settled, rebuildSnapshot(source, locals))
  if (diff !== null) throw new Error(`full residency (${label}): snapshot diverged:\n${diff}`)
}

/**
 * `arm`, with every relation checked against a scan of the feed, the
 * hot/cold partition checked against the feed, and every resident issue's
 * whole view checked against the direct rule table, in that order, at each
 * snapshot (`perStep`), and the full-residency checkpoint at the last
 * compared step (`full`).
 */
function checked(
  arm: CheckableArm,
  checks: { perStep: boolean; full: boolean } = { perStep: true, full: true },
): CheckableArm & { snapshots: number; views: number; cold: ColdTally } {
  const wrapper = {
    snapshots: 0,
    /** Whole views compared by the per-step view check. */
    views: 0,
    cold: emptyTally(),
    create(
      source: RowSource,
      locals: Parameters<CheckableArm['create']>[1],
      reads?: Parameters<CheckableArm['create']>[2],
    ) {
      const handle = arm.create(source, locals, reads) as HarnessHandPoolHandle
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
          const diff = diffRelations(pool.engine, knownTables(source))
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
          const direct = rebuildViews(source, locals)
          wrapper.views += direct.size
          const views = diffViews((id) => pool.view(id), direct)
          if (views.length > 0) {
            throw new Error(
              `row views diverged from the direct rule table (snapshot ${wrapper.snapshots}):\n${views.join('\n')}`,
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

/** Which check caught a plant, from the error it threw. */
function caughtBy(message: string): string {
  if (message.startsWith('full residency')) return 'checkpoint'
  if (message.startsWith('residency')) return 'partition'
  if (message.startsWith('row views')) return 'views'
  return 'relations'
}

/**
 * A plant's run: a checked arm's relation, partition or view check THROWS from its
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

const brief = (outcome: Awaited<ReturnType<typeof plantOutcome>>) =>
  outcome.ok
    ? { failed: false }
    : {
        failed: true,
        step: outcome.step,
        caughtBy: outcome.against,
        diff: outcome.diff.split('\n').slice(0, 2).join(' | '),
      }

describe('correctness gate (L4b), rebuild-only', () => {
  it(
    'passes every seed, and every plant fails every seed',
    async () => {
      const cells = []
      const failures = {
        planted: 0,
        relink: 0,
        coldDeaf: 0,
        coldRelink: 0,
        checkpoint: 0,
        activity: 0,
        chain: 0,
        presence: 0,
      }
      for (const seed of SEEDS) {
        const sequence = gen(seed, STEPS)
        const gated = checked(harnessHandPoolArm)
        const result = await checkArm(gated, sequence, { oracleEvery: 0 })
        expect(gated.snapshots).toBeGreaterThan(STEPS)
        // The view check compared rows at every step, or its green says nothing.
        expect(gated.views).toBeGreaterThan(gated.snapshots)
        if (!result.ok) {
          throw new Error(
            `seed ${seed}: step ${result.step} diverged from the ${result.against}:\n${result.diff}\n` +
              `shrunk:\n${describeSequence(result.shrunk)}`,
          )
        }
        const cold = { ...gated.cold }
        // The run must have exercised cold rows, or its green says nothing about them.
        expect(cold.coldWrites, `seed ${seed} touched no cold row`).toBeGreaterThan(0)
        expect(cold.checkpoints, `seed ${seed} ran no full-residency checkpoint`).toBeGreaterThan(0)
        const plant = await plantOutcome(planted, sequence)
        if (!plant.ok) failures.planted += 1
        const relink = await plantOutcome(
          checked(relinkSkipped, { perStep: true, full: false }),
          sequence,
        )
        if (!relink.ok) failures.relink += 1
        const deaf = await plantOutcome(checked(coldDeaf), sequence)
        if (!deaf.ok) failures.coldDeaf += 1
        const coldRelink = await plantOutcome(
          checked(coldRelinkSkipped, { perStep: true, full: false }),
          sequence,
        )
        if (!coldRelink.ok && coldRelink.against === 'relations') failures.coldRelink += 1
        const kept = await plantOutcome(
          checked(registryKept, { perStep: false, full: true }),
          sequence,
        )
        if (!kept.ok && kept.against === 'checkpoint') failures.checkpoint += 1
        const activity = await plantOutcome(checked(activityCached), sequence)
        if (!activity.ok && activity.against === 'views') failures.activity += 1
        const chain = await plantOutcome(checked(chainCut), sequence)
        if (!chain.ok) failures.chain += 1
        const presence = await plantOutcome(checked(presenceUntracked), sequence)
        if (!presence.ok) failures.presence += 1
        cells.push({
          seed,
          steps: STEPS,
          counts: result.counts,
          relationChecks: gated.snapshots,
          viewsCompared: gated.views,
          cold,
          kinds: countKinds(sequence),
          plants: {
            removalDeaf: brief(plant),
            relinkSkipped: brief(relink),
            coldDeaf: brief(deaf),
            coldRelinkSkipped: brief(coldRelink),
            registryKept: brief(kept),
            activityCached: brief(activity),
            chainCut: brief(chain),
            presenceUntracked: brief(presence),
          },
        })
      }
      const name =
        FIRST_SEED === 1
          ? `hand-pool-gate-1x-${SEEDS.length}x${STEPS}`
          : `hand-pool-gate-1x-${SEEDS.length}x${STEPS}-from-${FIRST_SEED}`
      writeResult(name, { seeds: SEEDS, steps: STEPS, cells })
      expect(failures).toEqual({
        planted: SEEDS.length,
        relink: SEEDS.length,
        coldDeaf: SEEDS.length,
        coldRelink: SEEDS.length,
        checkpoint: SEEDS.length,
        activity: SEEDS.length,
        chain: SEEDS.length,
        presence: SEEDS.length,
      })
    },
    GATE_TIMEOUT_MS,
  )
})

/** Mutant A: the old own half (every explicit session, not the retained seats). */
const oldHalfArm: CheckableArm = {
  create(source, locals, reads) {
    const handle = harnessHandPoolArm.create(source, locals, reads) as HarnessHandPoolHandle
    const inputs = handle.pool.inputs as {
      retainedSeats(id: string): readonly string[]
    }
    inputs.retainedSeats = (id) => handle.pool.cellsOf(id).sessionIds
    return handle
  },
}

/** Mutant B: no subtree raise (the roll-up's `seatActivity` nulled). */
const noRaiseArm: CheckableArm = {
  create(source, locals, reads) {
    const handle = harnessHandPoolArm.create(source, locals, reads) as HarnessHandPoolHandle
    const inputs = handle.pool.inputs
    const rollup = inputs.rollup
    inputs.rollup = (id) => {
      const value = rollup(id)
      return value === undefined ? value : { ...value, seatActivity: null }
    }
    return handle
  },
}

/** Every visible 1x row's `activityAt` against the oracle's (POD-4671 fixed: no orphan). */
async function activityDiffs(arm: CheckableArm): Promise<{ rows: number; diffs: string[] }> {
  const ctx = await startScenarioEngine(1)
  const feeds = openFenceFeeds(ctx, 'pooled')
  const handle = arm.create(feeds.rows.source, feeds.locals.source) as HarnessHandPoolHandle
  try {
    const expected = rowViewsFromStore(referenceState(ctx.engine), engineLocals(ctx))
    const ids = Object.keys(expected)
    for (const id of ids) handle.pool.resident('issue', id)
    snapshotPool(handle.pool)
    const diffs: string[] = []
    for (const id of ids) {
      const got = handle.pool.view(id)?.activityAt
      if (got !== expected[id]!.activityAt) {
        diffs.push(`${id}: live ${got}, oracle ${expected[id]!.activityAt}`)
      }
    }
    return { rows: ids.length, diffs }
  } finally {
    handle.dispose()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

describe('row fields against the oracle', () => {
  /**
   * POD-4714 — RowView fields not compared field-for-field with the oracle,
   * each with its one-line reason. Every other field of ROW_VIEW_FIELDS is
   * compared with `toEqual` below; adding a field to RowView without comparing
   * it (and without adding it here) fails the exhaustiveness test.
   */
  const ORACLE_EXEMPT: Partial<Record<keyof RowView, string>> = {
    // Drafts wear the first member's label; legacy uses replica order plus the
    // session's name, pools use lowest id plus kind only (displayTitleOf).
    title: 'draft titles need a member session the pools order differently and name without session names',
    // The full tick carries the origin's draft-varying title; null-ness and
    // the ref compare exactly below, the rest inherits the title variance.
    originTick: 'origin tick title inherits the draft-title variance; ref + null-ness compare exactly',
    // Not an oracle field (sliceRowOf drops it); resident rows must never
    // load, checked as undefined below.
    loading: 'no oracle counterpart; resident rows are never loading',
  }
  // Every non-exempt contract field, derived from the row contract so a new
  // field is compared by default.
  const same: (keyof RowView)[] = ROW_VIEW_FIELDS.filter(
    (field): field is keyof RowView => ORACLE_EXEMPT[field] === undefined,
  )

  it('every RowView field is compared or exempt with a reason', () => {
    for (const [field, reason] of Object.entries(ORACLE_EXEMPT)) {
      expect(ROW_VIEW_FIELDS.includes(field as keyof RowView), `exempt ${field} is a RowView field`).toBe(
        true,
      )
      expect(reason.trim().length, `exempt ${field} has a reason`).toBeGreaterThan(0)
    }
    expect(new Set(same).size).toBe(same.length)
    expect(new Set([...same, ...Object.keys(ORACLE_EXEMPT)]).size).toBe(ROW_VIEW_FIELDS.length)
    for (const field of ROW_VIEW_FIELDS) {
      expect(
        same.includes(field) || Object.hasOwn(ORACLE_EXEMPT, field),
        `${field} is compared or exempt`,
      ).toBe(true)
    }
  })

  it('matches the oracle on every visible row', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'pooled')
    const handle = harnessHandPoolArm.create(feeds.rows.source, feeds.locals.source)
    try {
      const expected = rowViewsFromStore(referenceState(ctx.engine), engineLocals(ctx))
      const ids = Object.keys(expected)
      expect(ids.length).toBeGreaterThan(100)
      // Visible closed rows (the grace window, the fold) are cold: a reader
      // asks for them, and the settled snapshot loads them and what they read.
      for (const id of ids) handle.pool.resident('issue', id)
      snapshotPool(handle.pool)
      let closedByOracle = 0
      for (const id of ids) {
        const want = expected[id]!
        const got = handle.pool.view(id)
        expect(got, id).toBeDefined()
        for (const field of same) expect(got![field], `${id}.${field}`).toEqual(want[field])
        if (!got!.title.startsWith('New ')) expect(got!.title, `${id}.title`).toBe(want.title)
        if (want.closed) closedByOracle += 1
        expect(got!.loading, `${id}.loading`).toBeUndefined()
        if (want.originTick === null) expect(got!.originTick, `${id}.originTick`).toBeNull()
        else expect(got!.originTick?.ref, `${id}.originTick`).toBe(want.originTick.ref)
      }
      expect(closedByOracle).toBeGreaterThan(0)
      expect(ids.filter((id) => expected[id]!.originTick !== null).length).toBeGreaterThan(0)
      expect(new Set(ids.map((id) => expected[id]!.band)).size).toBeGreaterThan(1)
      // Every roll-up value the fixture can show is exercised.
      expect(new Set(ids.map((id) => expected[id]!.phase)).size).toBe(4)
      expect(ids.some((id) => expected[id]!.asking && expected[id]!.working)).toBe(true)
      expect(ids.some((id) => expected[id]!.progressTotal > 1)).toBe(true)
    } finally {
      handle.dispose()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('holds activityAt to the oracle on every visible row, and both halves mutants fail it', async () => {
    // Correct arm: the retained seats' latest stamp, else `updatedAt`
    // (`rows.ts:98-116`), raised by the latest seat nested below
    // (`rows.ts:336-339`) — exactly the oracle's on every visible row, the
    // POD-4671 orphan excepted (its seat-fed fields include the stamp).
    const correct = await activityDiffs(harnessHandPoolArm)
    expect(correct.rows).toBeGreaterThan(100)
    expect(correct.diffs, 'activityAt equals the oracle').toEqual([])
    // Mutant A: the old own half (every explicit session). It stamps rows
    // whose decayed sessions the legacy ignores.
    const oldHalf = await activityDiffs(oldHalfArm)
    expect(oldHalf.diffs.length, 'mutant A fails').toBeGreaterThan(0)
    // Mutant B: no subtree raise. It understamps rows with seats below.
    const noRaise = await activityDiffs(noRaiseArm)
    expect(noRaise.diffs.length, 'mutant B fails').toBeGreaterThan(0)
    writeResult('hand-pool-row-fields-activityAt-1x', {
      rows: correct.rows,
      mutantA: oldHalf.diffs.slice(0, 5),
      mutantB: noRaise.diffs.slice(0, 5),
    })
  }, 120_000)
})

/**
 * POD-4582 (Hb1): the visible collection and its order against the LEGACY
 * ORACLE after every generated step. The checker's own oracle comparison is
 * the whole snapshot (groups, roll-ups: Hb2-Hb4's), so it stays off for the
 * pool; this compares only what Hb1 owns, the flat visible order (the rows
 * the app shows, in R-ORDER, `visibleIssueRows` with no selection, spec §7).
 * The rebuild shares this arm's rule table, so without this a rule the
 * fixture never exercises (an excluded child, an R3 member, a draft vessel)
 * could be wrong in both and still compare equal.
 */
function orderChecked(): ((ctx: ScenarioEngine) => CheckableArm) & { compared: number } {
  const factory = ((ctx: ScenarioEngine): CheckableArm => ({
    create(source, locals, reads) {
      const handle = harnessHandPoolArm.create(source, locals, reads)
      return {
        ...handle,
        snapshot() {
          const settled = handle.snapshot()
          const coarseNow = parityLocals(ctx).coarseNow
          const derivation = legacyDerivationFromStore(referenceState(ctx.engine), coarseNow)
          const expected: string[] = visibleIssueRows(derivation, parityLocals(ctx)).map(
            (row) => row.issue.id,
          )
          const order = [...handle.pool.order()]
          factory.compared += 1
          if (order.join() !== expected.join()) {
            const want = new Set(expected)
            const have = new Set(order)
            const first = order.findIndex((id, i) => id !== expected[i])
            throw new Error(
              `order diverged from the oracle (snapshot ${factory.compared}): ` +
                `missing [${expected.filter((id) => !have.has(id)).join(', ')}], ` +
                `extra [${order.filter((id) => !want.has(id)).join(', ')}], ` +
                `first difference at ${first}: ${order[first]} (oracle ${expected[first]})`,
            )
          }
          return settled
        },
      }
    },
  })) as ((ctx: ScenarioEngine) => CheckableArm) & { compared: number }
  factory.compared = 0
  return factory
}

describe('visible order against the oracle (Hb1)', () => {
  it(
    'equals the legacy oracle after every step of every seed',
    async () => {
      const cells = []
      for (const seed of SEEDS) {
        const sequence = gen(seed, STEPS)
        const arm = orderChecked()
        let failure: string | null = null
        try {
          const result = await checkArm(arm, sequence, { oracleEvery: 0, shrink: false })
          if (!result.ok) failure = `step ${result.step} (${result.against}): ${result.diff}`
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        cells.push({ seed, steps: STEPS, compared: arm.compared, failure })
        if (failure !== null) throw new Error(`seed ${seed}: ${failure}`)
        expect(arm.compared).toBeGreaterThan(STEPS)
      }
      writeResult(`hand-visible-oracle-1x-${SEEDS.length}x${STEPS}`, { cells })
    },
    GATE_TIMEOUT_MS,
  )
})

/**
 * POD-4681 — the three R-VIS plants as PERMANENT tests. Each planted mistake
 * runs a default 3x200 against the shared oracle (the same `orderChecked`
 * comparison as Hb1) and must FAIL every seed: the forced prefix
 * (`excludedKeeper`, `orphanInWorktree`, `draftVesselStarter`) reaches the
 * branch on every seed, so a plant that stops failing means the shape no
 * longer reaches it. Each plant is installed in memory and restored in a
 * `finally` (a copy of the rule where the rule is more than a line); arm
 * files on disk are never touched.
 */
describe('visibility plants against the oracle (POD-4681)', () => {
  /** Copy of `ownerOf` (`worklist/visible.ts`) for the draft plant below. */
  function plantOwnerOf(input: VisibleInputs, sessionId: string): string | null {
    const session = input.session(sessionId)
    if (session === undefined) return null
    if (!session.resident) {
      const link = session.issueLink
      if (link === null || input.issue(link)?.present !== true) return null
      const retention = session.retention
      return retention !== null && !retention.archived && retention.issueId === link ? link : null
    }
    const retention = session.retention
    if (retention === null || retention.archived) return null
    if (retention.issueId !== undefined) {
      const issueId = session.issueLink
      return issueId !== null &&
        issueId === retention.issueId &&
        input.issue(issueId)?.present === true
        ? issueId
        : null
    }
    const worktree = session.worktreeLink
    if (worktree === null) return null
    let owner: string | null = null
    for (const issueId of input.relations.many('worktree', worktree, 'issues')) {
      if (owner !== null && issueId > owner) continue
      const issue = input.issue(issueId)
      if (issue?.present === true && issue.standing?.excluded === false) owner = issueId
    }
    return owner
  }

  /** Copy of the `nestParent` rule without the draft-vessel exception. */
  function plantNestParentNoDraft(input: VisibleInputs, id: string, self: VisibleParts): string | null {
    if (!self.present) return null
    const standing = self.standing
    if (standing === undefined) return null
    const seen = new Set<string>([id])
    let parentId = standing.parentId
    while (parentId !== null) {
      if (seen.has(parentId)) return null
      seen.add(parentId)
      const parent = input.issue(parentId)
      if (parent === undefined) break
      if (parent.present) return parentId
      parentId = parent.parentLink
    }
    if (standing.parentId !== null || standing.startedBy === null) return null
    const owner = plantOwnerOf(input, standing.startedBy)
    if (owner === null || owner === id) return null
    return owner
  }

  async function expectPlant(
    install: () => void,
    restore: () => void,
    want: { snapshot: number; missing: string; extra: string },
  ): Promise<void> {
    install()
    try {
      for (const seed of SEEDS) {
        const sequence = gen(seed, STEPS)
        const arm = orderChecked()
        let failure: string | null = null
        try {
          const result = await checkArm(arm, sequence, { oracleEvery: 0, shrink: false })
          if (!result.ok) failure = `step ${result.step} (${result.against}): ${result.diff}`
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        expect(failure, `seed ${seed}: plant not caught`).not.toBeNull()
        if (seed === FIRST_SEED) {
          expect(failure as string).toContain(`snapshot ${want.snapshot}`)
          if (want.missing) expect(failure as string).toContain(want.missing)
          if (want.extra) expect(failure as string).toContain(want.extra)
        }
      }
    } finally {
      restore()
    }
  }

  it('plant keeps ignoring excluded fails every seed', async () => {
    const original = VISIBLE_RULES.keeps
    const rules = VISIBLE_RULES as unknown as { keeps: typeof original }
    await expectPlant(
      () => {
        rules.keeps = (_input: VisibleInputs, _id: string, self: VisibleParts) => {
          if (!self.flat && !self.keptBelow) return false
          return self.standing !== undefined
        }
      },
      () => {
        rules.keeps = original
      },
      { snapshot: 6, missing: '', extra: 'i-g1' },
    )
  }, GATE_TIMEOUT_MS)

  it('plant no R3 members fails every seed', async () => {
    const original = VISIBLE_RULES.memberIds
    const rules = VISIBLE_RULES as unknown as { memberIds: typeof original }
    await expectPlant(
      () => {
        rules.memberIds = (_input: VisibleInputs, _id: string, self: VisibleParts) => self.seatIds
      },
      () => {
        rules.memberIds = original
      },
      { snapshot: 11, missing: 'i-g4', extra: '' },
    )
  }, GATE_TIMEOUT_MS)

  it('plant draft vessel ignored fails every seed', async () => {
    const original = VISIBLE_RULES.nestParent
    const rules = VISIBLE_RULES as unknown as { nestParent: typeof original }
    await expectPlant(
      () => {
        rules.nestParent = plantNestParentNoDraft
      },
      () => {
        rules.nestParent = original
      },
      { snapshot: 15, missing: 'i-g9', extra: '' },
    )
  }, GATE_TIMEOUT_MS)
})
