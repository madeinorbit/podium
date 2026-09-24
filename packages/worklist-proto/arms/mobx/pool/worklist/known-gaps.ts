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
 */

import { isDeepStrictEqual } from 'node:util'
import type { FixtureCorpus } from '../../../../harness/src/fixture/index'
import type { SliceSnapshot } from '../../../../shared/src/slice-types'
import { type MobxPool, tracked } from '../pool'

/** The fields the orphan's seat feeds on its issue's row. */
const SEAT_FIELDS: ReadonlySet<string> = new Set(['phase', 'working', 'asking'])

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
  const seated = tracked(
    () => pool.worklist.issue(issueId)?.memberIds.includes(sessionId) === true,
  )
  if (seated) {
    throw new Error(
      `POD-4671 is fixed: the pool seats ${sessionId} under ${issueId}; delete acceptUnscannedGap`,
    )
  }
  const want = expected.rowsById[issueId] as unknown as Record<string, unknown> | undefined
  const got = actual.rowsById[issueId] as unknown as Record<string, unknown> | undefined
  if (want === undefined || got === undefined || isDeepStrictEqual(want, got)) {
    return { snapshot: expected, applied: null }
  }
  const fields = Object.keys(want).filter((field) => !isDeepStrictEqual(want[field], got[field]))
  if (fields.some((field) => !SEAT_FIELDS.has(field))) return { snapshot: expected, applied: null }
  return {
    snapshot: {
      ...expected,
      rowsById: { ...expected.rowsById, [issueId]: actual.rowsById[issueId]! },
    },
    applied: issueId,
  }
}
