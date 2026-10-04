import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
/**
 * POD-4565 (Ma1) — the correctness gate (L4b, `shared/src/gen/check.ts`) on
 * the pool, and the pool's own-row fields against the legacy oracle.
 *
 * GATE. Incremental versus rebuild after EVERY step, on generated sequences
 * of every change kind (the pool sees each as an upsert, a removal or a
 * `replace` on reload), and versus the legacy ORACLE at `checkArm`'s default
 * cadence (every 10 steps and after the last; POD-4572, Mb4: until the
 * worklist phase this gate ran `oracleEvery: 0`, because the oracle compares
 * order and roll-ups). POD-4671 fixed: no rows taken from the oracle.
 * The gate's NO on this arm: the same pool planted deaf to removals (the
 * feed's `value: undefined` records dropped) must fail it, on the same
 * sequences. The plants keep `oracleEvery: 0`: each is held to the catcher
 * it names (rebuild, per-step checks, checkpoint).
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
 * ATTACH (POD-5407). The pool attaches with the rows the rule keeps resident
 * only: each created arm's attach is held to the rule computed from scratch
 * over the feed (`attachProblems`): it placed no more rows than the feed has
 * rows the rule does not call cold.
 *
 * THE PLANTS, each of which must fail every seed:
 * - `planted`: deaf to removals (Ma1's; the rebuild catches it).
 * - `coldDeaf`: an update to a row the pool holds cold never reaches it.
 * - `coldMemberDropped` (POD-5407): the pool's relation view misses its cold
 *   members (every bucket answers its resident members only). Checked per
 *   step with the checkpoint OFF: the per-step relation check, which reads
 *   no residency from the pool, must catch it. (It replaces POD-4568's
 *   `coldRelinkSkipped`: the pool no longer relinks anything; the relation
 *   index the cold index holds does, once, for every row.)
 * - `allRowsAttach` (POD-5407): the attach places every row the feed
 *   carries, as the pool did before. Results stay right, so only the attach
 *   check can catch it, and it must be the one that does. (It replaces
 *   POD-4568's `promoteSkipped`: there are no plain twins to promote from.)
 * The cells count cold-row work AFTER each bootstrap and before the
 * checkpoint: registry writes (a cold row's update, insert or removal), loads
 * on access, rows warmed by a reopen or removal.
 *
 * WHOLE VIEWS (POD-4674, H3-F3). The checker compares `snapshot()`, whose
 * rows are `sliceRowOf(view)`: the 11 slice fields. `activityAt`,
 * `originTick`, `selected`, `pinned`, `sortKey`, `createdAt`, `seq`, `foldAt`
 * and `dismissed` reach none of them. Every compared step also holds every
 * visible issue's whole `RowView` to the rebuild's (`rebuildViews`, the same
 * rule table run directly over the feed's rows), field by field (the shared
 * `diffViews`, `check.ts`, which the hand gate uses too).
 *
 * OBSERVED. Each checked arm is kept alive by one reaction over every visible
 * row's view and the grouped layout, as the mounted list keeps it (Mb3's
 * lesson, POD-4571 1784e722f): unobserved, every computed re-runs on each
 * snapshot read and no stale cache could ever show.
 *
 * H3's three view plants (`harness/review/h3-gate-plants.test.ts`), in MobX
 * terms, each of which must fail every seed:
 * - `activityCached`: each member's activity cached in a plain `Map` on
 *   both paths `activityAt` reads it (the MobX gates' deaf plain-Map read).
 *   Only the view check can catch it; it must be the one that does.
 * - `presenceUntracked`: the origin's residency asked untracked (its presence
 *   and its loading marker, both read by the view), so a view does not re-run
 *   when its origin arrives or leaves.
 * - `chainUntracked`: another issue's derived results read untracked (the
 *   origin's parts, read by `originTick`, and the children's results the
 *   roll-up compositions read), so a change two derivations down does not
 *   reach the reader (H3's `chain`: a changed cell at level >= 2 does not dirty
 *   its readers).
 *
 * FIDELITY (POD-4714). Every `RowView` field (`ROW_VIEW_FIELDS`,
 * `shared/src/row-view.ts`) is compared with the oracle's row views
 * (`rowViewsFromStore`) for every visible row, except the `ORACLE_EXEMPT`
 * list below, each entry with its reason (`title` draft variance,
 * `originTick` title variance with ref + null-ness still held, `loading` with
 * no oracle counterpart checked as undefined). A new contract field is
 * compared by default: the exhaustiveness test fails until it is.
 */

import { reaction, runInAction, untracked } from 'mobx'
import { describe, expect, it } from 'vitest'
import { engineLocals, openFenceFeeds } from '../../../harness/src/fence-scenarios'
import {
  oracleSnapshot,
  rowViewsFromStore,
  snapshotFromStore,
} from '../../../harness/src/oracle/index'
import { writeResult } from '../../../harness/src/results'
import type { CheckableArm, RowSource } from '../../../shared/src/arm'
import { countKinds, gen } from '../../../shared/src/gen/changes'
import {
  type CheckedArm,
  checkArm,
  describeSequence,
  diffSnapshots,
  diffViews,
} from '../../../shared/src/gen/check'
import { ROW_VIEW_FIELDS, type RowView } from '@podium/client-graph/shared/row-view'
import { type ScenarioEngine, startScenarioEngine } from '../../../shared/src/scenarios'
import type { SliceSnapshot } from '@podium/client-graph/shared/slice-types'
import { type HarnessMobxPoolHandle, harnessMobxPoolArm, snapshotPool, tracked, visibleOrderOf } from '../../../harness/src/adapters/mobx-pool'
import { attachProblems, coldIds, diffRelations, diffResidency, knownTables } from '../../../harness/src/adapters/mobx-rebuild'
import type { RelationQueries } from '@podium/client-graph/shared/relation-index'
import type { EntityName } from '@podium/client-graph/shared/schema'
import { installMobxWarnTrap } from '../../../harness/src/mobx-trap'
import { rebuildSnapshot, rebuildViews } from '../../../harness/src/adapters/mobx-rebuild'
import { rowViewOf } from '@podium/client-graph/models'

installMobxWarnTrap()

/**
 * Three seeds of 200 steps by default (~8 min at load 8 with the per-step
 * relation check); `POD_POOL_GATE_SEEDS=<n>` runs seeds 1..n and
 * `POD_POOL_GATE_STEPS=<n>` sets the steps per seed;
 * `POD_POOL_GATE_FIRST_SEED=<k>` starts at seed k, so a long run goes in chunks. The gate of record
 * (POD-4568) is 20 x 300: `docs/measurements/POD-4568-a.md` has the command.
 */
const FIRST_SEED = Number(process.env['POD_POOL_GATE_FIRST_SEED'] ?? 1)
const SEEDS = Array.from(
  { length: Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3) - FIRST_SEED + 1 },
  (_, i) => i + FIRST_SEED,
)
const STEPS = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)
/**
 * 5 s per seed-step (was 2.5 s): since Mb3 (POD-4571) every snapshot and
 * every rebuild of the five arms per seed also derives the roll-ups, and the
 * gate's arms are unobserved, so each snapshot re-derives them. At load ~9
 * the default 3 x 200 ran past the old 25 min. 8 s since POD-4674: eight
 * arms per seed (three view plants), each compared step also rebuilding the
 * whole views.
 */
const GATE_TIMEOUT_MS = Math.max(1_500_000, SEEDS.length * STEPS * 8_000)

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
  create: (source, locals, reads) => harnessMobxPoolArm.create(deafToRemovals(source), locals, reads),
}

/** The residency plant: an update to a row the pool holds cold never reaches it. */
const coldDeaf: CheckableArm = {
  create(source, locals, reads) {
    let handle: HarnessMobxPoolHandle | null = null
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
    handle = harnessMobxPoolArm.create(filtered, locals, reads)
    return handle
  },
}

/**
 * The relation plant (POD-5407): the pool's relation view answers every
 * bucket with its resident members only, as a lazy bucket that never took
 * its cold members would.
 */
const coldMemberDropped: CheckableArm = {
  create(source, locals, reads) {
    const handle = harnessMobxPoolArm.create(source, locals, reads)
    const { pool } = handle
    const graph = pool.graph as unknown as { index: () => RelationQueries }
    const index = graph.index
    graph.index = () => {
      const relations = index()
      return {
        ...relations,
        forward: relations.forward.bind(relations),
        targets: relations.targets.bind(relations),
        subset: relations.subset.bind(relations),
        collapsed: relations.collapsed.bind(relations),
        orderKey: relations.orderKey.bind(relations),
        extraRoot: relations.extraRoot.bind(relations),
        members: (to, id, collection) => {
          const members = relations.members(to, id, collection)
          const target = pool.graph.schema[to].relations[collection]?.to
          if (target === undefined || pool.residency?.capable(target) !== true) return members
          return new Set([...members].filter((member) => pool.tables[target].has(member)))
        },
      }
    }
    return handle
  },
}

/** The attach plant (POD-5407): the attach places every row the feed carries. */
const allRowsAttach: CheckableArm = {
  create(source, locals, reads) {
    const all: RowSource = {
      ...source,
      cold: undefined,
      snapshot: (kind) => source.snapshot(kind),
    }
    const handle = harnessMobxPoolArm.create(all, locals, reads)
    const residency = handle.pool.residency
    if (residency === null) return handle
    // Every row a candidate: the pool's own index answers with every row.
    const ownIndex = (handle.pool as unknown as { ownIndex: { residentCandidates: (entity: EntityName, now: number) => string[] } }).ownIndex
    const candidates = ownIndex.residentCandidates.bind(ownIndex)
    ownIndex.residentCandidates = (entity, now) =>
      residency.capable(entity) ? source.snapshot(entity as 'issue' | 'session').map((record) => record.id) : candidates(entity, now)
    runInAction(() => handle.pool.apply({ type: 'replace', rows: [
      ...source.snapshot('session'), ...source.snapshot('issue'), ...source.snapshot('worktree'),
    ] }))
    return handle
  },
}

/**
 * The view plant: each member's activity is cached in a plain `Map` after its
 * first read, on BOTH paths that read it: the own-row half (the session
 * model's `activityMs`, `ViewInputs.sessionActivity`) and the subtree half
 * (the worklist's session node, `seatActivity`). Caching one path alone is
 * masked by the other: the view is their max, and a live seat's stamp reaches
 * it through both (seed 1 x 300 passed with the model path alone cached).
 */
const activityCached: CheckableArm = {
  create(source, locals, reads) {
    const handle = harnessMobxPoolArm.create(source, locals, reads)
    const { pool } = handle
    const inputs = pool.inputs as { sessionActivity: (id: string) => number | null }
    const read = inputs.sessionActivity
    const cache = new Map<string, number | null>()
    inputs.sessionActivity = (id) => {
      if (!cache.has(id)) cache.set(id, read(id))
      return cache.get(id) as number | null
    }
    const visible = pool.visibleInputs as { session: (id: string) => object }
    const session = visible.session
    const seen = new Map<string, number | null>()
    visible.session = (id) =>
      new Proxy(session(id), {
        get(target, key) {
          const value = Reflect.get(target, key)
          if (key !== 'activityMs') return value
          if (!seen.has(id)) seen.set(id, value as number | null)
          return seen.get(id)
        },
      })
    return handle
  },
}

/**
 * H3's presence plant: a view asks its origin's residency untracked. The row
 * view reads the origin's residency twice in one derivation (its presence for
 * the tick, its loading marker for `loading`), so both reads are cut: with
 * only one cut the other re-runs the view when the origin arrives or leaves.
 */
const presenceUntracked: CheckableArm = {
  create(source, locals, reads) {
    const handle = harnessMobxPoolArm.create(source, locals, reads)
    const { pool } = handle
    const inputs = pool.inputs as {
      present: (entity: 'issue' | 'session', id: string) => boolean
      loading: (entity: 'issue' | 'session', id: string) => boolean
    }
    const present = inputs.present
    const loading = inputs.loading
    inputs.present = (entity, id) => untracked(() => present(entity, id))
    inputs.loading = (entity, id) =>
      entity === 'issue' ? untracked(() => loading(entity, id)) : loading(entity, id)
    return handle
  },
}

/** Every getter of `target` read untracked; with `keys`, only those. */
function untrackedProxy<T extends object>(target: T, keys?: ReadonlySet<PropertyKey>): T {
  return new Proxy(target, {
    get: (object, key) =>
      keys === undefined || keys.has(key)
        ? untracked(() => Reflect.get(object, key))
        : Reflect.get(object, key),
  })
}

/** The results a parent's compositions read from each child node. */
const CHILD_RESULTS: ReadonlySet<PropertyKey> = new Set(['aggregate', 'unitsBelow', 'seatActivity'])

/**
 * H3's chain plant (a changed cell at level >= 2 dirties none of its
 * readers), in MobX terms: a derivation reads ANOTHER issue's derived result
 * untracked, so its change never reaches the reader. Two such paths: the
 * origin's parts that `originTick` reads, and the children's results the
 * roll-up compositions read (`aggregate`, `unitsBelow`, `seatActivity`). Not
 * every node read: a node reads some of its own parts through the same
 * input, and cutting those leaves derivations that read nothing (MobX warns).
 */
const chainUntracked: CheckableArm = {
  create(source, locals, reads) {
    const handle = harnessMobxPoolArm.create(source, locals, reads)
    const { pool } = handle
    const inputs = pool.inputs as { parts: (id: string) => object | undefined }
    const parts = inputs.parts
    inputs.parts = (id) => {
      const model = untracked(() => parts(id))
      return model === undefined ? undefined : untrackedProxy(model)
    }
    const visible = pool.visibleInputs as { issue: (id: string) => object | undefined }
    const issue = visible.issue
    visible.issue = (id) => {
      const node = issue(id)
      return node === undefined ? undefined : untrackedProxy(node, CHILD_RESULTS)
    }
    return handle
  },
}

/** What the gated arms did with cold rows, summed over every arm a run created. */
interface ColdTally {
  /** Per-row feed reads (`RowSource.row`): cold rows loaded, counted outside the pool. */
  loads: number
  /** Full-residency checkpoints passed. */
  checkpoints: number
}

function emptyTally(): ColdTally {
  return { loads: 0, checkpoints: 0 }
}

/**
 * The full-residency checkpoint: load every cold row, settle, then hold the
 * pool to the feed with no input from the pool. Throws on any difference.
 */
function fullResidencyCheck(
  handle: HarnessMobxPoolHandle,
  source: RowSource,
  locals: Parameters<CheckableArm['create']>[1],
  label: string,
): void {
  const { pool } = handle
  const residency = pool.residency
  if (residency === null) throw new Error(`${label}: the pool has no residency`)
  // Every cold row, from the feed: the pool keeps no list of them (POD-5407).
  for (const entity of ['issue', 'session'] as const) {
    for (const id of coldIds(pool, source, entity)) residency.request(entity, id)
  }
  pool.hydrate()
  const settled = snapshotPool(pool)
  const left = [...coldIds(pool, source, 'issue'), ...coldIds(pool, source, 'session')]
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
      const counted: RowSource = {
        ...source,
        row: source.row === undefined
          ? undefined
          : ((kind, id) => {
              wrapper.cold.loads += 1
              return source.row!(kind, id)
            }) as RowSource['row'],
      }
      const handle = arm.create(counted, locals, reads) as HarnessMobxPoolHandle
      const { pool } = handle
      // POD-5407: the attach placed only rows the rule keeps resident.
      const attach = attachProblems(pool, source)
      if (attach.length > 0) throw new Error(`attach (snapshot ${wrapper.snapshots}): ${attach.join('; ')}`)
      // Kept alive as the mounted list keeps it (see OBSERVED).
      const stop = reaction(
        () => [visibleOrderOf(pool).map((id) => rowViewOf(pool.issue(id))), pool.groups.layout],
        () => {},
        { name: 'gate.observer' },
      )
      return {
        ...handle,
        snapshot() {
          wrapper.snapshots += 1
          // The checker snapshots once at boot and once per step.
          if (checks.full && wrapper.snapshots === STEPS + 1) {
            fullResidencyCheck(handle, counted, locals, `step ${STEPS - 1}`)
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
          const direct = rebuildViews(source, locals)
          wrapper.views += direct.size
          const views = tracked(() => diffViews((id) => rowViewOf(pool.issue(id)), direct))
          if (views.length > 0) {
            throw new Error(
              `row views diverged from the direct rule table (snapshot ${wrapper.snapshots}):\n${views.join('\n')}`,
            )
          }
          return settled
        },
        dispose() {
          stop()
          handle.dispose()
        },
      }
    },
  }
  return wrapper
}

const relationChecked = checked(harnessMobxPoolArm)

/**
 * POD-4572: `arm` observed directly (POD-4671 fixed: no gap patch, the tally
 * stays 0).
 */
function gapped(arm: CheckableArm, tally: { applied: number }): CheckedArm {
  void tally
  return arm
}

/** Which check caught a plant, from the error it threw. */
function caughtBy(message: string): string {
  if (message.startsWith('full residency')) return 'checkpoint'
  if (message.startsWith('attach')) return 'attach'
  if (message.startsWith('residency')) return 'partition'
  if (message.startsWith('row views')) return 'views'
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

describe('correctness gate (L4b), rebuild every step and the oracle at its default', () => {
  it(
    'passes every seed, and every plant fails every seed',
    async () => {
      const cells = []
      let plantedFailures = 0
      let coldPlantFailures = 0
      let attachPlantFailures = 0
      let relinkPlantFailures = 0
      const viewPlantFailures = { activity: 0, presence: 0, chain: 0 }
      for (const seed of SEEDS) {
        const sequence = gen(seed, STEPS)
        relationChecked.snapshots = 0
        relationChecked.views = 0
        relationChecked.cold = emptyTally()
        const gap = { applied: 0 }
        const result = await checkArm(gapped(relationChecked, gap), sequence)
        if (!result.ok) {
          throw new Error(
            `seed ${seed}: step ${result.step} diverged from the ${result.against}:\n${result.diff}\n` +
              `shrunk:\n${describeSequence(result.shrunk)}`,
          )
        }
        expect(relationChecked.snapshots).toBeGreaterThan(STEPS)
        // Not rebuild-only: the oracle compared the run (every 10 steps, the last, the boot).
        expect(result.counts.oracleChecks).toBeGreaterThanOrEqual(Math.floor(STEPS / 10) + 1)
        // The view check compared rows at every step, or its green says nothing.
        expect(relationChecked.views).toBeGreaterThan(relationChecked.snapshots)
        const cold = { ...relationChecked.cold }
        // The run must have exercised cold rows, or its green says nothing about them.
        expect(cold.loads, `seed ${seed} loaded no cold row`).toBeGreaterThan(0)
        expect(cold.checkpoints, `seed ${seed} ran no full-residency checkpoint`).toBeGreaterThan(0)
        const plant = await checkArm(planted, sequence, { oracleEvery: 0, shrink: false })
        if (!plant.ok) plantedFailures += 1
        const coldPlant = await plantOutcome(checked(coldDeaf), sequence)
        if (!coldPlant.ok) coldPlantFailures += 1
        const relinkPlant = await plantOutcome(
          checked(coldMemberDropped, { perStep: true, full: false }),
          sequence,
        )
        if (!relinkPlant.ok && relinkPlant.against === 'relations') relinkPlantFailures += 1
        const attachPlant = await plantOutcome(checked(allRowsAttach), sequence)
        if (!attachPlant.ok && attachPlant.against === 'attach') attachPlantFailures += 1
        const activity = await plantOutcome(checked(activityCached), sequence)
        if (!activity.ok && activity.against === 'views') viewPlantFailures.activity += 1
        const presence = await plantOutcome(checked(presenceUntracked), sequence)
        if (!presence.ok) viewPlantFailures.presence += 1
        const chain = await plantOutcome(checked(chainUntracked), sequence)
        if (!chain.ok) viewPlantFailures.chain += 1
        const brief = (outcome: typeof activity) =>
          outcome.ok
            ? { failed: false }
            : {
                failed: true,
                step: outcome.step,
                caughtBy: outcome.against,
                diff: outcome.diff.split('\n').slice(0, 2).join(' | '),
              }
        cells.push({
          seed,
          steps: STEPS,
          counts: result.counts,
          gapApplied: gap.applied,
          relationChecks: relationChecked.snapshots,
          viewsCompared: relationChecked.views,
          viewPlants: {
            activityCached: brief(activity),
            presenceUntracked: brief(presence),
            chainUntracked: brief(chain),
          },
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
          attachPlantFailed: !attachPlant.ok,
          attachPlantCaughtBy: attachPlant.ok ? null : attachPlant.against,
          attachPlantDiff: attachPlant.ok
            ? null
            : attachPlant.diff.split('\n').slice(0, 2).join(' | '),
        })
      }
      const name =
        FIRST_SEED === 1
          ? `mobx-pool-gate-1x-${SEEDS.length}x${STEPS}`
          : `mobx-pool-gate-1x-${SEEDS.length}x${STEPS}-from-${FIRST_SEED}`
      writeResult(name, {
        seeds: SEEDS,
        steps: STEPS,
        cells,
      })
      expect(plantedFailures).toBe(SEEDS.length)
      expect(coldPlantFailures).toBe(SEEDS.length)
      expect(relinkPlantFailures).toBe(SEEDS.length)
      expect(attachPlantFailures).toBe(SEEDS.length)
      expect(viewPlantFailures).toEqual({
        activity: SEEDS.length,
        presence: SEEDS.length,
        chain: SEEDS.length,
      })
    },
    GATE_TIMEOUT_MS,
  )
})

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
    const handle = harnessMobxPoolArm.create(feeds.rows.source, feeds.locals.source)
    try {
      const expected = rowViewsFromStore(referenceState(ctx.engine), engineLocals(ctx))
      const ids = Object.keys(expected)
      expect(ids.length).toBeGreaterThan(100)
      // Visible closed rows (the grace window, the fold) are cold: a reader
      // asks for them, and the settled snapshot loads them and what they read.
      tracked(() => {
        for (const id of ids) handle.pool.resident('issue', id)
      })
      snapshotPool(handle.pool)
      const actual = tracked(() =>
        Object.fromEntries(ids.map((id) => [id, rowViewOf(handle.pool.issue(id))])),
      )
      let closedByOracle = 0
      // POD-4671 fixed: no gap, every row's seat-fed fields compare.
      const snapshot = snapshotPool(handle.pool)
      const gap: string | null = null
      for (const id of ids) {
        const want = expected[id]!
        const got = actual[id]
        expect(got, id).toBeDefined()
        for (const field of same) {
          if (
            id === gap &&
            (field === 'phase' ||
              field === 'working' ||
              field === 'asking' ||
              field === 'workingSince' ||
              field === 'activityAt')
          )
            continue
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
