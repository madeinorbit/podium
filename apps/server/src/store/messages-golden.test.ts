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
import { MessagesRepository } from './messages'
import type { MessageRow } from './types'

let db: ReturnType<typeof openDatabase>
let messages: MessagesRepository

beforeEach(() => {
  db = openMigratedTestDatabase()
  messages = new MessagesRepository(createBunStoreExecutor({ database: db }))
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
    status: 'queued',
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

const add = async (input: Omit<Partial<MessageRow>, 'id'> & { id: string }): Promise<void> => {
  await messages.addMessage(message(input))
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
    await add({ id: 'm4', fromIssue: asIssueId('iss_c'), status: 'delivered' })

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
// RESTING_ON_A_PUSH — the shared predicate, and the arm nothing walks
// ---------------------------------------------------------------------------

describe('RESTING_ON_A_PUSH — the two arms it admits and the one it excludes', () => {
  /**
   * The predicate's whole purpose is the EXCLUSION. `delivered` WITH
   * `injected_at` was confirmed by the transcript echo, so a driver refusal
   * arriving afterwards is late evidence about a settled question, and walking
   * that row backwards is the defect the predicate exists to prevent.
   *
   * Both writers that share the predicate are tested against all three rows, so
   * a widening cannot hide in whichever one a service test happens to drive.
   */
  const seedThreeRows = async (): Promise<void> => {
    // BUILT THROUGH THE PRODUCTION TRANSITIONS, not by writing the columns
    // directly, and that is not fastidiousness: `addMessage` writes 29 columns
    // and `injected_at` is not one of them, so a fixture that passed
    // `injectedAt` in the row would silently persist null and every assertion
    // below would be about a state the system cannot reach.
    //
    // Arm 1: confirmed on injection — delivered, no injected_at.
    await add({ id: 'arm-delivered' })
    await messages.markDelivered('arm-delivered', String(READER), 't1')
    // Arm 2: enveloped, dispatched, echo still owed — queued WITH injected_at.
    await add({ id: 'arm-queued' })
    await messages.markInjected('arm-queued', READER, 't1')
    // EXCLUDED: pushed AND echo-confirmed. Matches neither arm, must never move.
    await add({ id: 'excluded' })
    await messages.markInjected('excluded', READER, 't1')
    await messages.markDelivered('excluded', String(READER), 't1')
  }

  it('retractOptimisticDelivery moves both arms back to queued and refuses the confirmed row', async () => {
    await seedThreeRows()

    expect(await messages.retractOptimisticDelivery('arm-delivered', READER)).toBe(true)
    expect(await messages.retractOptimisticDelivery('arm-queued', READER)).toBe(true)
    expect(await messages.retractOptimisticDelivery('excluded', READER)).toBe(false)

    // THE BOOLEAN IS NOT THE ASSERTION. A predicate that matched everything would
    // also return true twice; only the row state distinguishes it.
    const one = await back('arm-delivered')
    expect(one?.status).toBe('queued')
    expect(one?.deliveredAt).toBeNull()
    expect(one?.injectedAt).toBeNull()
    // `delivered_to` STAYS: it is the only evidence of which session refused.
    expect(one?.deliveredTo).toBe(READER)

    // The confirmed row is untouched in every column the write would have set.
    const untouched = await back('excluded')
    expect(untouched?.status).toBe('delivered')
    expect(untouched?.deliveredAt).toBe('t1')
    expect(untouched?.injectedAt).toBe('t1')
  })

  it('retractOptimisticDelivery removes the reader receipt, and only for that reader', async () => {
    await add({ id: 'arm-delivered' })
    await messages.markDelivered('arm-delivered', String(READER), 't1')
    await messages.recordRead('arm-delivered', OTHER, 't1')

    await messages.retractOptimisticDelivery('arm-delivered', READER)

    // A receipt saying this session saw a message it never got hides the row from
    // that session's own pending set — the same lie one table over.
    expect(await messages.readReceipts(READER, ['arm-delivered'])).toEqual(new Set())
    // Another reader's receipt is not this write's business.
    expect(await messages.readReceipts(OTHER, ['arm-delivered'])).toEqual(
      new Set(['arm-delivered']),
    )
  })

  it('retractOptimisticDelivery is idempotent: a repeat matches nothing', async () => {
    await add({ id: 'arm-queued' })
    await messages.markInjected('arm-queued', READER, 't1')
    expect(await messages.retractOptimisticDelivery('arm-queued', READER)).toBe(true)
    expect(await messages.retractOptimisticDelivery('arm-queued', READER)).toBe(false)
  })

  it('markSendRefused walks the same three rows the same way', async () => {
    await seedThreeRows()

    expect(await messages.markSendRefused('arm-delivered', READER, 't2', 'teardown')).toBe(true)
    expect(await messages.markSendRefused('arm-queued', READER, 't2', 'teardown')).toBe(true)
    expect(await messages.markSendRefused('excluded', READER, 't2', 'teardown')).toBe(false)

    const dead = await back('arm-queued')
    expect(dead?.status).toBe('dead_letter')
    expect(dead?.deadLetteredAt).toBe('t2')
    // Both refusal routes leave the same two stamps, so one undelivered turn
    // reads the same way whichever route reported it.
    expect(dead?.deliveryDeferredAt).toBe('t2')
    expect(dead?.deliveryDeferredReason).toBe('teardown')

    expect((await back('excluded'))?.status).toBe('delivered')
  })

  it('markSendRefused is scoped to the session the row was aimed at', async () => {
    await add({ id: 'arm-queued' })
    await messages.markInjected('arm-queued', READER, 't1')
    // A refusal reported by a session this row was never pushed to must not move
    // it. `delivered_to = ?` is half the predicate and is easy to drop.
    expect(await messages.markSendRefused('arm-queued', OTHER, 't2', 'teardown')).toBe(false)
    expect((await back('arm-queued'))?.status).toBe('queued')
  })
})

// ---------------------------------------------------------------------------
// The guarded ledger transitions
// ---------------------------------------------------------------------------

describe('guarded ledger transitions', () => {
  it('markDeliveryAbandoned dedupes through the queued guard', async () => {
    await add({ id: 'm1' })
    expect(await messages.markDeliveryAbandoned('m1', READER, 't1', 'never-live')).toBe(true)
    // Abandonment reports are retryable and repeat across restarts; the second
    // finds a row that is no longer queued. This is how the caller emits exactly
    // one transition per turn.
    expect(await messages.markDeliveryAbandoned('m1', READER, 't2', 'never-live')).toBe(false)
    expect((await back('m1'))?.deadLetteredAt).toBe('t1')
  })

  it('markDeliveryAbandoned COALESCEs delivered_to rather than overwriting it', async () => {
    await add({ id: 'm1', deliveredTo: OTHER })
    await messages.markDeliveryAbandoned('m1', READER, 't1', 'teardown')
    // The row was aimed at OTHER; the report names READER. The existing target is
    // the evidence and must win.
    expect((await back('m1'))?.deliveredTo).toBe(OTHER)
  })

  it('markCancelled only moves a queued row', async () => {
    await add({ id: 'q' })
    await add({ id: 'd', status: 'delivered', deliveredAt: 't1' })
    expect(await messages.markCancelled('q')).toBe(true)
    expect(await messages.markCancelled('d')).toBe(false)
    expect((await back('q'))?.status).toBe('cancelled')
    expect((await back('d'))?.status).toBe('delivered')
  })

  it('markDeliveredByPull COALESCEs the push target instead of erasing it', async () => {
    // The defect this guards: markInjected stamps the session a message was
    // PUSHED to while leaving status queued, and a plain overwrite here erased
    // that target the moment the agent opened its inbox — the row then read as
    // "delivered to nobody" despite having landed in a transcript.
    await add({ id: 'pushed' })
    await messages.markInjected('pushed', OTHER, 't1')
    expect(await messages.markDeliveredByPull('pushed', String(READER), 't2')).toBe(true)

    const row = await back('pushed')
    expect(row?.status).toBe('delivered')
    expect(row?.deliveredTo).toBe(OTHER)
    // The pull still proves THIS reader has it, whoever the row was pushed to.
    expect(await messages.readReceipts(READER, ['pushed'])).toEqual(new Set(['pushed']))
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
    await add({ id: 'shared', status: 'cancelled' })
    expect(await messages.markRead('shared', String(READER), 't2')).toBe(false)
    expect(await messages.readReceipts(READER, ['shared'])).toEqual(new Set(['shared']))
  })

  it('markRead advances from queued AND from delivered', async () => {
    await add({ id: 'q' })
    await add({ id: 'd', status: 'delivered', deliveredAt: 't1' })
    expect(await messages.markRead('q', String(READER), 't2')).toBe(true)
    // A delivered row can still be marked read if later pulled — the status set
    // is two-valued and dropping one arm is invisible to a queued-only fixture.
    expect(await messages.markRead('d', String(READER), 't2')).toBe(true)
    expect((await back('d'))?.status).toBe('read')
  })

  it('markDeadLetter takes its no-cause branch without stamping a reason', async () => {
    await add({ id: 'gone' })
    expect(await messages.markDeadLetter('gone', 't1')).toBe(true)
    const row = await back('gone')
    expect(row?.status).toBe('dead_letter')
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
    expect(await messages.markDeadLetter('refused', 't1', 'delivery-failed')).toBe(true)
    const row = await back('refused')
    expect(row?.deliveryDeferredAt).toBe('t1')
    expect(row?.deliveryDeferredReason).toBe('delivery-failed')
  })

  it('markDeadLetter refuses a row that is not queued, in both branches', async () => {
    await add({ id: 'a', status: 'delivered', deliveredAt: 't1' })
    await add({ id: 'b', status: 'delivered', deliveredAt: 't1' })
    expect(await messages.markDeadLetter('a', 't2')).toBe(false)
    expect(await messages.markDeadLetter('b', 't2', 'teardown')).toBe(false)
  })

  it('clearInjected re-arms a queued push and leaves a raced row alone', async () => {
    await add({ id: 'ghost' })
    await messages.markInjected('ghost', READER, 't1')
    await add({ id: 'raced' })
    await messages.markInjected('raced', READER, 't1')
    await messages.markDelivered('raced', String(READER), 't1')
    expect(await messages.clearInjected('ghost')).toBe(true)
    expect(await messages.clearInjected('raced')).toBe(false)
    expect((await back('ghost'))?.injectedAt).toBeNull()
    expect((await back('raced'))?.injectedAt).toBe('t1')
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
    expect(
      await messages.expireObserved({
        id: 'no-expiry',
        createdAt: 't0',
        lifecycle: 'wait',
        expiresAt: null,
      }),
    ).toBe(true)
    expect((await back('no-expiry'))?.status).toBe('expired')
  })

  it('matches a non-null expires_at', async () => {
    await add({ id: 'with-expiry', expiresAt: 't9' })
    expect(
      await messages.expireObserved({
        id: 'with-expiry',
        createdAt: 't0',
        lifecycle: 'wait',
        expiresAt: 't9',
      }),
    ).toBe(true)
  })

  it('refuses when any observed fact has moved underneath the janitor', async () => {
    await add({ id: 'moved', expiresAt: 't9' })
    // Each clause is dropped one at a time, so a predicate missing any single one
    // is caught rather than merely a predicate missing all of them.
    expect(
      await messages.expireObserved({
        id: 'moved',
        createdAt: 'WRONG',
        lifecycle: 'wait',
        expiresAt: 't9',
      }),
    ).toBe(false)
    expect(
      await messages.expireObserved({
        id: 'moved',
        createdAt: 't0',
        lifecycle: 'wake',
        expiresAt: 't9',
      }),
    ).toBe(false)
    expect(
      await messages.expireObserved({
        id: 'moved',
        createdAt: 't0',
        lifecycle: 'wait',
        expiresAt: null,
      }),
    ).toBe(false)
    expect((await back('moved'))?.status).toBe('queued')
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
    await messages.markInjected('pushed', READER, 't1')
    await add({ id: 'done', toKind: 'session', toId: String(READER) })
    await messages.markDelivered('done', String(READER), 't1')
    expect(await messages.queuedPositionForSession(READER, 'pushed')).toBeUndefined()
    expect(await messages.queuedPositionForSession(READER, 'done')).toBeUndefined()
  })

  it('pendingForPage pages forward by keyset and stops at `through`', async () => {
    for (const id of ['a', 'b', 'c', 'd']) await add({ id, createdAt: `t-${id}` })
    const to = { kind: 'issue' as const, id: TARGET }

    const first = await messages.pendingForPage(to, { limit: 2 })
    expect(first.map((m) => m.id)).toEqual(['a', 'b'])

    const next = await messages.pendingForPage(to, {
      after: { createdAt: 't-b', id: 'b' },
      limit: 2,
    })
    expect(next.map((m) => m.id)).toEqual(['c', 'd'])

    // `through` is INCLUSIVE (`<=`), which is what makes a high-water snapshot a
    // finite scan rather than one that races new arrivals.
    const bounded = await messages.pendingForPage(to, {
      through: { createdAt: 't-c', id: 'c' },
    })
    expect(bounded.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('pendingHighWater returns the LAST queued row in delivery order', async () => {
    await add({ id: 'a', createdAt: 't1' })
    await add({ id: 'z', createdAt: 't3' })
    await add({ id: 'm', createdAt: 't2' })
    expect(await messages.pendingHighWater({ kind: 'issue', id: TARGET })).toEqual({
      createdAt: 't3',
      id: 'z',
    })
  })

  it('pendingHighWater is null when nothing is queued', async () => {
    await add({ id: 'a', status: 'delivered', deliveredAt: 't1' })
    expect(await messages.pendingHighWater({ kind: 'issue', id: TARGET })).toBeNull()
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
    await add({ id: 'm4', fromIssue: asIssueId('iss_b'), status: 'read', readAt: 't1' })

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
    await add({ id: 'm3', status: 'delivered', deliveredAt: 't1' })
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
      status: 'delivered',
      deliveredAt: 't5',
      deliveredTo: READER,
    })

    const summary = await messages.pendingSummaryForSession(asIssueId(TARGET) as IssueId, READER)
    expect(summary.count).toBe(1)
    expect(summary.senders).toEqual([
      { fromKind: 'agent', fromIssue: null, fromSession: String(PEER) },
    ])
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
  const unacked = (id: string, over: Omit<Partial<MessageRow>, 'id'> = {}) =>
    add({
      id,
      status: 'delivered',
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
    await unacked('pulled', { status: 'read', readAt: 't1' })
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
})

describe('alreadyCommunicated', () => {
  it('is existence-only across every status, from the since bound', async () => {
    await add({ id: 'm1', fromIssue: asIssueId('iss_a'), createdAt: 't5', status: 'cancelled' })
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
