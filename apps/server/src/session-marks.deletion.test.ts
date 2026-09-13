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
 * That changes what the correct behaviour IS. A soft delete must NOT retract a
 * person's marks: the session can return, and marks retracted on deletion would
 * be gone when it did. What the cases below pin is therefore the honest pair —
 * the durable rows SURVIVE a soft delete, and no `sessionMarks` removal is
 * published for one — plus the boundary where that stops being true.
 */

import { asSessionId, asUserId, firstAdminMemberId, sessionMarksRowId } from '@podium/model'
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

    // THE RETRY NOW SUCCEEDS, which is the half that says the rollback left the
    // work re-doable rather than merely undone.
    await f.state.rearmUnreadForAll(f.doomed)
    expect.soft(await f.store.sessions.getReadAt(f.owner, f.doomed)).toBeNull()
    expect.soft(await f.store.sessions.getReadAt(f.other, f.doomed)).toBeNull()
    expect.soft(await f.store.sessions.getReadAt(f.owner, f.kept)).not.toBeNull()
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
    // THIS CASE PINS THAT GAP RATHER THAN REPAIRING IT. Wiring retraction into
    // a method nothing calls would be unreachable code justified by a test, and
    // the honest record is that the exposure is bounded by having no caller. If
    // a caller is ever added, this case fails and says what is missing.
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
