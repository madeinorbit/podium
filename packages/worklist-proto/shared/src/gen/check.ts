import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
/**
 * POD-4556 (L4b) — the correctness gate: incremental versus rebuild versus
 * oracle, after every generated change.
 *
 * `checkArm(arm, sequence)` boots the generator's engine (`run.ts`, the real
 * kernel), creates the arm over the per-row feed, applies the sequence one
 * change at a time and, after every settled step, compares:
 *
 * - `arm.snapshot()` (the incremental state) with `arm.rebuildFromScratch()`
 *   (the same arm recomputed from the feed's CURRENT `snapshot(kind)` tables),
 *   every `rebuildEvery` steps (default: every step). Comparing with the
 *   feed's snapshot, not only the events the arm heard, is what makes a change
 *   the feed fails to announce visible (a discovery-only worktree was one
 *   until POD-4606 made the feed announce it);
 * - `arm.snapshot()` with the legacy oracle over the engine store
 *   (`oracleSnapshot`: derived and projected with the engine's own clock),
 *   every `oracleEvery` steps (default 10, and always after the last step;
 *   0 disables it). The oracle is the app's paint (the overlaid view), so a
 *   `truth`-feed arm must have applied its own optimism to match it.
 *
 * Plus once at bootstrap, before any change (`step: -1`).
 *
 * SAMPLING. An arm whose snapshot or rebuild is expensive (the legacy
 * control: both are a whole legacy derivation, ~0.1 s each at 1x) can be
 * compared at checkpoints (`rebuildEvery` > 1). A failure is then re-run
 * densely over its prefix, so the report still names the first step that
 * diverged; a divergence that heals before the next checkpoint is missed.
 *
 * THE COMPARISON is the whole `SliceSnapshot`: every row's fields and the
 * full order (pinned ids, then each group's key, label, row ids and closed
 * ids, all order-sensitive). `SliceSnapshot` carries no `readAt`, so the wall-
 * clock stamp a pending mark-read paints (L4a finding 5) is never compared.
 *
 * THE FIRST DIVERGENCE stops the run. The failing prefix is then shrunk
 * (`shrink.ts`) with "the checker fails" as the predicate (any divergence,
 * rebuild or oracle), and the result carries the shrunk sequence and the
 * divergence it produces, next to the raw one. The shrunk sequence is what a
 * report quotes.
 *
 * LIFECYCLE. The arm gets the engine-backed locals channel
 * (`createEngineLocals`, POD-4608): a tick reaches it only there, since the
 * feed emits nothing for a tick that moves no row. A `refresh` reloads the
 * page: the checker disposes the arm and creates a new one over the new
 * engine's feed and locals, which is what a reload does to a client store.
 */

import { isDeepStrictEqual } from 'node:util'
import { createEngineLocals } from '../../../harness/src/engine-locals'
import type { FixtureCorpus } from '../../../harness/src/fixture/index'
import { oracleSnapshot } from '../../../harness/src/oracle/index'
import type { CheckableArm, CheckableArmHandle } from '../arm'
import type { RowSourceMode } from '@podium/client-graph/shared/row-source'
import type { RowView } from '@podium/client-graph/shared/row-view'
import type { ScenarioEngine } from '../scenarios'
import type { SliceGroup, SliceSnapshot } from '@podium/client-graph/shared/slice-types'
import type { Change } from './changes'
import { startGenRun, type GenRun, type StepResult } from './run'
import { shrink } from './shrink'
import type { ArmEditFn } from './arm-edits'

/** An arm, or a factory for one over the engine (the legacy control closes
 *  over the runtime, which a `refresh` replaces). */
export type CheckedArm = CheckableArm | ((ctx: ScenarioEngine) => CheckableArm)

export interface CheckOptions {
  /** The corpus the sequence was generated for. Default: `genCorpus()` (1x). */
  corpus?: FixtureCorpus
  /** The feed the arm consumes. Default `'pooled'` (a phase a/b pool);
   *  a pool that owns its optimism reads `'truth'` (roster `mode`). */
  mode?: RowSourceMode
  /** Compare with `rebuildFromScratch()` every N steps, and after the last.
   *  Default 1; 0 never. Above 1, a failure is re-run densely over its
   *  prefix to name the exact step (a divergence that heals itself between
   *  two checkpoints goes unseen: the price of sampling). */
  rebuildEvery?: number
  /** Compare with the oracle every N steps, and after the last. Default 10;
   *  0 never. */
  oracleEvery?: number
  /** Shrink a failure. Default true. */
  shrink?: boolean
  /** Predicate runs the shrinker may spend. Default 200. */
  maxShrinkRuns?: number
  /**
   * POD-4574 (Mc2) — route generated edits through a phase-c arm's write API
   * (forwarded to `startGenRun`): the arm owns its optimism and is compared
   * with the overlaid oracle. Absent: edits go through the runtime actions.
   */
  editViaArm?: ArmEditFn
  /**
   * Called after every settled step with the LIVE handle — after a `refresh`
   * disposes the old arm and creates the new one over the new feed, so this
   * always sees the current arm (unlike a feed subscription made before the
   * swap). Runs before the step's comparisons. Not forwarded to `startGenRun`
   * (whose hook runs inside `apply`, before the swap).
   */
  onStep?: (step: StepResult, run: GenRun, handle: CheckableArmHandle) => void | Promise<void>
}

export type Against = 'rebuild' | 'oracle'

export interface Divergence {
  /** Index into the sequence of the change after which it showed; -1 is the
   *  bootstrap, before any change. */
  step: number
  change: Change | null
  against: Against
  diff: string
}

export interface CheckTiming {
  applyMs: number
  snapshotMs: number
  rebuildMs: number
  oracleMs: number
}

export interface CheckCounts {
  steps: number
  /** Steps the runner skipped (target gone): compared all the same. */
  skipped: number
  rebuildChecks: number
  oracleChecks: number
  /** Arms created: one at boot, one per `refresh`. */
  creates: number
}

export type CheckResult =
  | { ok: true; counts: CheckCounts; timing: CheckTiming }
  | (Divergence & {
      ok: false
      counts: CheckCounts
      timing: CheckTiming
      /** The minimal failing sequence (1-minimal under the shrinker), or the
       *  raw failing prefix when shrinking was off. */
      shrunk: Change[]
      /** What the shrunk sequence produces. */
      shrunkDivergence: Divergence | null
      shrinkRuns: number
    })

/** Run `sequence` against `arm` and compare after every step. */
export async function checkArm(
  arm: CheckedArm,
  sequence: readonly Change[],
  opts: CheckOptions = {},
): Promise<CheckResult> {
  const first = await runCheck(arm, sequence, opts)
  if (first.divergence === null) return { ok: true, counts: first.counts, timing: first.timing }
  let raw = first.divergence
  if ((opts.rebuildEvery ?? 1) > 1 || (opts.oracleEvery ?? 10) > 1) {
    // Sampled checkpoints: re-run the failing prefix comparing both after
    // EVERY step, so the report names the first step that diverged, not the
    // checkpoint that noticed. Deterministic, so it fails at or before it.
    const dense = await runCheck(arm, sequence.slice(0, raw.step + 1), {
      ...opts,
      rebuildEvery: 1,
      oracleEvery: (opts.oracleEvery ?? 10) > 0 ? 1 : 0,
    })
    if (dense.divergence !== null) raw = dense.divergence
  }
  const prefix = sequence.slice(0, raw.step + 1)
  let shrunk: Change[] = [...prefix]
  let shrinkRuns = 0
  if (opts.shrink ?? true) {
    if (prefix.length > 0) {
      const fails = async (candidate: readonly Change[]): Promise<boolean> =>
        (await runCheck(arm, candidate, opts)).divergence !== null
      const result = await shrink(prefix, fails, { maxRuns: opts.maxShrinkRuns ?? 200 })
      shrunk = result.result
      shrinkRuns = result.runs
    }
  }
  const replay = await runCheck(arm, shrunk, opts)
  return {
    ok: false,
    ...raw,
    counts: first.counts,
    timing: first.timing,
    shrunk,
    shrunkDivergence: replay.divergence,
    shrinkRuns,
  }
}

interface RunOutcome {
  divergence: Divergence | null
  counts: CheckCounts
  timing: CheckTiming
}

async function runCheck(
  arm: CheckedArm,
  sequence: readonly Change[],
  opts: CheckOptions,
): Promise<RunOutcome> {
  const rebuildEvery = opts.rebuildEvery ?? 1
  const oracleEvery = opts.oracleEvery ?? 10
  const counts: CheckCounts = {
    steps: 0,
    skipped: 0,
    rebuildChecks: 0,
    oracleChecks: 0,
    creates: 0,
  }
  const timing: CheckTiming = { applyMs: 0, snapshotMs: 0, rebuildMs: 0, oracleMs: 0 }
  const run = await startGenRun({
    ...(opts.corpus ? { corpus: opts.corpus } : {}),
    feedMode: opts.mode ?? 'pooled',
    ...(opts.editViaArm ? { editViaArm: opts.editViaArm } : {}),
  })
  const armOf = (ctx: ScenarioEngine): CheckableArm => (typeof arm === 'function' ? arm(ctx) : arm)
  let feed = run.feed()
  let locals = createEngineLocals(run.ctx.engine)
  const create = (): CheckableArmHandle => {
    counts.creates += 1
    return armOf(run.ctx).create(feed.source, locals.source)
  }
  let handle = create()

  const compare = (
    step: number,
    change: Change | null,
    withRebuild: boolean,
    withOracle: boolean,
  ): Divergence | null => {
    // The step settled over macrotasks, so the locals drain (a microtask) has
    // run; flushing makes that explicit.
    locals.flush()
    let t = performance.now()
    const actual = handle.snapshot()
    timing.snapshotMs += performance.now() - t
    if (withRebuild) {
      t = performance.now()
      const rebuilt = handle.rebuildFromScratch()
      timing.rebuildMs += performance.now() - t
      counts.rebuildChecks += 1
      const diff = diffSnapshots(actual, rebuilt)
      if (diff !== null) return { step, change, against: 'rebuild', diff }
    }
    if (withOracle) {
      t = performance.now()
      const expected = oracleSnapshot(run.referenceState(ctx.engine))
      timing.oracleMs += performance.now() - t
      counts.oracleChecks += 1
      const diff = diffSnapshots(actual, expected)
      if (diff !== null) return { step, change, against: 'oracle', diff }
    }
    return null
  }

  try {
    const boot = compare(-1, null, rebuildEvery > 0, oracleEvery > 0)
    if (boot !== null) return { divergence: boot, counts, timing }
    for (const [index, change] of sequence.entries()) {
      const t = performance.now()
      const step = await run.apply(change)
      timing.applyMs += performance.now() - t
      counts.steps += 1
      if (step.skipped !== undefined) counts.skipped += 1
      if (run.feed() !== feed) {
        // A reload: a new page, so a new arm over the new engine's feed and
        // locals.
        handle.dispose()
        locals.dispose()
        feed = run.feed()
        locals = createEngineLocals(run.ctx.engine)
        handle = create()
      }
      const last = index === sequence.length - 1
      const withRebuild = rebuildEvery > 0 && ((index + 1) % rebuildEvery === 0 || last)
      const withOracle = oracleEvery > 0 && ((index + 1) % oracleEvery === 0 || last)
      if (!withRebuild && !withOracle && opts.onStep === undefined) continue
      // The subscriber hook sees the live handle: after a reload above, that
      // is the new arm over the new feed (an in-apply hook would still hold
      // the disposed one).
      await opts.onStep?.(step, run, handle)
      if (!withRebuild && !withOracle) continue
      const divergence = compare(index, change, withRebuild, withOracle)
      if (divergence !== null) return { divergence, counts, timing }
    }
    return { divergence: null, counts, timing }
  } finally {
    handle.dispose()
    locals.dispose()
    run.dispose()
  }
}

// ----------------------------------------------------------------------- diff

const MAX_ROWS_REPORTED = 5

/**
 * Null when the two snapshots are deep-equal; otherwise every kind of
 * difference, bounded: the row set, up to five rows' differing fields, the
 * pinned ids and each group (key, label, row ids, closed ids; first index
 * that differs, order-sensitive).
 */
export function diffSnapshots(actual: SliceSnapshot, expected: SliceSnapshot): string | null {
  if (isDeepStrictEqual(actual, expected)) return null
  const lines: string[] = []

  const actualIds = new Set(Object.keys(actual.rowsById))
  const expectedIds = new Set(Object.keys(expected.rowsById))
  const missing = [...expectedIds].filter((id) => !actualIds.has(id))
  const extra = [...actualIds].filter((id) => !expectedIds.has(id))
  if (missing.length > 0) lines.push(`rows missing (${missing.length}): ${head(missing)}`)
  if (extra.length > 0) lines.push(`rows extra (${extra.length}): ${head(extra)}`)
  const changed: string[] = []
  for (const id of expectedIds) {
    if (!actualIds.has(id)) continue
    const a = actual.rowsById[id] as unknown as Record<string, unknown>
    const e = expected.rowsById[id] as unknown as Record<string, unknown>
    if (isDeepStrictEqual(a, e)) continue
    const fields = [...new Set([...Object.keys(a), ...Object.keys(e)])]
      .filter((k) => !isDeepStrictEqual(a[k], e[k]))
      .map((k) => `${k}: ${JSON.stringify(a[k])} (expected ${JSON.stringify(e[k])})`)
    changed.push(`row ${id}: ${fields.join(', ')}`)
  }
  if (changed.length > 0) {
    lines.push(`rows differing (${changed.length}):`)
    for (const line of changed.slice(0, MAX_ROWS_REPORTED)) lines.push(`  ${line}`)
    if (changed.length > MAX_ROWS_REPORTED)
      lines.push(`  … ${changed.length - MAX_ROWS_REPORTED} more`)
  }

  const pinned = listDiff(actual.order.pinnedIds, expected.order.pinnedIds)
  if (pinned !== null) lines.push(`pinnedIds: ${pinned}`)
  const aKeys = actual.order.groups.map((g) => g.key)
  const eKeys = expected.order.groups.map((g) => g.key)
  if (!isDeepStrictEqual(aKeys, eKeys)) {
    lines.push(`group keys: ${JSON.stringify(aKeys)} (expected ${JSON.stringify(eKeys)})`)
  }
  const byKey = new Map(actual.order.groups.map((g) => [g.key, g] as const))
  for (const e of expected.order.groups) {
    const a = byKey.get(e.key)
    if (a === undefined) continue
    lines.push(...groupDiff(a, e))
  }

  // Deep-unequal with nothing named above: a key outside the frozen shape.
  if (lines.length === 0)
    lines.push(`snapshots differ outside rows and order: ${JSON.stringify(actual).slice(0, 300)}`)
  return lines.join('\n')
}

/**
 * WHOLE VIEWS (POD-4674, H3-F3). `diffSnapshots` compares slice rows
 * (`sliceRowOf`): `activityAt`, `originTick`, `selected`, `pinned`,
 * `sortKey`, `createdAt`, `seq`, `foldAt` and `dismissed` reach none of
 * them. Both pool gates hold every visible issue's whole `RowView` (`live`)
 * to their rebuild's (`want`, the rule table run directly over the feed's
 * rows) with this, at every compared step. Up to `limit` lines, one per
 * differing field; a row the live side has no view for is named too. The
 * row SET is the snapshot comparison's.
 */
export function diffViews(
  live: (id: string) => RowView | undefined,
  want: ReadonlyMap<string, RowView>,
  limit = 6,
): string[] {
  const out: string[] = []
  for (const [id, expected] of want) {
    const got = live(id) as Record<string, unknown> | undefined
    if (got === undefined) {
      out.push(`${id}: live has no view`)
    } else {
      const direct = expected as unknown as Record<string, unknown>
      for (const field of new Set([...Object.keys(direct), ...Object.keys(got)])) {
        if (isDeepStrictEqual(got[field], direct[field])) continue
        out.push(
          `${id}.${field}: live ${JSON.stringify(got[field])}, direct ${JSON.stringify(direct[field])}`,
        )
      }
    }
    if (out.length >= limit) return out.slice(0, limit)
  }
  return out
}

function groupDiff(a: SliceGroup, e: SliceGroup): string[] {
  const out: string[] = []
  if (a.label !== e.label)
    out.push(
      `group ${e.key} label: ${JSON.stringify(a.label)} (expected ${JSON.stringify(e.label)})`,
    )
  const rows = listDiff(a.rowIds, e.rowIds)
  if (rows !== null) out.push(`group ${e.key} rowIds: ${rows}`)
  const closed = listDiff(a.closedIds, e.closedIds)
  if (closed !== null) out.push(`group ${e.key} closedIds: ${closed}`)
  return out
}

/** Order-sensitive: the first index that differs, with a little context. */
function listDiff(a: readonly string[], e: readonly string[]): string | null {
  if (isDeepStrictEqual(a, e)) return null
  let at = 0
  while (at < a.length && at < e.length && a[at] === e[at]) at += 1
  const from = Math.max(0, at - 1)
  return (
    `first difference at ${at} of ${e.length} (actual length ${a.length}): ` +
    `actual [${a.slice(from, at + 3).join(', ')}] expected [${e.slice(from, at + 3).join(', ')}]`
  )
}

function head(ids: readonly string[]): string {
  return ids.slice(0, MAX_ROWS_REPORTED).join(', ') + (ids.length > MAX_ROWS_REPORTED ? ', …' : '')
}

/** One line per change, for reports. */
export function describeSequence(changes: readonly Change[]): string {
  return changes.map((c, i) => `${i}: ${JSON.stringify(c)}`).join('\n')
}
