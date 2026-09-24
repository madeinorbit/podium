/**
 * POD-4571 (Mb3) — the ONE named exception to roll-up parity, for tests only.
 *
 * POD-4671: the legacy seats a session with no `issueId` under an issue by
 * containment against the scanned lanes PLUS every issue's own
 * `worktreePath` (`session-ownership.ts:128-141`); the shared schema's R3
 * prefix relation knows scanned lanes only. The fixture carries the case on
 * purpose (`corpus.unscannedWorktree`, POD-4550): one issue whose only
 * working seat sits under an unscanned worktree, so the oracle reads it
 * `working` and the pool, which never seats that session, does not.
 *
 * `acceptUnscannedGap` takes the oracle's snapshot and the pool's, and when
 * (and only when) the pool has not seated the corpus's orphan session under
 * its issue, and that issue's row differs from the oracle's in the roll-up
 * fields the seat feeds and nowhere else, it returns the oracle snapshot with
 * the pool's row for that issue. Anything else is left for the diff to show.
 * THE TRIPWIRE: once the pool seats the session (POD-4671 fixed), it throws,
 * so this exception is deleted with the fix.
 *
 * THE ROSTER'S ALLOWANCES (POD-4572, `MOBX_POOL_ALLOWANCES`): the pool on the
 * fence roster (`harness/src/roster.ts`) carries exactly the exceptions Mb3
 * named, each removed by its issue: this gap on parity (POD-4671), rows whose
 * oracle view moved in `activityAt` alone on the commit fence (POD-4674), and
 * the #10 burst's re-listed `sessions` family on the reads fence (POD-4678).
 * `fences.test.tsx` fails when one of them is never applied.
 */

import type { FixtureCorpus } from '../../../../harness/src/fixture/index'
import type { CountResult } from '../../../../harness/src/count-harness'
import type { RowViews } from '../../../../harness/src/oracle/index'
import type { RosterAllowances } from '../../../../harness/src/roster'
import type { ArmHandle } from '../../../../shared/src/arm'
import type { SliceSnapshot } from '../../../../shared/src/slice-types'
import type { MobxPoolHandle } from '../arm'
import { type MobxPool, tracked } from '../pool'

/** The fields the orphan's seat feeds on its issue's row. */
const SEAT_FIELDS: readonly string[] = ['phase', 'working', 'asking']

export interface GapOutcome {
  readonly snapshot: SliceSnapshot
  /** The issue whose row the exception took from the pool, or null when it was not needed. */
  readonly applied: string | null
}

export function acceptUnscannedGap(
  corpus: Pick<FixtureCorpus, 'unscannedWorktree'>,
  pool: MobxPool,
  expected: SliceSnapshot,
  actual: SliceSnapshot,
): GapOutcome {
  const { issueId, sessionId } = corpus.unscannedWorktree
  if (issueId === '') return { snapshot: expected, applied: null }
  const seated = tracked(() => pool.worklist.issue(issueId)?.memberIds.includes(sessionId) === true)
  if (seated) {
    throw new Error(
      `POD-4671 is fixed: the pool seats ${sessionId} under ${issueId}; delete acceptUnscannedGap`,
    )
  }
  const want = expected.rowsById[issueId] as unknown as Record<string, unknown> | undefined
  const got = actual.rowsById[issueId] as unknown as Record<string, unknown> | undefined
  if (want === undefined || got === undefined || same(want, got)) {
    return { snapshot: expected, applied: null }
  }
  const fields = Object.keys(want).filter((field) => !same(want[field], got[field]))
  if (fields.some((field) => !SEAT_FIELDS.includes(field)))
    return { snapshot: expected, applied: null }
  return {
    snapshot: {
      ...expected,
      rowsById: { ...expected.rowsById, [issueId]: actual.rowsById[issueId]! },
    },
    applied: issueId,
  }
}

/**
 * Structural equality over plain row data (the browser page runs this too,
 * so no `node:util`).
 */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(
    (key) =>
      Object.hasOwn(b, key) &&
      same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  )
}

/** The pool behind a roster handle (the fences create it through `mobxPoolArm`). */
function poolOf(handle: ArmHandle): MobxPool {
  const pool = (handle as Partial<MobxPoolHandle>).pool
  if (pool === undefined) throw new Error('[known-gaps] not a MobX pool handle')
  return pool
}

/**
 * POD-4674 (owns `activityAt` in both pools; the legacy raises it by the
 * nested seats, `rows.ts:336-339`): the rows the oracle changed that stayed
 * undrawn, accepted only when each one's oracle view moved in `activityAt`
 * ALONE. An over-draw, or a miss in any other field, throws the fence's own
 * error.
 */
export function acceptActivityOnlyUndrawn(
  result: CountResult,
  before: RowViews,
  after: RowViews,
  fenceError: Error,
): string[] {
  const drawn = new Set(result.drawnRows ?? [])
  const changed = new Set(result.oracleChangedRows ?? [])
  if ([...drawn].some((id) => !changed.has(id))) throw fenceError
  const under = [...changed].filter((id) => !drawn.has(id))
  for (const id of under) {
    const a = before[id] as unknown as Record<string, unknown> | undefined
    const b = after[id] as unknown as Record<string, unknown> | undefined
    if (a === undefined || b === undefined) throw fenceError
    const fields = Object.keys(b).filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]))
    if (fields.some((f) => f !== 'activityAt')) throw fenceError
  }
  return under.sort()
}

/**
 * POD-4678: a new explicit member re-lists its issue's `sessions` bucket, so
 * the #10 burst also reads each burst issue's other explicit sessions. The
 * family, counted from the pool BEFORE the step; 0 on every other step.
 */
export function burstFamilyReads(pool: MobxPool, burstIssueIds: readonly string[]): number {
  return tracked(() =>
    burstIssueIds.reduce((sum, id) => sum + (pool.worklist.issue(id)?.seatIds.length ?? 0), 0),
  )
}

export const MOBX_POOL_ALLOWANCES: RosterAllowances = {
  parity: {
    issue: 'POD-4671',
    accept: (ctx, handle, expected, actual) =>
      acceptUnscannedGap(ctx.corpus, poolOf(handle), expected, actual),
  },
  undrawn: {
    issue: 'POD-4674',
    accept(result, before, after) {
      const error = new Error(
        `[commits] ${result.scenario} (${result.methodology}): beyond POD-4674's activityAt allowance: ` +
          `changed=[${(result.oracleChangedRows ?? []).join(',')}] drawn=[${(result.drawnRows ?? []).join(',')}]`,
      )
      return acceptActivityOnlyUndrawn(result, before, after, error)
    },
  },
  reads: {
    issue: 'POD-4678',
    before: (ctx, handle, step) =>
      step.methodology === '#10' ? burstFamilyReads(poolOf(handle), ctx.targets.burstIssueIds) : 0,
  },
}
