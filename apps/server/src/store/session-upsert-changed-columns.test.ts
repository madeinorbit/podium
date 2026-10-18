/**
 * THE SESSION UPSERT SETS ONLY THE INDEXED COLUMNS THAT CHANGED [POD-6234], and
 * stores exactly what the full write stored.
 *
 * Two databases take the same corpus of session writes. The NARROW one writes
 * inside transactions, where the store knows what each row holds and leaves
 * unchanged indexed columns out of the ON CONFLICT set. The FULL one writes with
 * no span open, where the store cannot know and names every column: the set the
 * upsert always had. After every step the two tables must be identical, and the
 * statements the narrow side ran must actually be narrow, so a parity that only
 * held because every write fell back to the full set fails here.
 *
 * The corpus covers the expressions that keep a value (COALESCE birth refs and
 * attribution, the one-way conversation binding), the other writers of the
 * table (tombstone, issue restore, detach), a rollback, a nested savepoint
 * rolled back under an outer span that commits, and a store reopened over rows
 * it never wrote (a restart, where a session holds `reconnecting` for a row
 * stored as `live`).
 */

import { actorUser, asIssueId, asMachineId, asSessionId, asUserId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor, statementProbeHubFor } from './executor'
import { SessionsRepository } from './sessions'
import type { SessionRow } from './types'

const OWNER = asUserId('user:owner')
const ISSUE = asIssueId('iss_one')

interface Side {
  readonly db: SqlDatabase
  readonly sessions: SessionsRepository
  readonly write: <T>(fn: () => Promise<T>) => Promise<T>
}

function openSide(db: SqlDatabase, inTransaction: boolean): Side {
  const queries = createBunStoreExecutor({ database: db }).queries
  if (!queries) throw new Error('the synchronous query capability is absent on this handle')
  return {
    db,
    sessions: new SessionsRepository(queries),
    write: inTransaction ? queries.createOrJoinTransaction : async (fn) => await fn(),
  }
}

function row(id: string, patch: Omit<Partial<SessionRow>, 'id'> = {}): SessionRow {
  return {
    id: asSessionId(id),
    ownerUserId: OWNER,
    agentKind: 'claude-code',
    cwd: '/repo/a',
    title: `title ${id}`,
    name: null,
    nameSource: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: null,
    resumeValue: null,
    status: 'live',
    exitCode: null,
    spawnFailure: null,
    durableLabel: `label-${id}`,
    createdAt: '2026-10-18T00:00:00.000Z',
    lastActiveAt: '2026-10-18T00:00:00.000Z',
    geometry: { cols: 80, rows: 24 },
    archived: false,
    workState: null,
    machineId: asMachineId('machine-1'),
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    issueId: null,
    ...patch,
  } as SessionRow
}

const tableOf = (db: SqlDatabase): unknown[] => db.prepare('SELECT * FROM sessions ORDER BY id').all()

/** The ON CONFLICT set of a captured session upsert, as its column names. */
function setColumns(sql: string): string[] {
  const set = sql.slice(sql.indexOf(' do update set ') + ' do update set '.length)
  return [...set.matchAll(/"(\w+)" = /g)].map((match) => match[1]!)
}

let narrow: Side
let full: Side
let upserts: string[]
let detach: () => void

beforeEach(() => {
  narrow = openSide(openMigratedTestDatabase(), true)
  full = openSide(openMigratedTestDatabase(), false)
  upserts = []
  detach = statementProbeHubFor(narrow.db).attach((observation) => {
    if (observation.sql.startsWith('insert into "sessions"') && !observation.failed) upserts.push(observation.sql)
  })
})

afterEach(() => {
  detach()
  narrow.db.close()
  full.db.close()
})

/** One step on both sides, then the tables must match. Returns what the narrow side set. */
async function both(step: (side: Side) => Promise<void>): Promise<string[][]> {
  upserts = []
  await narrow.write(() => step(narrow))
  await full.write(() => step(full))
  expect(tableOf(narrow.db)).toEqual(tableOf(full.db))
  return upserts.map(setColumns)
}

const put = ({ id, ...patch }: Omit<Partial<SessionRow>, 'id'> & { id: string }) => (side: Side) =>
  side.sessions.upsertSession(row(id, patch))

describe('session upsert parity with the full write', () => {
  it('stores what the full write stored, and leaves unchanged indexed columns out', async () => {
    await both(put({ id: 's1' }))
    await both(put({ id: 's2', cwd: '/repo/b' }))

    // A rename: no indexed column moved, so none is set; the row record is.
    const [rename] = await both(put({ id: 's1', title: 'renamed', name: 'renamed', nameSource: 'user' }))
    expect(rename).toContain('title')
    expect(rename).toContain('last_active_at')
    for (const indexed of ['status', 'cwd', 'machine_id', 'issue_id', 'resume_value', 'deleted_at', 'ref_issue_id'])
      expect(rename).not.toContain(indexed)

    // A status move sets status and nothing else indexed.
    const [stopped] = await both(put({ id: 's1', title: 'renamed', name: 'renamed', nameSource: 'user', status: 'exited', exitCode: 0 }))
    expect(stopped).toContain('status')
    expect(stopped).not.toContain('cwd')

    // Binding a conversation, then a stale write that says it never had one.
    await both(put({ id: 's2', cwd: '/repo/b', resumeKind: 'claude', resumeValue: 'conv-1', conversationBinding: 'bound' }))
    await both(put({ id: 's2', cwd: '/repo/b', resumeKind: 'claude', resumeValue: 'conv-1', conversationBinding: 'never' }))

    // Birth ref and attribution are kept from the first write that set them.
    await both(put({ id: 's2', cwd: '/repo/b', resumeKind: 'claude', resumeValue: 'conv-1', refIssueId: ISSUE, refLetter: 'a', createdBy: { actor: actorUser(OWNER), onBehalfOf: OWNER } }))
    await both(put({ id: 's2', cwd: '/repo/b', resumeKind: 'claude', resumeValue: 'conv-1', refIssueId: asIssueId('iss_other'), refLetter: 'b' }))
    await both(put({ id: 's2', cwd: '/repo/b', resumeKind: 'claude', resumeValue: 'conv-1', refIssueId: null, refLetter: null }))

    // A reattach moves issue and place together.
    const [reattach] = await both(put({ id: 's2', cwd: '/repo/c', issueId: ISSUE, machineId: asMachineId('machine-2'), resumeKind: 'claude', resumeValue: 'conv-1' }))
    expect(reattach).toEqual(expect.arrayContaining(['issue_id', 'cwd', 'machine_id']))
    expect(reattach).not.toContain('status')
  })

  it('matches across the activity flush, whose rows share one statement', async () => {
    await both(async (side) => {
      await side.sessions.upsertSession(row('a'))
      await side.sessions.upsertSession(row('b'))
      await side.sessions.upsertSession(row('c', { status: 'exited', exitCode: 1 }))
    })
    const counters = (n: number) => ({ inputCount: n, outputCount: n * 2, activityCount: n * 3, lastOutputAt: `2026-10-18T00:00:0${n}.000Z` })
    const [quiet] = await both((side) => side.sessions.upsertSessions([row('a', counters(1)), row('b', counters(1)), row('c', { status: 'exited', exitCode: 1, ...counters(1) })]))
    expect(quiet).not.toContain('status')
    const [moved] = await both((side) => side.sessions.upsertSessions([row('a', { ...counters(2), status: 'exited', exitCode: 0 }), row('b', counters(2))]))
    expect(moved).toContain('status')
    expect(moved).not.toContain('cwd')
    // A place change in one row sets every group for the chunk.
    const [wide] = await both((side) => side.sessions.upsertSessions([row('a', { ...counters(3), status: 'exited', exitCode: 0 }), row('b', { ...counters(3), cwd: '/elsewhere' })]))
    expect(wide).toEqual(expect.arrayContaining(['status', 'cwd', 'issue_id']))
    // Once more with nothing indexed moving, after the wide write.
    const [after] = await both((side) => side.sessions.upsertSessions([row('a', { ...counters(4), status: 'exited', exitCode: 0 }), row('b', { ...counters(4), cwd: '/elsewhere' })]))
    expect(after).not.toContain('status')
  })

  it('matches after the table is written some other way', async () => {
    await both(put({ id: 't1', issueId: ISSUE, refIssueId: ISSUE, refLetter: 'a' }))
    await both(put({ id: 't2', issueId: ISSUE }))
    await both(async (side) => await side.sessions.softDeleteForIssue(['t1', 't2'], ISSUE, '2026-10-18T01:00:00.000Z'))
    // A stale in-memory copy written back after the tombstone: the full write
    // untombstones it, and so must the narrow one.
    await both(put({ id: 't1', issueId: ISSUE, refIssueId: ISSUE, refLetter: 'a' }))
    await both(async (side) => await side.sessions.restoreDeletedForIssue(ISSUE))
    await both(put({ id: 't2', issueId: ISSUE }))
    await both(async (side) => await side.sessions.softDeleteSessions(['t2'], '2026-10-18T02:00:00.000Z', 'standalone'))
    await both(async (side) => await side.sessions.detachTombstonesFromIssue(ISSUE))
    await both(put({ id: 't2', issueId: ISSUE }))
  })

  it('matches after a rolled-back write and a rolled-back savepoint', async () => {
    await both(put({ id: 'r1' }))
    // Rolled back whole: the row stays `live`, so a next write of the `exited`
    // the rollback staged must still set status.
    await expect(
      narrow.write(async () => {
        await narrow.sessions.upsertSession(row('r1', { status: 'exited', exitCode: 0 }))
        throw new Error('roll back')
      }),
    ).rejects.toThrow('roll back')
    const [afterRollback] = await both(put({ id: 'r1', status: 'exited', exitCode: 0 }))
    expect(afterRollback).toContain('status')

    // The row is `exited`. The outer span writes `live`, a savepoint writes
    // `hibernated` and rolls back, and the outer span then writes `exited` and
    // commits. The row held `live` when that last write ran, so it must set
    // status even though `exited` is the committed value it started from.
    await narrow.write(async () => {
      await narrow.sessions.upsertSession(row('r1'))
      await expect(
        narrow.write(async () => {
          await narrow.sessions.upsertSession(row('r1', { status: 'hibernated' }))
          throw new Error('roll back the savepoint')
        }),
      ).rejects.toThrow('roll back the savepoint')
      await narrow.sessions.upsertSession(row('r1', { status: 'exited', exitCode: 0 }))
    })
    await full.sessions.upsertSession(row('r1', { status: 'exited', exitCode: 0 }))
    expect(tableOf(narrow.db)).toEqual(tableOf(full.db))
    const [settled] = await both(put({ id: 'r1', status: 'exited', exitCode: 0, title: 'settled' }))
    expect(settled).not.toContain('status')
  })

  it('writes a row whole from a store that never wrote it', async () => {
    await both(put({ id: 'b1' }))
    // A restart: a new store over the same rows. The session comes back as
    // `reconnecting` while its row says `live`, and its first write (a rename)
    // must store `reconnecting`, as the full write does.
    narrow = openSide(narrow.db, true)
    const [first] = await both(put({ id: 'b1', status: 'reconnecting', title: 'renamed' }))
    expect(first).toContain('status')
    const [second] = await both(put({ id: 'b1', status: 'reconnecting', title: 'renamed again' }))
    expect(second).not.toContain('status')
  })

  it('sets only what changed against a row the store read', async () => {
    await both(put({ id: 'p1', issueId: ISSUE }))
    await both(put({ id: 'p2' }))
    // A restart, then a parked session's rename: the operation reads the row
    // (no span open) before its write, as the access check does.
    narrow = openSide(narrow.db, true)
    await narrow.sessions.getSession(asSessionId('p1'))
    await narrow.sessions.getSessions(['p2'])
    const [rename] = await both(put({ id: 'p1', issueId: ISSUE, title: 'parked rename' }))
    expect(rename).toContain('title')
    expect(rename).not.toContain('status')
    expect(rename).not.toContain('issue_id')
    // The restored session holds `reconnecting` for the stored `live`.
    const [restored] = await both(put({ id: 'p2', status: 'reconnecting' }))
    expect(restored).toContain('status')
    // A read inside a span may see that span's own writes: not recorded.
    narrow = openSide(narrow.db, true)
    await narrow.write(async () => {
      await narrow.sessions.getSession(asSessionId('p1'))
    })
    const [unread] = await both(put({ id: 'p1', issueId: ISSUE, title: 'after a span read' }))
    expect(unread).toContain('status')
  })

  it('writes every column when no span is open', async () => {
    await both(put({ id: 'n1' }))
    upserts = []
    await narrow.sessions.upsertSession(row('n1', { title: 'root write' }))
    await full.sessions.upsertSession(row('n1', { title: 'root write' }))
    expect(tableOf(narrow.db)).toEqual(tableOf(full.db))
    expect(setColumns(upserts[0]!)).toEqual(expect.arrayContaining(['status', 'cwd', 'issue_id', 'deleted_at']))
  })
})
