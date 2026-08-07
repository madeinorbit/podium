/**
 * RESOLVING A CONVERSATION'S SESSION — the query that replaced a scan (POD-1614).
 *
 * AGAINST THE REAL MIGRATED SCHEMA, for the reason `session-attribution.test.ts`
 * gives: a fake repository would agree with whatever this file asserted.
 *
 * ---------------------------------------------------------------------------
 * WHY A TIE-BREAK TEST EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * `findSessionByResumeValue` replaced `loadSessions().find(c => c.resumeValue ===
 * id)` inside the feed's visibility policy, where it decides whether a principal
 * may see a `conversation` row. Same predicate, evaluated by query instead of by
 * loading and scanning the whole table.
 *
 * `resume_value` IS NOT UNIQUE — the live corpus has 8 values shared by two live
 * sessions each — so "which row" is a real question and not a hypothetical. The
 * scan answered it with `.find()`, i.e. the FIRST row in `loadSessions()` order
 * (`created_at ASC, rowid ASC`). If the query answered with a different one, a
 * conversation could resolve to a session with a DIFFERENT OWNER, and the
 * visibility decision would flip — silently, and in the widening direction.
 *
 * A whole-corpus before/after row-set comparison cannot catch that: on the live
 * corpus every duplicated `resume_value` belongs to ONE owner (`user:sole`), so
 * both tie-breaks produce the same answer there and the comparison is blind to
 * the property. That is precisely why this case is constructed rather than
 * sampled — the two sessions below have DIFFERENT OWNERS, which is the only
 * arrangement in which picking the wrong row is observable.
 *
 * The oracle is the OLD EXPRESSION ITSELF, evaluated in the test. Asserting
 * against a hand-written expectation would grade the query against a second
 * opinion about what the scan used to do; running the scan makes the two answers
 * comparable by construction.
 */

import { asMachineId, asSessionId, asUserId } from '@podium/model'
import type { openDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { SessionsRepository } from './sessions'
import type { SessionRow } from './types'

const ALICE = asUserId('user:alice')
const BOB = asUserId('user:bob')
const SHARED = 'resume-shared'

let db: ReturnType<typeof openDatabase>
let sessions: SessionsRepository

beforeEach(() => {
  db = openMigratedTestDatabase()
  sessions = new SessionsRepository(db)
})

const row = (
  id: string,
  owner: typeof ALICE,
  createdAt: string,
  resumeValue: string | null,
): SessionRow => ({
  id: asSessionId(id),
  ownerUserId: owner,
  agentKind: 'claude-code',
  cwd: '/home/u/repo',
  title: 'a session',
  name: null,
  nameSource: null,
  originKind: 'resume',
  conversationId: null,
  resumeKind: resumeValue === null ? null : 'conversation',
  resumeValue,
  status: 'live',
  exitCode: null,
  spawnFailure: null,
  durableLabel: `label-${id}`,
  createdAt,
  lastActiveAt: createdAt,
  geometry: { cols: 80, rows: 24 },
  archived: false,
  workState: null,
  machineId: asMachineId('machine-1'),
  lastOutputAt: null,
  lastInputAt: null,
  lastResumedAt: null,
})

/** The expression this method replaced, kept as the oracle. */
const byScan = (resumeValue: string) =>
  sessions.loadSessions().find((candidate) => candidate.resumeValue === resumeValue)

describe('POD-1614 — findSessionByResumeValue answers exactly what the scan did', () => {
  it('picks the SAME row as the scan when two live sessions share a resume value', () => {
    // Inserted newest-first so a query that just took "whatever sqlite returned"
    // would have a real chance of picking the wrong one.
    sessions.upsertSession(row('sess-new', BOB, '2026-08-03T10:00:00.000Z', SHARED))
    sessions.upsertSession(row('sess-old', ALICE, '2026-08-01T10:00:00.000Z', SHARED))

    const scanned = byScan(SHARED)
    // CONTROL: the fixture really is ambiguous and the oracle really resolves it.
    // Without this, the agreement below could hold because both answered nothing.
    expect(scanned?.id).toBe(asSessionId('sess-old'))
    expect(scanned?.ownerUserId).toBe(ALICE)

    // THE ASSERTION. Same row, therefore same owner, therefore same visibility
    // decision — which is the only property the policy actually consumes.
    expect(sessions.findSessionByResumeValue(SHARED)?.id).toBe(scanned?.id)
    expect(sessions.findSessionByResumeValue(SHARED)?.ownerUserId).toBe(ALICE)
  })

  it('agrees with the scan on a unique value, and on a value nobody holds', () => {
    sessions.upsertSession(row('sess-1', ALICE, '2026-08-01T10:00:00.000Z', 'resume-unique'))

    expect(sessions.findSessionByResumeValue('resume-unique')?.id).toBe(byScan('resume-unique')?.id)
    // The refusing arm: an unknown value yields nothing from both. Without this
    // the suite would pass against a method that returned a row for everything.
    expect(sessions.findSessionByResumeValue('resume-absent')).toBeUndefined()
    expect(byScan('resume-absent')).toBeUndefined()
  })

  it('ignores a deleted session, exactly as loadSessions does', () => {
    // `loadSessions()` filters `deleted_at IS NULL`, so the scan could never
    // resolve a conversation onto a tombstone. A query that dropped that filter
    // would re-admit deleted sessions as a visibility input.
    sessions.upsertSession(row('sess-gone', ALICE, '2026-08-01T10:00:00.000Z', 'resume-gone'))
    sessions.softDeleteSessions(['sess-gone'], '2026-08-03T12:00:00.000Z', 'standalone')

    expect(byScan('resume-gone')).toBeUndefined()
    expect(sessions.findSessionByResumeValue('resume-gone')).toBeUndefined()
  })
})
