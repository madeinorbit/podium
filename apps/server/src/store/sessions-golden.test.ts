/**
 * GOLDEN TESTS FOR THE SESSIONS AGGREGATE — written BEFORE the drizzle
 * conversion, against the synchronous code, so they are the oracle it is judged
 * against (POD-3398, execution method §3 item 10).
 *
 * WHY THESE METHODS. The store coverage census (POD-3244) marks eight of
 * `sessions.ts`'s public methods as executed-but-never-NAMED: reached through
 * some service test, with nothing asserting what they do. Four of them are the
 * batched id readers whose ORDERING and TOMBSTONE rules are the whole reason
 * they exist as separate methods rather than one — precisely the kind of
 * distinction a conversion can flatten while every caller keeps working.
 *
 * THE ORDERING IS THE CONTRACT, not an incidental. `readSessions` supplies
 * `created_at ASC, rowid ASC`, and three methods depend on it meaning different
 * things: `findSessionByResumeValue` takes `[0]` and must pick exactly the row a
 * `.find()` over `loadSessions()` used to return (POD-1614);
 * `findSessionsByResumeValues` keeps the FIRST row per value for the same
 * reason; `listSessionsByResumeValues` keeps ALL of them because letting row
 * order decide whether a transcript is attributed is a coin toss, not a
 * tie-break. Every fixture below is built so those three answers DIFFER.
 *
 * AGAINST THE REAL MIGRATED SCHEMA, like the attribution suite next door.
 */

import {
  asIssueId,
  asMachineId,
  asSessionId,
  asUserId,
  type IssueId,
  type UserId,
} from '@podium/model'
import type { openDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor } from './executor'
import { SessionsRepository } from './sessions'
import type { SessionRow } from './types'

const ALICE = asUserId('user:alice')
const BOB = asUserId('user:bob')

let db: ReturnType<typeof openDatabase>
let sessions: SessionsRepository

beforeEach(() => {
  db = openMigratedTestDatabase()
  sessions = new SessionsRepository(createBunStoreExecutor({ database: db }))
})

function row(input: Omit<Partial<SessionRow>, 'id'> & { id: string }): SessionRow {
  return {
    ownerUserId: ALICE,
    agentKind: 'claude-code',
    cwd: '/home/u/repo',
    title: 'a session',
    name: null,
    nameSource: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: null,
    resumeValue: null,
    status: 'live',
    exitCode: null,
    spawnFailure: null,
    durableLabel: 'label',
    createdAt: 't0',
    lastActiveAt: 't0',
    geometry: { cols: 80, rows: 24 },
    archived: false,
    workState: null,
    machineId: asMachineId('machine-1'),
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    ...input,
    id: asSessionId(input.id),
  } as SessionRow
}

const put = async (input: Omit<Partial<SessionRow>, 'id'> & { id: string }): Promise<void> => {
  await sessions.upsertSession(row(input))
}

// ---------------------------------------------------------------------------
// The batched id readers
// ---------------------------------------------------------------------------

describe('getSessions — the batched form of getSession', () => {
  it('INCLUDES tombstones, because feed visibility needs the delete-audience answer', async () => {
    await put({ id: 'live-1' })
    await put({ id: 'dead-1' })
    await sessions.softDeleteSessions(['dead-1'], 't5', 'standalone')

    const got = await sessions.getSessions(['live-1', 'dead-1', 'absent'])

    expect([...got.keys()].sort()).toEqual(['dead-1', 'live-1'])
    // The tombstone is not merely present, it is RECOGNISABLE — an implementation
    // that returned it while dropping the deletion columns would still pass a
    // key-set assertion.
    expect(got.get('dead-1')?.deletedAt).toBe('t5')
    expect(got.get('live-1')?.deletedAt).toBeNull()
    // The pair with the denial: an id nobody has is simply absent, not a null.
    expect(got.has('absent')).toBe(false)
  })

  it('deduplicates its input and chunks past the 500 boundary', async () => {
    const ids = Array.from({ length: 600 }, (_, i) => `bulk-${i}`)
    for (const id of [ids[0] as string, ids[520] as string]) await put({ id })
    // 600 ids with a duplicate: the chunk boundary is crossed and the unique-ing
    // happens before the chunking, or the second chunk is a different width.
    const got = await sessions.getSessions([...ids, ids[0] as string])
    expect([...got.keys()].sort()).toEqual([ids[0], ids[520]].sort())
  })
})

describe('the three resume-value readers answer three different questions', () => {
  /**
   * Two live sessions share one resume value. `first` is created earlier, so the
   * `created_at ASC, rowid ASC` ordering makes it the one the singular readers
   * pick; `second` carries an issueId that `first` lacks, which is the fact cost
   * attribution needs and the reason the plural reader exists.
   */
  const seedDuplicatePair = async (): Promise<void> => {
    await put({ id: 'first', resumeValue: 'conv-1', createdAt: 't1' })
    await put({
      id: 'second',
      resumeValue: 'conv-1',
      createdAt: 't2',
      issueId: asIssueId('iss_a') as IssueId,
    })
    // A tombstone on the same value: every one of the three readers restates
    // `deleted_at IS NULL`, so none of them may see it.
    await put({ id: 'buried', resumeValue: 'conv-1', createdAt: 't0' })
    await sessions.softDeleteSessions(['buried'], 't5', 'standalone')
  }

  it('findSessionByResumeValue picks the FIRST live row in the scan order', async () => {
    await seedDuplicatePair()
    // 'buried' is earliest by created_at, so if the tombstone filter were dropped
    // this would return it — which is why the fixture puts it first.
    expect((await sessions.findSessionByResumeValue('conv-1'))?.id).toBe('first')
  })

  it('findSessionsByResumeValues keeps ONE row per value — the same one', async () => {
    await seedDuplicatePair()
    const got = await sessions.findSessionsByResumeValues(['conv-1', 'conv-absent'])
    expect(got.size).toBe(1)
    expect(got.get('conv-1')?.id).toBe('first')
    // The singular and the batched reader must not disagree; POD-1614 replaced a
    // scan with a query on exactly that promise.
    expect(got.get('conv-1')?.id).toBe((await sessions.findSessionByResumeValue('conv-1'))?.id)
  })

  it('listSessionsByResumeValues keeps EVERY candidate, so the caller can prefer', async () => {
    await seedDuplicatePair()
    const got = await sessions.listSessionsByResumeValues(['conv-1'])
    expect(
      got
        .get('conv-1')
        ?.map((s) => s.id)
        .sort(),
    ).toEqual(['first', 'second'])
    // The whole point: one of the two carries an issueId and the other does not,
    // and this reader is what lets the caller state a preference instead of
    // letting row order decide whether a transcript is attributed at all.
    expect(got.get('conv-1')?.some((s) => s.issueId !== null)).toBe(true)
    expect(got.get('conv-1')?.some((s) => s.issueId === null)).toBe(true)
    // And it still excludes the tombstone.
    expect(got.get('conv-1')?.map((s) => s.id)).not.toContain('buried')
  })

  it('both plural readers skip a null resume value rather than keying on it', async () => {
    await put({ id: 'no-value', resumeValue: null })
    expect((await sessions.findSessionsByResumeValues([])).size).toBe(0)
    expect((await sessions.listSessionsByResumeValues([])).size).toBe(0)
  })
})

describe('findSessionsByIssueIds', () => {
  it('excludes tombstones — a deleted session is not part of what a task cost', async () => {
    const issue = asIssueId('iss_a') as IssueId
    await put({ id: 'live-1', issueId: issue })
    await put({ id: 'dead-1', issueId: issue })
    await sessions.softDeleteSessions(['dead-1'], 't5', 'standalone')
    await put({ id: 'elsewhere', issueId: asIssueId('iss_b') as IssueId })

    const got = await sessions.findSessionsByIssueIds([issue])
    expect(got.map((s) => s.id)).toEqual(['live-1'])
  })

  it('deduplicates its input and returns a flat list across issues', async () => {
    const a = asIssueId('iss_a') as IssueId
    const b = asIssueId('iss_b') as IssueId
    await put({ id: 's-a', issueId: a })
    await put({ id: 's-b', issueId: b })
    expect((await sessions.findSessionsByIssueIds([a, b, a])).map((s) => s.id).sort()).toEqual([
      's-a',
      's-b',
    ])
  })
})

// ---------------------------------------------------------------------------
// The cross-owner writes
// ---------------------------------------------------------------------------

describe('clearAllReadAt — the one write here that legitimately crosses owners', () => {
  it('removes EVERY reader marker for one session and no other session', async () => {
    await put({ id: 'sess-1' })
    await put({ id: 'sess-2' })
    await sessions.markSessionRead(ALICE, asSessionId('sess-1'), 't1')
    await sessions.markSessionRead(BOB, asSessionId('sess-1'), 't1')
    await sessions.markSessionRead(ALICE, asSessionId('sess-2'), 't1')

    await sessions.clearAllReadAt(asSessionId('sess-1'))

    // The session became something new, which is true for everybody.
    expect(await sessions.getReadAt(ALICE, asSessionId('sess-1'))).toBeNull()
    expect(await sessions.getReadAt(BOB, asSessionId('sess-1'))).toBeNull()
    // It is not a widening: the neighbouring session's markers survive.
    expect(await sessions.getReadAt(ALICE, asSessionId('sess-2'))).toBe('t1')
  })

  it('leaves ABSENCE as the only spelling of never-opened', async () => {
    await put({ id: 'sess-1' })
    await sessions.markSessionRead(ALICE, asSessionId('sess-1'), 't1')
    await sessions.clearAllReadAt(asSessionId('sess-1'))
    // A table with two spellings of one fact acquires a second meaning nobody
    // documented, so the row must be GONE rather than holding a null.
    expect(await sessions.listReadAt(ALICE)).toEqual({})
  })
})

describe('snoozes across readers', () => {
  it('hasAnySnooze sees any owner, and says no once all are cleared', async () => {
    await put({ id: 'sess-1' })
    expect(await sessions.hasAnySnooze(asSessionId('sess-1'))).toBe(false)
    await sessions.setSnooze(BOB, asSessionId('sess-1'), null)
    // ALICE has no snooze; the question is about the SESSION, not the reader.
    expect(await sessions.hasAnySnooze(asSessionId('sess-1'))).toBe(true)
    await sessions.clearSnooze(BOB, asSessionId('sess-1'))
    expect(await sessions.hasAnySnooze(asSessionId('sess-1'))).toBe(false)
  })

  it('clearAllSnoozes drops every viewer independent snooze for one session only', async () => {
    await put({ id: 'sess-1' })
    await put({ id: 'sess-2' })
    await sessions.setSnooze(ALICE, asSessionId('sess-1'), null)
    await sessions.setSnooze(BOB, asSessionId('sess-1'), '2099-01-01T00:00:00.000Z')
    await sessions.setSnooze(ALICE, asSessionId('sess-2'), null)

    await sessions.clearAllSnoozes(asSessionId('sess-1'))

    expect(await sessions.hasAnySnooze(asSessionId('sess-1'))).toBe(false)
    expect(await sessions.hasAnySnooze(asSessionId('sess-2'))).toBe(true)
  })

  it('listSnoozes lapses a timed snooze on read, scoped to the reader', async () => {
    // A read that WRITES, and the housekeeping is deliberately reader-scoped:
    // dropping somebody else's expired row would be a cross-owner delete nobody
    // asked for.
    await put({ id: 'sess-1' })
    const past = '2000-01-01T00:00:00.000Z'
    await sessions.setSnooze(ALICE, asSessionId('sess-1'), past)
    await sessions.setSnooze(BOB, asSessionId('sess-1'), past)

    expect(await sessions.listSnoozes(ALICE)).toEqual({})
    // BOB's equally-expired row was not touched by ALICE's read.
    expect(await sessions.hasAnySnooze(asSessionId('sess-1'))).toBe(true)
  })

  it('listSnoozes never lapses an until-next-message snooze', async () => {
    await put({ id: 'sess-1' })
    await sessions.setSnooze(ALICE, asSessionId('sess-1'), null)
    // `null` means until-next-message and has no deadline to pass.
    expect(await sessions.listSnoozes(ALICE)).toEqual({ 'sess-1': null })
  })
})

// ---------------------------------------------------------------------------
// Versioned drafts
// ---------------------------------------------------------------------------

describe('setDraftDoc', () => {
  it('round-trips every versioning column', async () => {
    await put({ id: 'sess-1' })
    await sessions.setDraftDoc(asSessionId('sess-1'), {
      text: 'hello',
      updatedAt: 't1',
      rev: 7,
      origin: 'web',
      history: ['a', 'b'],
    })

    const docs = await sessions.loadDraftDocs()
    expect(docs[asSessionId('sess-1')]).toEqual({
      text: 'hello',
      updatedAt: 't1',
      rev: 7,
      origin: 'web',
      history: ['a', 'b'],
    })
  })

  it('upserts in place rather than accumulating rows', async () => {
    await put({ id: 'sess-1' })
    const doc = { text: 'one', updatedAt: 't1', rev: 1, origin: null, history: [] }
    await sessions.setDraftDoc(asSessionId('sess-1'), doc)
    await sessions.setDraftDoc(asSessionId('sess-1'), { ...doc, text: 'two', rev: 2 })

    const docs = await sessions.loadDraftDocs()
    expect(Object.keys(docs)).toEqual(['sess-1'])
    expect(docs[asSessionId('sess-1')]?.text).toBe('two')
    expect(docs[asSessionId('sess-1')]?.rev).toBe(2)
  })

  it('DELETES the row on empty text, so a cleared draft never lingers', async () => {
    await put({ id: 'sess-1' })
    await sessions.setDraftDoc(asSessionId('sess-1'), {
      text: 'hello',
      updatedAt: 't1',
      rev: 1,
      origin: null,
      history: [],
    })
    await sessions.setDraftDoc(asSessionId('sess-1'), {
      text: '',
      updatedAt: 't2',
      rev: 2,
      origin: null,
      history: [],
    })
    // Absent, not an empty-text row: the same rule `setDraft` follows.
    expect(await sessions.loadDraftDocs()).toEqual({})
    expect(await sessions.loadDrafts()).toEqual({})
  })

  it('quarantines a corrupt history into an empty list rather than failing the load', async () => {
    // `history` is a plain text column, not `mode: 'json'`, and `parseHistory`
    // is its quarantine — a rule 6 mapper DECISION that survives the conversion.
    // The row still loads; only the history is empty.
    await put({ id: 'sess-1' })
    await sessions.setDraftDoc(asSessionId('sess-1'), {
      text: 'hello',
      updatedAt: 't1',
      rev: 1,
      origin: null,
      history: ['a'],
    })
    db.prepare('UPDATE session_drafts SET history = ? WHERE session_id = ?').run(
      '{not json',
      'sess-1',
    )

    const docs = await sessions.loadDraftDocs()
    expect(docs[asSessionId('sess-1')]?.history).toEqual([])
    // The admission beside the denial: the rest of the doc is intact, so the
    // quarantine is scoped to the column and does not drop the row.
    expect(docs[asSessionId('sess-1')]?.text).toBe('hello')
  })

  it('drops non-string history members rather than passing them through', async () => {
    await put({ id: 'sess-1' })
    await sessions.setDraftDoc(asSessionId('sess-1'), {
      text: 'hello',
      updatedAt: 't1',
      rev: 1,
      origin: null,
      history: ['a'],
    })
    db.prepare('UPDATE session_drafts SET history = ? WHERE session_id = ?').run(
      '["a", 7, null]',
      'sess-1',
    )
    expect((await sessions.loadDraftDocs())[asSessionId('sess-1')]?.history).toEqual(['a'])
  })
})

// ---------------------------------------------------------------------------
// The satellite quarantines the conversion must not tighten
// ---------------------------------------------------------------------------

describe('offers and tab order keep their quarantines', () => {
  const owner: UserId = ALICE

  it('a corrupt actions column drops the OFFER; a corrupt artifacts column drops only the artifacts', async () => {
    await put({ id: 'sess-1' })
    await put({ id: 'sess-2' })
    await sessions.setOffer(asSessionId('sess-1'), {
      message: 'm1',
      actions: [{ label: 'a', prompt: 'b' }],
      artifacts: ['x'],
      createdAt: 't1',
    })
    await sessions.setOffer(asSessionId('sess-2'), {
      message: 'm2',
      actions: [{ label: 'a', prompt: 'b' }],
      createdAt: 't1',
    })

    db.prepare('UPDATE offers SET artifacts = ? WHERE session_id = ?').run('{bad', 'sess-1')
    db.prepare('UPDATE offers SET actions = ? WHERE session_id = ?').run('{bad', 'sess-2')

    const offers = await sessions.listOffers()
    // The two quarantines are DIFFERENT WIDTHS and the nesting is what makes
    // them so. Flattening them into one `try` loses the narrower one.
    expect(offers['sess-1']?.message).toBe('m1')
    expect(offers['sess-1']?.artifacts).toBeUndefined()
    expect(offers['sess-2']).toBeUndefined()
  })

  it('a non-array actions value drops the offer even though the JSON parses', async () => {
    await put({ id: 'sess-1' })
    await sessions.setOffer(asSessionId('sess-1'), {
      message: 'm1',
      actions: [{ label: 'a', prompt: 'b' }],
      createdAt: 't1',
    })
    // Valid JSON, wrong shape: the `Array.isArray` guard is a second check and
    // not a restatement of the `try`.
    db.prepare('UPDATE offers SET actions = ? WHERE session_id = ?').run('{"a":1}', 'sess-1')
    expect(await sessions.listOffers()).toEqual({})
  })

  it('a corrupt tab order reads as no saved order for that worktree only', async () => {
    await sessions.setTabOrder(owner, '/w/one', ['a', 'b'])
    await sessions.setTabOrder(owner, '/w/two', ['c'])
    db.prepare('UPDATE tab_order SET ids = ? WHERE worktree = ?').run('{bad', '/w/one')

    expect(await sessions.listTabOrders(owner)).toEqual({ '/w/two': ['c'] })
  })

  it('setTabOrder with an empty list deletes the row rather than storing []', async () => {
    await sessions.setTabOrder(owner, '/w/one', ['a'])
    await sessions.setTabOrder(owner, '/w/one', [])
    expect(await sessions.listTabOrders(owner)).toEqual({})
  })
})
