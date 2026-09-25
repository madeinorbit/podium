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
 * THE CORPUS IS THE ONE INSTALLED. A caller passes the corpus whose rows the
 * engine holds: at the browser page's rescope (L5e) that is the grown one, so
 * its own orphan (2x `i4944`) is the one row. POD-4572 found the rescope
 * staging the grown ROWS without their SCANS, which left seven 2x issue
 * worktrees unscanned at the grown state; the coordinator ruled to fix the
 * harness (`harness/src/rescope.ts` stages both) rather than widen this
 * exception, and `harness/src/rescope.test.ts` shows the grown state has no
 * unscanned worktree but the orphan's.
 *
 * THE ROSTER'S ALLOWANCES (POD-4572, `MOBX_POOL_ALLOWANCES`): the pool on the
 * fence roster (`harness/src/roster.ts`) carries exactly the exceptions Mb3
 * named, each removed by its issue: this gap on parity (POD-4671). POD-4678
 * (#10 burst's re-listed `sessions` family) went with its fix: the seat set
 * is maintained from the relation's own delta, so a membership change reads
 * O(1). The third, rows whose oracle view moved in `activityAt` alone on the
 * commit fence, went with its fix (POD-4674: `activityAt` is the legacy's).
 * `fences.test.tsx` fails when one of them is never applied.
 */

import type { FixtureCorpus } from '../../../../harness/src/fixture/index'
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
  /** `[applied]`, or empty. */
  readonly rows: readonly string[]
}

export function acceptUnscannedGap(
  corpus: Pick<FixtureCorpus, 'unscannedWorktree'>,
  pool: MobxPool,
  expected: SliceSnapshot,
  actual: SliceSnapshot,
): GapOutcome {
  const none: GapOutcome = { snapshot: expected, applied: null, rows: [] }
  const { issueId, sessionId } = corpus.unscannedWorktree
  if (issueId === '') return none
  const seated = tracked(() => pool.worklist.issue(issueId)?.memberIds.includes(sessionId) === true)
  if (seated) {
    throw new Error(
      `POD-4671 is fixed: the pool seats ${sessionId} under ${issueId}; delete acceptUnscannedGap`,
    )
  }
  const want = expected.rowsById[issueId] as unknown as Record<string, unknown> | undefined
  const got = actual.rowsById[issueId] as unknown as Record<string, unknown> | undefined
  if (want === undefined || got === undefined || same(want, got)) return none
  const fields = Object.keys(want).filter((field) => !same(want[field], got[field]))
  if (fields.some((field) => !SEAT_FIELDS.includes(field))) return none
  return {
    snapshot: {
      ...expected,
      rowsById: { ...expected.rowsById, [issueId]: actual.rowsById[issueId]! },
    },
    applied: issueId,
    rows: [issueId],
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

export const MOBX_POOL_ALLOWANCES: RosterAllowances = {
  parity: {
    issue: 'POD-4671',
    accept: (corpus, handle, expected, actual) =>
      acceptUnscannedGap(corpus, poolOf(handle), expected, actual),
  },
}
