/**
 * GOLDEN TESTS FOR THE MESSAGES AGGREGATE — written BEFORE the drizzle
 * conversion, against the synchronous code, so they are the oracle it is judged
 * against (POD-3398, execution method §3 item 10).
 *
 * WHY THESE METHODS. The store coverage census (POD-3244) marks one method of
 * `messages.ts` as NEVER EXECUTED (`listPendingSenders`) and twenty-one more as
 * executed-but-never-NAMED: reached incidentally through a service test, with
 * nothing asserting what they do. A conversion is exactly the change that
 * incidental coverage cannot catch, because the service keeps working while the
 * predicate underneath it quietly stops meaning the same thing.
 *
 * WHAT THEY ASSERT, and it is spec §6 rule 14's instruction rather than a style
 * choice: for every guarded write, the arm the happy path does NOT walk. Each of
 * these methods returns a boolean and the interesting failures return the right
 * boolean for the wrong reason — a predicate that matches too much still reports
 * `true`. So each guarded write is tested by ALSO reading the row back and
 * asserting on the columns the guard was supposed to protect, and each refusal is
 * paired with an admission built in the same fixture, so no assertion here can be
 * satisfied by a repository that simply refuses everything.
 *
 * AGAINST THE REAL MIGRATED SCHEMA, like the attribution suite next door: the
 * shipped migration manifest on an in-memory database, so a column or a CHECK
 * that does not exist fails here rather than at boot.
 */

import { asIssueId, asSessionId, asThreadId, type IssueId } from '@podium/model'
import type { openDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor } from './executor'
import { INLINE_BODY_MAX, isPointerMessage, MessagesRepository } from './messages'
import type { MessageRow } from './types'

/**
 * Stage A's synchronous drizzle seam, built the way `SessionStore` asserts it
 * [POD-3221 spec rule 27b]. Local to this file on purpose: hoisting it into
 * `test-support` would put several parallel conversion waves in one shared file.
 */
const stageQueries = (database: Parameters<typeof createBunStoreExecutor>[0]['database']) => {
  const stage = createBunStoreExecutor({ database }).queries
  if (!stage) throw new Error('the synchronous query capability is absent on this handle')
  return stage
}

let db: ReturnType<typeof openDatabase>
let messages: MessagesRepository

beforeEach(() => {
  db = openMigratedTestDatabase()
  messages = new MessagesRepository(stageQueries(db))
})

const TARGET = 'iss_target'
const READER = asSessionId('sess-reader')
const OTHER = asSessionId('sess-other')

function message(input: Omit<Partial<MessageRow>, 'id'> & { id: string }): MessageRow {
  return {
    threadId: asThreadId(input.id),
    inReplyTo: null,
    fromKind: 'agent',
    fromSession: null,
    fromIssue: null,
    toKind: 'issue',
    toId: TARGET,
    kind: 'message',
    urgency: 'fyi',
    lifecycle: 'wait',
    body: input.id,
    expiresAt: null,
    createdAt: 't0',
    deliveryStatus: 'stored',
    deliveredAt: null,
    deliveredTo: null,
    readAt: null,
    injectedAt: null,
    deadLetteredAt: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
    factKey: null,
    factTarget: null,
    expectsResponse: false,
    ...input,
  } as MessageRow
}

/**
 * Store a row, then SEED it into any other status the fixture names. Every row
 * enters as `stored` (`addMessage` refuses anything else), so a fixture that
 * wants a confirmed or failed row puts it there directly: these tests are about
 * what the next write does FROM that state, not how it got there. The stamps a
 * state implies (`injected_at`, `read_at`) are written with it, because
 * `addMessage` does not write them.
 */
const add = async (input: Omit<Partial<MessageRow>, 'id'> & { id: string }): Promise<void> => {
  const row = message(input)
  await messages.addMessage({ ...row, deliveryStatus: 'stored' })
  if (row.deliveryStatus !== 'stored' || row.injectedAt || row.readAt) {
    db.prepare(
      'UPDATE messages SET delivery_status = ?, injected_at = ?, read_at = ? WHERE id = ?',
    ).run(
      row.deliveryStatus,
      row.injectedAt ?? null,
      row.readAt ?? null,
      row.id,
    )
  }
}

/** The persisted row, read through the repository's own mapper. */
const back = async (id: string) => await messages.getMessage(id)

// ---------------------------------------------------------------------------
// The one method the census marks NEVER EXECUTED
// ---------------------------------------------------------------------------

describe('listPendingSenders — never executed before this file', () => {
  it('projects DISTINCT queued senders for a principal, and only queued ones', async () => {
    await add({ id: 'm1', fromIssue: asIssueId('iss_a'), fromSession: asSessionId('s-a') })
    // Same sender twice: DISTINCT must collapse it to one entry, or every nag
    // count that reads this is multiplied by the backlog depth.
    await add({ id: 'm2', fromIssue: asIssueId('iss_a'), fromSession: asSessionId('s-a') })
    await add({ id: 'm3', fromIssue: asIssueId('iss_b'), fromSession: asSessionId('s-b') })
    // The admission that pairs with the denial: a non-queued row from a THIRD
    // sender, which must not appear. Without it, a projection that returned every
    // row regardless of status would still satisfy the DISTINCT assertion.
    await add({ id: 'm4', fromIssue: asIssueId('iss_c'), deliveryStatus: 'confirmed' })

    const senders = await messages.listPendingSenders({ kind: 'issue', id: TARGET })

    expect(senders).toEqual([
      { fromKind: 'agent', fromIssue: 'iss_a', fromSession: 's-a' },
      { fromKind: 'agent', fromIssue: 'iss_b', fromSession: 's-b' },
    ])
    expect(senders.map((s) => s.fromIssue)).not.toContain('iss_c')
  })

  it('addresses an OPERATOR principal by dropping the id predicate, not by binding null', async () => {
    // `operator` has no id, and the repository answers that by OMITTING the
    // `to_id = ?` clause rather than binding null. The two are not the same: a
    // bound null matches nothing, so an implementation that took that shortcut
    // would return an empty list here while still passing every issue-addressed
    // test above.
    await add({ id: 'op1', toKind: 'operator', toId: null, fromIssue: asIssueId('iss_a') })
    await add({ id: 'op2', toKind: 'operator', toId: 'ignored', fromIssue: asIssueId('iss_b') })

    const senders = await messages.listPendingSenders({ kind: 'operator' })
    expect(senders.map((s) => s.fromIssue)).toEqual(['iss_a', 'iss_b'])
  })
})

// ---------------------------------------------------------------------------
// A failure and the notice telling its sender are one write (POD-4778)
// ---------------------------------------------------------------------------

describe('markDeadLetter / markDeliveryAbandoned — the notice rides the move', () => {
  const notice = (id: string): MessageRow =>
    message({ id, fromKind: 'system', fromName: 'steward', toKind: 'session', toId: String(OTHER) })

  it('stores the notice when the move applies, and nothing on a repeat', async () => {
    await add({ id: 'gone' })
    expect((await messages.markDeadLetter('gone', 't1', undefined, notice('ntf-gone'))).kind).toBe(
      'applied',
    )
    expect((await back('ntf-gone'))?.deliveryStatus).toBe('stored')
    expect(await messages.markDeadLetter('gone', 't2', undefined, notice('ntf-gone-2'))).toEqual({
      kind: 'already-there',
    })
    expect(await back('ntf-gone-2')).toBeNull()
  })

  it('stores no notice when the move is refused', async () => {
    await add({ id: 'confirmed' })
    await messages.markDelivered('confirmed', String(READER), 't1')
    expect(
      await messages.markDeliveryAbandoned('confirmed', READER, 't2', 'teardown', notice('ntf-c')),
    ).toEqual({ kind: 'refused', current: 'confirmed' })
    expect(await back('ntf-c')).toBeNull()
    expect((await back('confirmed'))?.deadLetteredAt).toBeNull()
  })

  it('a notice that cannot be stored takes the move back with it', async () => {
    await add({ id: 'on-its-way' })
    await messages.markDispatched('on-its-way', READER, 't1')
    // A notice that is not `stored` is refused by the insert: the failure
    // must not commit without it.
    await expect(
      messages.markDeliveryAbandoned('on-its-way', READER, 't2', 'teardown', {
        ...notice('ntf-bad'),
        deliveryStatus: 'confirmed',
      }),
    ).rejects.toThrow()
    expect((await back('on-its-way'))?.deliveryStatus).toBe('dispatched')
    expect((await back('on-its-way'))?.deadLetteredAt).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// A lost answer is `unknown`, never failed, and never walks a row back
// ---------------------------------------------------------------------------

describe('markUnknown — only a handed-on row, only for its session (POD-4775)', () => {
  it('moves the row handed to that session and nothing else', async () => {
    await add({ id: 'on-its-way' })
    await messages.markDispatched('on-its-way', READER, 't1')
    await add({ id: 'confirmed' })
    await messages.markDispatched('confirmed', READER, 't1')
    await messages.markDelivered('confirmed', String(READER), 't1')
    await add({ id: 'held', deliveredTo: READER })

    // Another session's lost answer cannot move this row.
    expect(await messages.markUnknown('on-its-way', OTHER)).toEqual({
      kind: 'refused',
      current: 'dispatched',
    })
    expect((await messages.markUnknown('on-its-way', READER)).kind).toBe('applied')
    expect(await messages.markUnknown('on-its-way', READER)).toEqual({ kind: 'already-there' })
    // Confirmed is past the question; a row never handed on has no answer to lose.
    expect(await messages.markUnknown('confirmed', READER)).toEqual({
      kind: 'refused',
      current: 'confirmed',
    })
    expect(await messages.markUnknown('held', READER)).toEqual({
      kind: 'refused',
      current: 'stored',
    })

    const row = await back('on-its-way')
    expect(row?.deliveryStatus).toBe('unknown')
    // Not a dead letter: nothing failed, the machine may still type it.
    expect(row?.deadLetteredAt).toBeNull()
  })

  it('a later confirmation still lands on an unknown row', async () => {
    await add({ id: 'lost' })
    await messages.markDispatched('lost', READER, 't1')
    await messages.markUnknown('lost', READER)
    expect((await messages.markDelivered('lost', String(READER), 't2')).kind).toBe('applied')
    expect((await back('lost'))?.deliveryStatus).toBe('confirmed')
  })
})

// ---------------------------------------------------------------------------
// The guarded ledger transitions
// ---------------------------------------------------------------------------

describe('guarded ledger transitions', () => {
  it('markDeliveryAbandoned dedupes: a repeat is already there', async () => {
    await add({ id: 'm1' })
    expect((await messages.markDeliveryAbandoned('m1', READER, 't1', 'never-live')).kind).toBe('applied')
    // Abandonment reports are retryable and repeat across restarts; the second
    // finds the row already failed. This is how the caller emits exactly one
    // transition per turn.
    expect((await messages.markDeliveryAbandoned('m1', READER, 't2', 'never-live')).kind).toBe('already-there')
    expect((await back('m1'))?.deadLetteredAt).toBe('t1')
  })

  it('markDeliveryAbandoned COALESCEs delivered_to rather than overwriting it', async () => {
    await add({ id: 'm1', deliveredTo: OTHER })
    await messages.markDeliveryAbandoned('m1', READER, 't1', 'teardown')
    // The row was aimed at OTHER; the report names READER. The existing target is
    // the evidence and must win.
    expect((await back('m1'))?.deliveredTo).toBe(OTHER)
  })

  // POD-4776: the retract request is a stamp beside the status, never a move.
  it('requestRetract stamps a pending row once, and never a settled one', async () => {
    await add({ id: 'q', deliveryStatus: 'dispatched' })
    await add({ id: 'd', deliveryStatus: 'confirmed', deliveredAt: 't1' })
    expect(await messages.requestRetract('q', 't2')).toBe(true)
    expect(await messages.requestRetract('q', 't3')).toBe(true)
    expect(await messages.requestRetract('d', 't2')).toBe(false)
    expect(await back('q')).toMatchObject({
      deliveryStatus: 'dispatched',
      retractRequestedAt: 't2',
    })
    expect((await back('d'))?.retractRequestedAt).toBeUndefined()
  })

  it('markCancelled onlyFrom moves only from that status', async () => {
    await add({ id: 's' })
    await add({ id: 'h', deliveryStatus: 'dispatched' })
    expect((await messages.markCancelled('h', { onlyFrom: 'stored' })).kind).not.toBe('applied')
    expect((await messages.markCancelled('s', { onlyFrom: 'stored' })).kind).toBe('applied')
    expect((await back('h'))?.deliveryStatus).toBe('dispatched')
  })

  it('markCancelled only moves a row that is not yet typed or ended', async () => {
    await add({ id: 'q' })
    await add({ id: 'd', deliveryStatus: 'confirmed', deliveredAt: 't1' })
    expect((await messages.markCancelled('q')).kind).toBe('applied')
    expect((await messages.markCancelled('d')).kind).toBe('refused')
    expect((await back('q'))?.deliveryStatus).toBe('cancelled')
    expect((await back('d'))?.deliveryStatus).toBe('confirmed')
  })

  it('markDeliveredByPull leaves a peer-pushed row queued and records only the reader receipt [POD-4680]', async () => {
    // POD-1420 COALESCE assumed deliveredTo meant the mail had landed. With
    // POD-4661 at-once hand-off every send is pushed, so a peer pull that
    // advanced the ledger claimed delivery to the push target who never read
    // it — clearing their pending count. A peer pull now marks only the
    // READER's receipt, not the row another session is still pending on.
    await add({ id: 'pushed' })
    await messages.markDispatched('pushed', OTHER, 't1')
    expect((await messages.markDeliveredByPull('pushed', String(READER), 't2')).kind).toBe('refused')

    const row = await back('pushed')
    expect(row?.deliveryStatus).toBe('dispatched')
    expect(row?.deliveredTo).toBe(OTHER)
    expect(row?.injectedAt).toBe('t1')
    // The pull still proves THIS reader has it, whoever the row was pushed to.
    expect(await messages.readReceipts(READER, ['pushed'])).toEqual(new Set(['pushed']))
    // The push target still has no receipt — its pending survives the peer read.
    expect(await messages.readReceipts(OTHER, ['pushed'])).toEqual(new Set())
  })

  it('markDeliveredByPull COALESCEs the push target when the reader is the push target', async () => {
    // The POD-1420 admission beside the POD-4680 denial: a pull by the session
    // the row was pushed to DOES advance, and COALESCE still preserves the
    // target instead of erasing it.
    await add({ id: 'own-push' })
    await messages.markDispatched('own-push', READER, 't1')
    expect((await messages.markDeliveredByPull('own-push', String(READER), 't2')).kind).toBe('applied')

    const row = await back('own-push')
    expect(row?.deliveryStatus).toBe('confirmed')
    expect(row?.deliveredTo).toBe(READER)
    expect(await messages.readReceipts(READER, ['own-push'])).toEqual(new Set(['own-push']))
  })

  it('markDeliveredByPull fills delivered_to when nothing was pushed', async () => {
    // The admission beside the denial: COALESCE must still WRITE when the column
    // is null, or the ledger never learns who pulled it.
    await add({ id: 'unpushed' })
    await messages.markDeliveredByPull('unpushed', String(READER), 't2')
    expect((await back('unpushed'))?.deliveredTo).toBe(READER)
  })

  it('markRead records the reader receipt EVEN WHEN the guarded update loses', async () => {
    // THE ARM NOTHING WALKS. A peer consumed the shared delivery ledger first, so
    // the UPDATE matches nothing and the method returns false — but the receipt is
    // about THIS reader, not about who moved the shared row, and it must still be
    // written. A conversion that folds the receipt inside the `if (changes === 1)`
    // branch passes every happy-path test and silently re-nags this session.
    await add({ id: 'shared', deliveryStatus: 'cancelled' })
    expect((await messages.markRead('shared', String(READER), 't2')).firstRead).toBe(false)
    expect(await messages.readReceipts(READER, ['shared'])).toEqual(new Set(['shared']))
  })

  it('markRead confirms a pending row AND stamps the first read on a confirmed one', async () => {
    await add({ id: 'q' })
    await add({ id: 'd', deliveryStatus: 'confirmed', deliveredAt: 't1' })
    const pending = await messages.markRead('q', String(READER), 't2')
    expect(pending).toEqual({ outcome: { kind: 'applied' }, firstRead: true })
    expect((await back('q'))?.deliveryStatus).toBe('confirmed')
    expect((await back('q'))?.readAt).toBe('t2')
    // A confirmed row can still be read if later pulled — the read is a stamp,
    // not a move, and dropping that arm is invisible to a pending-only fixture.
    const confirmed = await messages.markRead('d', String(READER), 't2')
    expect(confirmed).toEqual({ outcome: { kind: 'already-there' }, firstRead: true })
    expect((await back('d'))?.deliveryStatus).toBe('confirmed')
    expect((await back('d'))?.readAt).toBe('t2')
    // The first read wins; a second read announces nothing.
    expect((await messages.markRead('d', String(READER), 't3')).firstRead).toBe(false)
    expect((await back('d'))?.readAt).toBe('t2')
  })

  it('markDeadLetter takes its no-cause branch without stamping a reason', async () => {
    await add({ id: 'gone' })
    expect((await messages.markDeadLetter('gone', 't1')).kind).toBe('applied')
    const row = await back('gone')
    expect(row?.deliveryStatus).toBe('failed')
    expect(row?.deadLetteredAt).toBe('t1')
    // A dead letter with no cause reads downstream as a vanished target, which is
    // right for this callsite. The columns must stay null, not be filled in.
    expect(row?.deliveryDeferredAt).toBeNull()
    expect(row?.deliveryDeferredReason).toBeNull()
  })

  it('markDeadLetter takes its with-cause branch and stamps both columns', async () => {
    // The method switches between two different SQL texts and two different
    // argument lists on `cause`. Both branches need a walker.
    await add({ id: 'refused' })
    expect((await messages.markDeadLetter('refused', 't1', 'delivery-failed')).kind).toBe('applied')
    const row = await back('refused')
    expect(row?.deliveryDeferredAt).toBe('t1')
    expect(row?.deliveryDeferredReason).toBe('delivery-failed')
  })

  it('markDeadLetter refuses a row that is not queued, in both branches', async () => {
    await add({ id: 'a', deliveryStatus: 'confirmed', deliveredAt: 't1' })
    await add({ id: 'b', deliveryStatus: 'confirmed', deliveredAt: 't1' })
    expect((await messages.markDeadLetter('a', 't2')).kind).toBe('refused')
    expect((await messages.markDeadLetter('b', 't2', 'teardown')).kind).toBe('refused')
  })

  it('markReminded fires once and never again', async () => {
    await add({ id: 'm1' })
    expect(await messages.markReminded('m1', 't1')).toBe(true)
    expect(await messages.markReminded('m1', 't2')).toBe(false)
    expect((await back('m1'))?.remindedAt).toBe('t1')
  })

  it('markAcked stamps the first ack and refuses the second', async () => {
    await add({ id: 'm1' })
    expect(await messages.markAcked('m1', 'ack-1')).toBe(true)
    expect(await messages.markAcked('m1', 'ack-2')).toBe(false)
    expect((await back('m1'))?.ackedBy).toBe('ack-1')
  })
})

// ---------------------------------------------------------------------------
// expireObserved — the `IS ?` binding
// ---------------------------------------------------------------------------

describe('expireObserved — conditional on every observed fact', () => {
  it('matches a NULL expires_at through `IS`, not `=`', async () => {
    // THE ARM A PASSING TEST DOES NOT WALK, and the one the conversion is most
    // likely to break. The statement binds `expires_at IS ?`; SQL `=` never
    // matches null, so emitting `=` here silently stops expiring every row whose
    // expiry is null — which is most of them — while the non-null case below
    // keeps passing.
    await add({ id: 'no-expiry', expiresAt: null })
    expect((await messages.expireObserved({
        id: 'no-expiry',
        createdAt: 't0',
        lifecycle: 'wait',
        expiresAt: null,
      })).kind).toBe('applied')
    expect((await back('no-expiry'))?.deliveryStatus).toBe('expired')
  })

  it('matches a non-null expires_at', async () => {
    await add({ id: 'with-expiry', expiresAt: 't9' })
    expect((await messages.expireObserved({
        id: 'with-expiry',
        createdAt: 't0',
        lifecycle: 'wait',
        expiresAt: 't9',
      })).kind).toBe('applied')
  })

  it('refuses when any observed fact has moved underneath the janitor', async () => {
    await add({ id: 'moved', expiresAt: 't9' })
    // Each clause is dropped one at a time, so a predicate missing any single one
    // is caught rather than merely a predicate missing all of them.
    expect((await messages.expireObserved({
        id: 'moved',
        createdAt: 'WRONG',
        lifecycle: 'wait',
        expiresAt: 't9',
      })).kind).toBe('refused')
    expect((await messages.expireObserved({
        id: 'moved',
        createdAt: 't0',
        lifecycle: 'wake',
        expiresAt: 't9',
      })).kind).toBe('refused')
    expect((await messages.expireObserved({
        id: 'moved',
        createdAt: 't0',
        lifecycle: 'wait',
        expiresAt: null,
      })).kind).toBe('refused')
    expect((await back('moved'))?.deliveryStatus).toBe('stored')
  })

  it('refuses a row that was handed on: a timer cannot say it will not arrive', async () => {
    await add({ id: 'handed-on', expiresAt: 't9' })
    await messages.markDispatched('handed-on', READER, 't1')
    expect(
      await messages.expireObserved({ id: 'handed-on', createdAt: 't0', lifecycle: 'wait', expiresAt: 't9' }),
    ).toEqual({ kind: 'refused', current: 'dispatched' })
    expect((await back('handed-on'))?.deliveryStatus).toBe('dispatched')
  })
})

// ---------------------------------------------------------------------------
// The reader-scoped and principal-scoped projections
// ---------------------------------------------------------------------------

describe('queued projections for a principal', () => {
  it('queuedPositionForSession counts the queue ahead in (created_at, id) order', async () => {
    const to = { toKind: 'session' as const, toId: String(READER) }
    await add({ id: 'b', createdAt: 't1', ...to })
    await add({ id: 'a', createdAt: 't1', ...to })
    await add({ id: 'c', createdAt: 't2', ...to })

    // Same timestamp: the id breaks the tie, so 'a' precedes 'b'.
    expect(await messages.queuedPositionForSession(READER, 'a')).toBe(1)
    expect(await messages.queuedPositionForSession(READER, 'b')).toBe(2)
    expect(await messages.queuedPositionForSession(READER, 'c')).toBe(3)
  })

  it('queuedPositionForSession counts a row aimed via delivered_to as well as one addressed', async () => {
    await add({ id: 'addressed', createdAt: 't1', toKind: 'session', toId: String(READER) })
    await add({ id: 'aimed', createdAt: 't2', deliveredTo: READER })
    expect(await messages.queuedPositionForSession(READER, 'aimed')).toBe(2)
  })

  it('queuedPositionForSession is undefined for an injected or non-queued row', async () => {
    await add({ id: 'pushed', toKind: 'session', toId: String(READER) })
    await messages.markDispatched('pushed', READER, 't1')
    await add({ id: 'done', toKind: 'session', toId: String(READER) })
    await messages.markDelivered('done', String(READER), 't1')
    expect(await messages.queuedPositionForSession(READER, 'pushed')).toBeUndefined()
    expect(await messages.queuedPositionForSession(READER, 'done')).toBeUndefined()
  })

  it('pendingForPage pages forward by keyset', async () => {
    for (const id of ['a', 'b', 'c', 'd']) await add({ id, createdAt: `t-${id}` })
    const to = { kind: 'issue' as const, id: TARGET }

    const first = await messages.pendingForPage(to, { limit: 2 })
    expect(first.map((m) => m.id)).toEqual(['a', 'b'])

    const next = await messages.pendingForPage(to, {
      after: { createdAt: 't-b', id: 'b' },
      limit: 2,
    })
    expect(next.map((m) => m.id)).toEqual(['c', 'd'])
  })

  it('latestPendingOperatorForSession breaks a same-tick tie by rowid, not by id', async () => {
    // Random message ids do not encode creation order, so an ORDER BY that fell
    // back to `id` would pick the alphabetically last row rather than the last
    // one inserted. Named so the alphabetical answer and the insertion answer
    // differ.
    const to = { toKind: 'session' as const, toId: String(READER), fromKind: 'operator' as const }
    await add({ id: 'zzz-first', createdAt: 't1', ...to })
    await add({ id: 'aaa-second', createdAt: 't1', ...to })

    expect((await messages.latestPendingOperatorForSession(READER))?.id).toBe('aaa-second')
  })

  it('latestPendingOperatorForSession ignores non-operator senders', async () => {
    await add({
      id: 'agent-send',
      toKind: 'session',
      toId: String(READER),
      fromKind: 'agent',
    })
    expect(await messages.latestPendingOperatorForSession(READER)).toBeUndefined()
  })

  it('pendingSummary counts and groups one queued slice', async () => {
    await add({ id: 'm1', fromIssue: asIssueId('iss_a') })
    await add({ id: 'm2', fromIssue: asIssueId('iss_a') })
    await add({ id: 'm3', fromIssue: asIssueId('iss_b') })
    await add({ id: 'm4', fromIssue: asIssueId('iss_b'), deliveryStatus: 'confirmed', readAt: 't1' })

    const summary = await messages.pendingSummary({ kind: 'issue', id: TARGET })
    // The count is the sum of the groups, not the number of groups.
    expect(summary.count).toBe(3)
    expect(summary.senders).toEqual([
      { fromKind: 'agent', fromIssue: 'iss_a', fromSession: null },
      { fromKind: 'agent', fromIssue: 'iss_b', fromSession: null },
    ])
  })

  it('countQueued counts the whole substrate, across principals', async () => {
    await add({ id: 'm1' })
    await add({ id: 'm2', toKind: 'session', toId: String(READER) })
    await add({ id: 'm3', deliveryStatus: 'confirmed', deliveredAt: 't1' })
    expect(await messages.countQueued()).toBe(2)
  })
})

describe('per-reader pending', () => {
  const PEER = asSessionId('sess-peer')

  it('pendingSummaryForSession excludes the reader own sends, receipts and deliveries', async () => {
    // One admission and three denials in one fixture, so the predicate cannot
    // pass by refusing everything.
    await add({ id: 'counts', fromSession: PEER, createdAt: 't5' })
    await add({ id: 'own-send', fromSession: READER, createdAt: 't5' })
    await add({ id: 'receipted', fromSession: PEER, createdAt: 't5' })
    await messages.recordRead('receipted', READER, 't5')
    await add({
      id: 'delivered-here',
      fromSession: PEER,
      createdAt: 't5',
      deliveryStatus: 'confirmed',
      deliveredAt: 't5',
      deliveredTo: READER,
    })

    const summary = await messages.pendingSummaryForSession(asIssueId(TARGET) as IssueId, READER)
    expect(summary.count).toBe(1)
    expect(summary.senders).toEqual([
      { fromKind: 'agent', fromIssue: null, fromSession: String(PEER) },
    ])
  })

  // MAIL ALREADY ON ITS WAY DOES NOT NAG [POD-4661]. The server hands every
  // send to the daemon at once, so a busy agent's inline mail sits `queued`
  // with injected_at stamped until the daemon delivers it as a turn. Telling the
  // agent "you have mail" for it makes it read the same mail twice. A pointer
  // row (a body too long to paste) stays counted: only a read confirms it. A
  // short fyi is typed inline like any other row, so it is on its way too
  // [POD-4845].
  it('pendingSummaryForSession skips inline mail already handed to this reader', async () => {
    await add({ id: 'waiting', fromSession: PEER, createdAt: 't5', urgency: 'next-turn' })
    await add({
      id: 'handed-on',
      fromSession: PEER,
      createdAt: 't5',
      urgency: 'next-turn',
    })
    await add({
      id: 'fyi-handed-on',
      fromSession: PEER,
      createdAt: 't5',
      urgency: 'fyi',
    })
    await add({
      id: 'oversized-handed-on',
      fromSession: PEER,
      createdAt: 't5',
      urgency: 'next-turn',
      body: 'x'.repeat(INLINE_BODY_MAX + 1),
    })

    // Handed to ANOTHER session: it never reaches this reader as a turn, so it
    // still nags here.
    await add({ id: 'handed-to-peer', fromIssue: asIssueId('iss_x'), createdAt: 't5', urgency: 'next-turn' })
    // Handed on the way production does it: stamped injected to the reader.
    for (const id of ['handed-on', 'fyi-handed-on', 'oversized-handed-on']) {
      await messages.markDispatched(id, READER, 't6')
    }
    await messages.markDispatched('handed-to-peer', PEER, 't6')
    const summary = await messages.pendingSummaryForSession(asIssueId(TARGET) as IssueId, READER)
    expect(summary.count).toBe(3)
    const issue = asIssueId(TARGET) as IssueId
    expect(await messages.countPendingForSession(issue, READER)).toBe(3)
  })

  it('pendingSummary skips inline mail already handed to a session', async () => {
    await add({ id: 'waiting', urgency: 'next-turn' })
    await add({ id: 'handed-on', urgency: 'next-turn' })
    await add({ id: 'fyi-handed-on', urgency: 'fyi' })
    await add({ id: 'pointer-handed-on', body: 'x'.repeat(INLINE_BODY_MAX + 1) })
    for (const id of ['handed-on', 'fyi-handed-on', 'pointer-handed-on']) {
      await messages.markDispatched(id, READER, 't6')
    }
    expect((await messages.pendingSummary({ kind: 'issue', id: TARGET })).count).toBe(2)
  })

  // THE POINTER RULE is stated twice, in code (what the renderer types) and in
  // SQL (what still nags): the two must classify every body alike [POD-4845].
  // SQLite counts characters where `.length` counts UTF-16 units, so the
  // boundary cases carry an emoji (one character, two units).
  it('the pointer rule in code and in SQL agree on every body, at the boundary too', async () => {
    const emoji = '\u{1F600}'
    const bodies = {
      short: 'short',
      'at-limit': 'x'.repeat(INLINE_BODY_MAX),
      'over-limit': 'x'.repeat(INLINE_BODY_MAX + 1),
      'at-limit-with-emoji': 'x'.repeat(INLINE_BODY_MAX - 1) + emoji,
      'over-limit-with-emoji': 'x'.repeat(INLINE_BODY_MAX - 1) + emoji + 'x',
      'all-emoji-at-limit': emoji.repeat(INLINE_BODY_MAX),
      'all-emoji-over-limit': emoji.repeat(INLINE_BODY_MAX + 1),
    }
    // A handed-on row nags its reader exactly when it is a pointer.
    const issue = asIssueId(TARGET) as IssueId
    const nagging: string[] = []
    for (const [id, body] of Object.entries(bodies)) {
      const before = await messages.countPendingForSession(issue, READER)
      await add({ id, fromSession: PEER, body })
      await messages.markDispatched(id, READER, 't6')
      if ((await messages.countPendingForSession(issue, READER)) > before) nagging.push(id)
    }
    const pointers = Object.entries(bodies)
      .filter(([, body]) => isPointerMessage({ toKind: 'issue', body }))
      .map(([id]) => id)
    expect(pointers).toEqual(['over-limit', 'over-limit-with-emoji', 'all-emoji-over-limit'])
    expect(nagging).toEqual(pointers)
  })

  it('pendingSummary never takes session mail for a pointer, however long', async () => {
    // Only issue-addressed mail is rendered as a pointer [POD-4845].
    const to = { toKind: 'session' as const, toId: String(READER) }
    await add({ id: 'long-to-session', ...to, body: 'x'.repeat(INLINE_BODY_MAX + 1) })
    await add({ id: 'fyi-to-session', ...to, urgency: 'fyi' })
    for (const id of ['long-to-session', 'fyi-to-session']) await messages.markDispatched(id, READER, 't6')
    expect((await messages.pendingSummary({ kind: 'session', id: String(READER) })).count).toBe(0)
  })

  it('countPendingForSession and listPendingSendersForSession agree with the summary', async () => {
    await add({ id: 'counts', fromSession: PEER, createdAt: 't5' })
    await add({ id: 'own-send', fromSession: READER, createdAt: 't5' })

    const issue = asIssueId(TARGET) as IssueId
    expect(await messages.countPendingForSession(issue, READER)).toBe(1)
    expect(await messages.listPendingSendersForSession(issue, READER)).toEqual([
      { fromKind: 'agent', fromIssue: null, fromSession: String(PEER) },
    ])
  })

  it('a still-QUEUED row counts for a session that did not exist when it arrived', async () => {
    // The history bound has an exception and it is the whole point: a queued row
    // is the held handoff a newly-arrived session must be told about, so it
    // counts even though it predates the session row. A conversion that applies
    // the timestamp clause uniformly loses exactly this case.
    await add({ id: 'held', fromSession: PEER, createdAt: 't0' })
    expect(
      await messages.countPendingForSession(
        asIssueId(TARGET) as IssueId,
        asSessionId('never-existed'),
      ),
    ).toBe(1)
  })
})

describe('batched id predicates', () => {
  it('existingMessageIds answers only for ids on the substrate', async () => {
    await add({ id: 'here' })
    expect(await messages.existingMessageIds(['here', 'absent', 'here'])).toEqual(new Set(['here']))
  })

  it('existingMessageIds chunks past the 500 boundary', async () => {
    // The chunk exists because SQLITE_MAX_VARIABLE_NUMBER is 999 and an unread
    // backlog is not bounded by anything the method can see. 600 ids is the
    // cheapest input that proves the second chunk is issued and merged.
    const ids = Array.from({ length: 600 }, (_, i) => `bulk-${i}`)
    for (const id of [ids[0] as string, ids[550] as string]) await add({ id })
    expect(await messages.existingMessageIds(ids)).toEqual(new Set([ids[0], ids[550]]))
  })

  it('selfSentIds names only what this session sent', async () => {
    await add({ id: 'mine', fromSession: READER })
    await add({ id: 'theirs', fromSession: OTHER })
    expect(await messages.selfSentIds(READER, ['mine', 'theirs'])).toEqual(new Set(['mine']))
  })

  it('selfSentIds and readReceipts short-circuit an empty id list', async () => {
    // Both return early rather than emitting `IN ()`, which is a syntax error.
    expect(await messages.selfSentIds(READER, [])).toEqual(new Set())
    expect(await messages.readReceipts(READER, [])).toEqual(new Set())
  })
})

describe('the ack and settle sets', () => {
  const unacked = async (id: string, over: Omit<Partial<MessageRow>, 'id'> = {}) =>
    await add({
      id,
      deliveryStatus: 'confirmed',
      deliveredAt: 't1',
      deliveredTo: READER,
      expectsResponse: true,
      ...over,
    })

  it('listDeliveredUnacked gates on expects_response, the ack and the expiry', async () => {
    await unacked('wanted')
    await unacked('no-request', { expectsResponse: false })
    await unacked('already-acked', { ackedBy: 'ack-1' })
    await unacked('expired', { expiresAt: 't0' })
    await unacked('still-valid', { expiresAt: 't9' })

    const ids = (await messages.listDeliveredUnacked(READER, 't5')).map((m) => m.id)
    expect(ids).toEqual(['still-valid', 'wanted'].sort())
    expect(ids).not.toContain('no-request')
    expect(ids).not.toContain('already-acked')
    expect(ids).not.toContain('expired')
  })

  it('listDeliveredUnacked accepts a READ row as well as a delivered one', async () => {
    await unacked('pulled', { deliveryStatus: 'confirmed', readAt: 't1' })
    expect((await messages.listDeliveredUnacked(READER, 't5')).map((m) => m.id)).toEqual(['pulled'])
  })

  it('listSettleNotifiable drops a row that already produced a settle notice', async () => {
    // The once-guard is STRUCTURAL: the notice is a `notification` row whose
    // in_reply_to is the original, so "already notified" means such a row exists.
    // No column carries it, which is why a conversion could drop the NOT EXISTS
    // and nothing else would look wrong.
    await unacked('not-yet')
    await unacked('already')
    await add({ id: 'the-notice', kind: 'notification', inReplyTo: 'already' })

    expect((await messages.listSettleNotifiable(READER, 't5')).map((m) => m.id)).toEqual([
      'not-yet',
    ])
    // The admission: the same row IS in the unacked set, so the exclusion above
    // belongs to the NOT EXISTS and not to some other clause.
    expect((await messages.listDeliveredUnacked(READER, 't5')).map((m) => m.id)).toContain(
      'already',
    )
  })

  // POD-5941. With no sqlite_stat1 the planner read `delivery_status = 'confirmed'`
  // through a delivery-status index and walked every confirmed row — nearly the
  // whole table, ~90 ms a statement on a real database, about once a second.
  // The recipient's own rows are the scan these readers must take. Plans are
  // read off the statements the repository actually prepared, so a rewrite of
  // the predicate is judged as it ships.
  it.each([
    ['listDeliveredUnacked', () => messages.listDeliveredUnacked(READER, 't5')],
    ['listSettleNotifiable', () => messages.listSettleNotifiable(READER, 't5')],
    ['pendingForSessionProof', () => messages.pendingForSessionProof(READER, 't5')],
  ] as const)('%s reads confirmed rows through the recipient index, not a status scan', async (_name, read) => {
    await unacked('wanted')
    const prepared: string[] = []
    const prepare = db.prepare.bind(db)
    db.prepare = ((text: string) => {
      prepared.push(text)
      return prepare(text)
    }) as typeof db.prepare
    try {
      expect((await read()).map((m) => m.id)).toEqual(['wanted'])
    } finally {
      db.prepare = prepare
    }
    const statement = prepared.find((text) => /^select /i.test(text) && text.includes('"acked_by" is null'))
    expect(statement).toBeDefined()
    const text = statement as string
    const params = Array.from({ length: (text.match(/\?/g) ?? []).length }, () => null)
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...params) as { detail: string }[])
      .map((row) => row.detail)
    expect(plan.join('\n')).toContain('idx_messages_delivered_to')
    expect(plan.filter((detail) => detail.includes('idx_messages_delivery_'))).toEqual([])
  })
})

describe('alreadyCommunicated', () => {
  it('is existence-only across every status, from the since bound', async () => {
    await add({ id: 'm1', fromIssue: asIssueId('iss_a'), createdAt: 't5', deliveryStatus: 'cancelled' })
    // Even a terminal row proves the producer already acted.
    expect(await messages.alreadyCommunicated('iss_a', { kind: 'issue', id: TARGET }, 't1')).toBe(
      true,
    )
    // Before the bound, it has not.
    expect(await messages.alreadyCommunicated('iss_a', { kind: 'issue', id: TARGET }, 't9')).toBe(
      false,
    )
    // A different producer has not.
    expect(await messages.alreadyCommunicated('iss_b', { kind: 'issue', id: TARGET }, 't1')).toBe(
      false,
    )
  })
})

describe('wake cooldowns', () => {
  it('records a keyed attempt and overwrites it on conflict', async () => {
    expect(await messages.getWakeCooldown('k')).toBeNull()
    await messages.recordWakeCooldown('k', 't1')
    expect(await messages.getWakeCooldown('k')).toBe('t1')
    await messages.recordWakeCooldown('k', 't2')
    expect(await messages.getWakeCooldown('k')).toBe('t2')
    // Keyed, so a neighbouring key is untouched.
    expect(await messages.getWakeCooldown('other')).toBeNull()
  })
})

describe('recordRead', () => {
  it('is idempotent and keeps the FIRST stamp', async () => {
    await add({ id: 'm1' })
    await messages.recordRead('m1', READER, 't1')
    // ON CONFLICT DO NOTHING, not DO UPDATE: the first sighting is the one that
    // happened, and a conversion that reaches for DO UPDATE here changes what the
    // column means.
    await messages.recordRead('m1', READER, 't2')
    expect(await messages.readReceipts(READER, ['m1'])).toEqual(new Set(['m1']))
    const stamp = db
      .prepare('SELECT read_at FROM message_reads WHERE message_id = ? AND session_id = ?')
      .get('m1', String(READER)) as { read_at: string }
    expect(stamp.read_at).toBe('t1')
  })
})
