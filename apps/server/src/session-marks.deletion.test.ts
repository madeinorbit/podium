/**
 * WHAT A REAL SESSION DELETION DOES TO THE MARKS IT LEFT BEHIND (PDM-424).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHAT IT REPLACES
 * ---------------------------------------------------------------------------
 *
 * `session-marks.feed.test.ts` proves the retraction ANCHOR fires — but it
 * builds the batch by hand, capturing the session removal AND a `sessionMarks`
 * removal per holder. **Production emits no such thing**:
 * `SessionKill.sessionRemovalSpecs` returns exactly
 * `[{ entity: 'session', op: 'remove' }]` and nothing else. So that file
 * manufactures the very refs that make the anchor fire, which is the
 * catalogue's "witness that manufactures its own end state" one level up: it
 * establishes the anchor ANSWERS, never that a deletion ASKS it.
 *
 * The phase reviewer required the real path instead. This file drives a real
 * `SessionRegistry` through the deletion API a person actually reaches and
 * asserts on the durable rows and the published change log.
 *
 * ---------------------------------------------------------------------------
 * WHAT I MEASURED BEFORE WRITING ANY REPAIR, because the reviewer's framing and
 * the code disagree on one point and the code wins
 * ---------------------------------------------------------------------------
 *
 * `SessionsRepository.purgeSession` — which DOES delete `session_user_state`
 * and `snoozes` — HAS NO PRODUCTION CALLER. Every reference is a test; its own
 * doc says "internal maintenance only". So "purge clears the tables and emits
 * no sidecar removal" is true of the method and reaches nobody.
 *
 * The deletions a person can actually cause are both SOFT: `killSession` and
 * the issue-owned path both stamp `deleted_at` through `softDeleteSessions`,
 * and NEITHER touches the per-user tables. The session row survives, the marks
 * rows survive, and `restoreDeletedForIssue` can bring the session back.
 *
 * WHAT I CONCLUDED FROM THAT AND HAVE WITHDRAWN [review 2 item 3]: I wrote that a
 * soft delete "must NOT retract a person's marks, because the session can return
 * and retracted marks would be gone when it did". That conflates two things.
 * CLIENT EVICTION AND DURABLE DESTRUCTION ARE DIFFERENT: an evicted client row
 * can be re-delivered when the session is restored, so durable retention does not
 * settle what the wire should do. Whether a marks row should be ADMITTED while its
 * session is tombstoned is a live question, and this issue does not decide it —
 * `session-marks.visibility.test.ts` pins the CURRENT answer (it is admitted,
 * because `maySeeSession` never consults `deleted_at`) as observed behaviour so a
 * change to it is visible rather than silent.
 *
 * What the cases below pin is narrower and is what I actually measured: the
 * durable rows SURVIVE a soft delete, no `sessionMarks` removal is published for
 * one, and a restore returns the session with those marks intact.
 */

import { asIssueId, asSessionId, asUserId, firstAdminMemberId, sessionMarksRowId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { openTestStore } from './test-support/open-test-store'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const reg of registries.splice(0)) await reg.dispose()
})

async function fixture() {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  await reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
  const owner = firstAdminMemberId()
  const other = asUserId('mem_other_holder')
  await store.users.create(
    { id: other, displayName: 'Other', role: 'member', createdAt: '2026-09-10T00:00:00.000Z', disabledAt: null },
    'test-only',
  )
  const doomed = (await reg.modules.sessions.createSession({
    ownerUserId: owner,
    agentKind: 'shell',
    cwd: '/w',
  })).sessionId
  // A KEPT SESSION, so "the deletion took everything" cannot pass.
  const kept = (await reg.modules.sessions.createSession({
    ownerUserId: owner,
    agentKind: 'shell',
    cwd: '/w2',
  })).sessionId
  // TWO HOLDERS on the doomed session, and a mark on the kept one.
  await store.sessions.markSessionRead(owner, doomed, '2026-09-11T00:00:00.000Z')
  await store.sessions.markSessionRead(other, doomed, '2026-09-11T01:00:00.000Z')
  await store.sessions.markSessionRead(owner, kept, '2026-09-11T02:00:00.000Z')
  await reg.modules.sessions.flushBroadcasts()
  // The state service is where the cross-owner writes live; the lifecycle module
  // does not re-export them.
  const state = reg.modules.sessions.state
  return { store, reg, state, owner, other, doomed, kept }
}

const marksChangesSince = async (
  f: Awaited<ReturnType<typeof fixture>>,
  cursor: number,
): Promise<{ id: string; op: string }[]> =>
  (await f.store.sync.changesSince(cursor))
    .filter((c) => c.entity === 'sessionMarks')
    .map((c) => ({ id: c.entityId, op: c.op }))

describe('a SOFT delete keeps the marks, and that is the correct answer', () => {
  it('leaves every holder’s durable row intact — the session can come back', async () => {
    const f = await fixture()

    await f.reg.modules.sessions.killSession({ sessionId: f.doomed })
    await f.reg.modules.sessions.flushBroadcasts()

    // THE SESSION ROW SURVIVES, tombstoned rather than removed — this is the
    // precondition that makes retracting marks wrong, so it is asserted rather
    // than assumed.
    expect.soft(await f.store.sessions.getSessions([f.doomed])).toHaveProperty('size', 1)
    // Both holders keep their marks, and so does the kept session's holder.
    expect.soft(await f.store.sessions.getReadAt(f.owner, f.doomed)).not.toBeNull()
    expect.soft(await f.store.sessions.getReadAt(f.other, f.doomed)).not.toBeNull()
    expect.soft(await f.store.sessions.getReadAt(f.owner, f.kept)).not.toBeNull()
  })

  it('publishes NO sessionMarks removal for a soft delete', async () => {
    const f = await fixture()
    const cursor = await f.store.sync.maxChangeSeq()

    await f.reg.modules.sessions.killSession({ sessionId: f.doomed })
    await f.reg.modules.sessions.flushBroadcasts()

    // The session removal IS published — that is the half that already worked,
    // and asserting it is what stops this case passing on a deletion that did
    // nothing at all.
    const sessionRemovals = (await f.store.sync.changesSince(cursor)).filter(
      (c) => c.entity === 'session' && c.op === 'remove' && c.entityId === f.doomed,
    )
    expect.soft(sessionRemovals).toHaveLength(1)
    // …and no marks row is retracted, because the marks are still true.
    expect.soft(await marksChangesSince(f, cursor)).toEqual([])
  })
})

describe('cross-owner writes are atomic with the rows they announce', () => {
  it('rolls the CLEAR back when the SECOND holder’s capture fails', async () => {
    // THE CASE THE REVIEWER ASKED FOR: two holders, failure on the second. Before
    // this repair the clear ran outside the publish, so this left the read marks
    // cleared and committed with holder one published and holder two not — and a
    // retry would find the rows already gone and do nothing.
    const f = await fixture()
    expect(await f.store.sessions.listSessionMarkHolders(f.doomed)).toHaveLength(2)
    const cursorBefore = await f.store.sync.maxChangeSeq()

    // Fail the SECOND append of the transaction: the first holder's capture
    // succeeds, the second throws. `mockImplementationOnce` twice is how the
    // ordering is made explicit rather than hoped for.
    let appends = 0
    const real = f.store.sync.appendChanges.bind(f.store.sync)
    const spy = vi
      .spyOn(f.store.sync, 'appendChanges')
      .mockImplementation(async (...args: Parameters<typeof real>) => {
        appends += 1
        if (appends === 2) throw new Error('second holder append failed')
        return await real(...args)
      })

    // ASSERTED AS A REJECTION, not on the message: the driver wraps a throw from
    // inside a prepared statement ("Failed query: insert into changes …"), so
    // matching the text would be asserting on the wrapper rather than on the
    // failure. That the SECOND append is the one that threw is pinned by the
    // counter, and the rollback below is the real claim.
    await expect(f.state.rearmUnreadForAll(f.doomed)).rejects.toThrow()
    expect(appends).toBeGreaterThanOrEqual(2)
    spy.mockRestore()

    // THE CLEAR ROLLED BACK: both holders still have their marks. Asserted for
    // BOTH, because rolling back only the second holder's row is the exact
    // partial state this repair exists to make impossible.
    expect.soft(await f.store.sessions.getReadAt(f.owner, f.doomed)).not.toBeNull()
    expect.soft(await f.store.sessions.getReadAt(f.other, f.doomed)).not.toBeNull()
    // And the untouched session is untouched — the control that says the rollback
    // was scoped to this transaction rather than global.
    expect.soft(await f.store.sessions.getReadAt(f.owner, f.kept)).not.toBeNull()

    // THE SERVICE OVERLAY, NOT ONLY SQLITE [review 2 item 1]. The publish inside
    // the failed span read each holder's overlay and POPULATED the cache; if the
    // invalidation is skipped on the throw, the service keeps serving values the
    // rollback discarded. Read BEFORE the retry, for BOTH holders, or the retry
    // would repair the cache and hide it.
    expect.soft((await f.state.overlay(f.owner, f.doomed)).readAt).not.toBeNull()
    expect.soft((await f.state.overlay(f.other, f.doomed)).readAt).not.toBeNull()
    // AND THE LOG DID NOT PARTIALLY COMMIT: no marks row for this session
    // survived the rollback, and the cursor did not advance.
    expect.soft(await marksChangesSince(f, cursorBefore)).toEqual([])
    expect.soft(await f.store.sync.maxChangeSeq()).toBe(cursorBefore)

    // THE RETRY NOW SUCCEEDS, which is the half that says the rollback left the
    // work re-doable rather than merely undone.
    await f.state.rearmUnreadForAll(f.doomed)
    expect.soft(await f.store.sessions.getReadAt(f.owner, f.doomed)).toBeNull()
    expect.soft(await f.store.sessions.getReadAt(f.other, f.doomed)).toBeNull()
    expect.soft(await f.store.sessions.getReadAt(f.owner, f.kept)).not.toBeNull()
  })

  it('rolls the SNOOZE clear back the same way, witnessed independently', async () => {
    // NOT INFERRED FROM SHARING `publishMarksForHolders` [review 2 item 1].
    // `clearAllSnoozes` reaches the store through `persistSession` and
    // `rearmUnreadForAll` through `store.transact`; they are different spans and
    // a fix to one says nothing about the other.
    const f = await fixture()
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    await f.store.sessions.setSnooze(f.owner, f.doomed, until)
    await f.store.sessions.setSnooze(f.other, f.doomed, null)
    // PRECONDITIONS on the snooze VALUES, which is what this case is about.
    expect.soft((await f.state.overlay(f.owner, f.doomed)).snoozedUntil).toBe(until)
    expect.soft((await f.state.overlay(f.other, f.doomed)).snoozedUntil).toBeNull()
    const cursorBefore = await f.store.sync.maxChangeSeq()

    let appends = 0
    const real = f.store.sync.appendChanges.bind(f.store.sync)
    const spy = vi
      .spyOn(f.store.sync, 'appendChanges')
      .mockImplementation(async (...args: Parameters<typeof real>) => {
        appends += 1
        if (appends === 2) throw new Error('second holder append failed')
        return await real(...args)
      })

    await expect(f.state.clearAllSnoozes(f.doomed)).rejects.toThrow()
    expect(appends).toBeGreaterThanOrEqual(2)
    spy.mockRestore()

    // DURABLE: both snoozes survive the rollback, with their VALUES intact —
    // `null` and a deadline are different facts and a restore that flattened them
    // would pass a mere "still present" assertion.
    expect.soft(await f.store.sessions.listSnoozes(f.owner)).toHaveProperty(f.doomed, until)
    expect.soft(await f.store.sessions.listSnoozes(f.other)).toHaveProperty(f.doomed, null)
    // CACHE: the service overlay agrees, which is the half the `finally` exists
    // for — read before any retry repairs it.
    expect.soft((await f.state.overlay(f.owner, f.doomed)).snoozedUntil).toBe(until)
    expect.soft((await f.state.overlay(f.other, f.doomed)).snoozedUntil).toBeNull()
    // LOG: nothing partially committed.
    expect.soft(await marksChangesSince(f, cursorBefore)).toEqual([])
    expect.soft(await f.store.sync.maxChangeSeq()).toBe(cursorBefore)

    // And the retry clears both.
    await f.state.clearAllSnoozes(f.doomed)
    expect.soft(await f.store.sessions.listSnoozes(f.owner)).not.toHaveProperty(f.doomed)
    expect.soft(await f.store.sessions.listSnoozes(f.other)).not.toHaveProperty(f.doomed)
  })

  it('publishes one marks row per holder when the clear succeeds', async () => {
    // The positive half. Without it the rollback case above is satisfied by a
    // path that never publishes anything at all.
    const f = await fixture()
    const cursor = await f.store.sync.maxChangeSeq()

    await f.state.rearmUnreadForAll(f.doomed)

    const rows = await marksChangesSince(f, cursor)
    expect.soft(rows.map((r) => r.id).sort()).toEqual(
      [sessionMarksRowId(f.owner, f.doomed), sessionMarksRowId(f.other, f.doomed)].sort(),
    )
    expect.soft(rows.every((r) => r.op === 'upsert')).toBe(true)
  })
})

describe('the boundary: where a deletion DOES have to retract', () => {
  it('a PURGE clears the durable rows and publishes nothing — there is no production caller', async () => {
    // `purgeSession` is the only path that deletes `session_user_state` and
    // `snoozes`, and it reaches the store DIRECTLY: no ledger, no changes, no
    // anchor. Every reference in the tree is a test, and its own doc says
    // "internal maintenance only".
    //
    // THIS CASE PINS THAT GAP RATHER THAN REPAIRING IT. Wiring retraction into a
    // method nothing calls would be unreachable code justified by a test.
    //
    // I CLAIMED THIS CASE WOULD "FAIL LOUDLY IF A CALLER IS ADDED" AND THAT IS
    // FALSE [review 2 item 4]. This case calls `purgeSession` ITSELF and asserts
    // what that call does; adding an independent production caller somewhere else
    // would not change its outcome by one assertion. It is not a guard and it
    // enforces nothing about the future.
    //
    // What "no production caller" rests on is a SOURCE SEARCH at the pin
    // `70a050199` — every reference to `purgeSession` in `apps/server/src` and
    // `packages/` is a test file. That is evidence about an inspected tree, not
    // enforcement, and no scanner is claimed or wanted here.
    const f = await fixture()
    const cursor = await f.store.sync.maxChangeSeq()

    await f.store.sessions.purgeSession(f.doomed)

    expect.soft(await f.store.sessions.getReadAt(f.owner, f.doomed)).toBeNull()
    expect.soft(await f.store.sessions.getReadAt(f.other, f.doomed)).toBeNull()
    // The kept session's mark is untouched — the control that says the purge was
    // scoped rather than total.
    expect.soft(await f.store.sessions.getReadAt(f.owner, f.kept)).not.toBeNull()
    // AND NOTHING WAS PUBLISHED. Recorded as the measured gap: a client holding
    // those rows is never told. Bounded by there being no production caller.
    expect.soft(await marksChangesSince(f, cursor)).toEqual([])
    expect.soft(
      (await f.store.sync.changesSince(cursor)).filter((c) => c.entity === 'session'),
    ).toEqual([])
  })

  it('a RESTORE returns the session with every holder’s marks intact', async () => {
    // THE OTHER HALF OF THE SOFT-DELETE STORY [review 2 item 3], and the reason
    // durable retention is the right call even though it does not settle the wire
    // question: the session comes back, and it comes back marked.
    const f = await fixture()
    const issueId = asIssueId('iss_restore_target')
    await f.store.sessions.softDeleteForIssue([f.doomed], issueId, '2026-09-13T00:00:00.000Z')
    // PRECONDITION — it really is tombstoned, so the restore below has something
    // to undo.
    expect.soft((await f.store.sessions.getSessions([f.doomed])).get(f.doomed)?.deletedAt).toBeTruthy()

    await f.store.sessions.restoreDeletedForIssue(issueId)

    const back = (await f.store.sessions.getSessions([f.doomed])).get(f.doomed)
    expect.soft(back?.deletedAt).toBeNull()
    // BOTH holders' marks survived the round trip…
    expect.soft(await f.store.sessions.getReadAt(f.owner, f.doomed)).not.toBeNull()
    expect.soft(await f.store.sessions.getReadAt(f.other, f.doomed)).not.toBeNull()
    // …and the kept session was never involved, which is the control that says
    // the restore was scoped to the issue rather than global.
    expect.soft(await f.store.sessions.getReadAt(f.owner, f.kept)).not.toBeNull()
    expect.soft((await f.store.sessions.getSessions([f.kept])).get(f.kept)?.deletedAt).toBeNull()
  })

  it('the holder list a retraction would need is readable while the rows exist', async () => {
    // What a repair needs, pinned now so the shape is known: holders must be
    // read BEFORE the delete, and the reader returns both of them and not the
    // kept session's.
    const f = await fixture()

    const holders = await f.store.sessions.listSessionMarkHolders(f.doomed)

    expect.soft([...holders].sort()).toEqual([f.other, f.owner].sort())
    expect.soft(await f.store.sessions.listSessionMarkHolders(f.kept)).toEqual([f.owner])
    expect.soft(
      await f.store.sessions.listSessionMarkHolders(asSessionId('ses_never_existed')),
    ).toEqual([])
    // The row id a retraction would carry, spelled the way the feed spells it.
    expect(sessionMarksRowId(f.owner, f.doomed)).toContain(f.doomed)
  })
})
