/**
 * POD-4584 (Hb3) — the ONE named exception to roll-up parity, for tests only.
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
 */

import type { FixtureCorpus } from '../../../../harness/src/fixture/index'
import type { RosterAllowances } from '../../../../harness/src/roster'
import type { ArmHandle } from '../../../../shared/src/arm'
import type { SliceSnapshot } from '../../../../shared/src/slice-types'
import type { HandPoolHandle } from '../arm'
import type { HandPool } from '../pool'

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
  pool: HandPool,
  expected: SliceSnapshot,
  actual: SliceSnapshot,
): GapOutcome {
  const none: GapOutcome = { snapshot: expected, applied: null, rows: [] }
  const { issueId, sessionId } = corpus.unscannedWorktree
  if (issueId === '') return none
  const seated = pool.visibleInputs.issue(issueId)?.memberIds.includes(sessionId) === true
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

/** Structural equality over plain row data. */
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

/**
 * POD-4678: a new explicit member re-lists its issue's `sessions` bucket, so
 * the #10 burst also reads each burst issue's other explicit sessions. The
 * family, counted from the pool BEFORE the step; 0 on every other step.
 */
export function burstFamilyReads(pool: HandPool, burstIssueIds: readonly string[]): number {
  return burstIssueIds.reduce((sum, id) => sum + (pool.worklist.issue(id)?.seatIds.length ?? 0), 0)
}

/** The pool behind a roster handle (the fences create it through `handPoolArm`). */
function poolOf(handle: ArmHandle): HandPool {
  const pool = (handle as Partial<HandPoolHandle>).pool
  if (pool === undefined) throw new Error('[known-gaps] not a hand pool handle')
  return pool
}

/**
 * POD-4694 — the page's allowances, mirroring `MOBX_POOL_ALLOWANCES`: the
 * browser hand page (`harness/web/entries/hand.ts`) carries the pool's one
 * named parity allowance, POD-4671's row, as the fence roster does.
 */
export const HAND_POOL_ALLOWANCES: RosterAllowances = {
  parity: {
    issue: 'POD-4671',
    accept: (corpus, handle, expected, actual) =>
      acceptUnscannedGap(corpus, poolOf(handle), expected, actual),
  },
}
