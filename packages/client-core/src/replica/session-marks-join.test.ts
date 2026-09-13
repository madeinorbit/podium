/**
 * THE JOIN THAT MAKES NEUTRAL SESSION MARKS SAFE (PDM-424) — and the witness
 * that it is actually wired.
 *
 * The server stopped baking the earliest admin's `readAt` / derived `unread` /
 * `snoozedUntil` into the broadcast payload; the keys stay on `SessionMeta`
 * carrying `NEUTRAL_SESSION_MARKS`, and each reader's real values arrive on the
 * per-user `sessionMarks` sidecar, which the replica joins back on by session id.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIRST TEST IS ABOUT REGISTRATION AND NOT ABOUT DATA
 * ---------------------------------------------------------------------------
 *
 * **A neutral value is indistinguishable from "genuinely never opened".** If the
 * sidecar never arrives — the kind missing from `BOOTSTRAP_KIND_TO_COLLECTION`,
 * the collection never created, the client never subscribing — every person sees
 * every session unread and NOTHING IS RED. That is a false green of exactly the
 * shape this epic collects, and it is why a deliberate-removal witness is
 * required over the REGISTRATION rather than over the values.
 *
 * So the first test drives a real `BootstrapSession` and requires the row to
 * land in the collection. Delete `sessionMarks: 'sessionMarks'` from
 * `bootstrap.ts` and it reddens BY NAME: the installer skips a kind that map
 * does not name, the collection stays empty, and the join silently falls back to
 * neutral — precisely the failure being guarded, reproduced.
 *
 * THE LEGACY REPLICA AND THE KERNEL REPLICA ARE TWO DIFFERENT KEY RESOLVERS, and
 * the registration case here exercises the LEGACY one: `createReplica` is the
 * TanStack replica whose `keyFor` arm resolves `sessionMarks` to `sessionId`. The
 * KERNEL replica's matching `rowKey` arm in `kernel/kinds.ts` is a SEPARATE copy
 * of the same question, exercised by the binding cases in
 * `engine/replica-binding.test.ts`, which drive `createKernelReplica`. Having one
 * arm is not having the other — PDM-408 found exactly that on the issue twin,
 * where a marks-only delta published nothing until the legacy arm existed.
 *
 * The value tests below would ALL still pass with that line deleted, because
 * they call the join directly. That is the point: they prove the join is
 * correct, and only the first proves it runs.
 *
 * ---------------------------------------------------------------------------
 * `unread` IS RE-DERIVED HERE, WHICH THE ISSUE TWIN DID NOT HAVE TO DO
 * ---------------------------------------------------------------------------
 *
 * `issueMarks` carries three stored values. A session's `unread` is computed
 * from THIS row's `readAt` and the SHARED row's `lastActiveAt`, so the sidecar
 * carries only the per-person input and the join re-derives. The cases below
 * pin both directions of that rule against a moving `lastActiveAt`, because a
 * join that simply copied a stored `unread` would pass a test that never moved
 * it.
 */

import {
  asSessionId,
  asUserId,
  joinSessionMarks,
  NEUTRAL_SESSION_MARKS,
  type SessionMarksWire,
  type SessionMeta,
  sessionMarksRowId,
} from '@podium/model'
import type { MetadataChangeLenient } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { BootstrapSession } from './bootstrap'
import { COLD_CURSOR } from './feed'
import { createReplica, memoryStorage } from './replica'

const ME = asUserId('mem_0AAAAAAAAAAAAAAAAAAAAAAAAAA')
const SESSION = asSessionId('ses_1')
const READ_AT = '2026-06-30T12:00:00.000Z'
const BEFORE_READ = '2026-06-30T06:00:00.000Z'
const AFTER_READ = '2026-06-30T18:00:00.000Z'

const myMarks = (over: Partial<SessionMarksWire> = {}): SessionMarksWire =>
  ({
    userId: ME,
    sessionId: SESSION,
    readAt: READ_AT,
    ...over,
  }) as SessionMarksWire

/** A broadcast row as the server now sends it: neutral marks for everybody. */
const neutralWire = (lastActiveAt: string): SessionMeta =>
  ({
    sessionId: SESSION,
    title: 'X',
    lastActiveAt,
    ...NEUTRAL_SESSION_MARKS,
    unread: true,
  }) as unknown as SessionMeta

describe('the sidecar is REGISTERED, not merely correct', () => {
  it('lands a bootstrapped sessionMarks row in the replica collection', async () => {
    // The deliberate-removal witness. This is the ONLY test in this file that
    // fails when the kind is unregistered; every other one calls the join
    // directly and would stay green while no row ever reached a client.
    const replica = createReplica({ storage: memoryStorage() })
    const change = {
      seq: 1,
      entity: 'sessionMarks',
      id: sessionMarksRowId(ME, SESSION),
      op: 'upsert',
      value: myMarks(),
    } as MetadataChangeLenient

    const session = new BootstrapSession(
      replica,
      { ...COLD_CURSOR, seq: 1 },
      { yieldToLoop: () => Promise.resolve() },
    )
    await session.install({ changes: [change] })
    session.commit()

    expect(replica.rows('sessionMarks')).toHaveLength(1)
    expect(replica.rows('sessionMarks')[0]).toMatchObject({
      sessionId: SESSION,
      readAt: READ_AT,
    })
  })
})

describe('joining this reader’s marks over the broadcast', () => {
  it('replaces the neutral read mark with this reader’s own', () => {
    const joined = joinSessionMarks(neutralWire(BEFORE_READ), myMarks())

    expect.soft(joined.readAt).toBe(READ_AT)
    // Activity PREDATES the read, so this person is caught up.
    expect.soft(joined.unread).toBe(false)
  })

  it('re-derives unread against the SHARED lastActiveAt, not a stored flag', () => {
    // THE CASE A STORED `unread` WOULD GET WRONG. Same marks row, same readAt —
    // only the shared session moved. A sidecar that carried `unread: false` would
    // keep telling this person they are caught up on activity that arrived after
    // they last looked.
    const joined = joinSessionMarks(neutralWire(AFTER_READ), myMarks())

    expect.soft(joined.readAt).toBe(READ_AT)
    expect.soft(joined.unread).toBe(true)
  })

  it('treats a null readAt as never opened, whatever the activity', () => {
    const joined = joinSessionMarks(neutralWire(BEFORE_READ), myMarks({ readAt: null }))

    expect.soft(joined.readAt).toBeNull()
    expect.soft(joined.unread).toBe(true)
  })

  it('takes the SERVER row over a value this client painted optimistically', () => {
    // THE HELD-ROW CASE [phase review item 3]. The absent-sidecar case below says
    // what happens with no row; this says what happens when one ARRIVES over an
    // optimistic paint. The server's value wins, because the sidecar is the
    // authority for this person's marks — the optimistic paint was a guess about
    // exactly this row.
    const painted = { ...neutralWire(BEFORE_READ), readAt: 'optimistic-guess', unread: false }

    const joined = joinSessionMarks(painted, myMarks())

    expect.soft(joined.readAt).toBe(READ_AT)
    expect.soft(joined.unread).toBe(false)
  })

  it('leaves the row ALONE when this reader has no marks — the ordinary case', () => {
    // Most people have not opened most sessions, and the store only holds a row
    // for one somebody actually opened or snoozed. The producer already sends
    // neutral, so leaving the row alone renders an unopened session.
    //
    // IT MUST NOT FORCE NEUTRAL. The rows reaching a join have already had this
    // client's optimistic overlay applied, and an unconditional overwrite wipes
    // the `readAt` a person just wrote by pressing "mark read" — PDM-408
    // measured exactly that on the issue twin, where the dot flicked back on
    // under the cursor.
    const painted = { ...neutralWire(BEFORE_READ), readAt: 'optimistic', unread: false }

    expect(joinSessionMarks(painted, undefined)).toBe(painted)
  })

  it('carries the three-valued snooze intact, including the ABSENT case', () => {
    // `undefined` is "no snooze row"; `null` is "until the next message". They
    // are different facts and flattening them turns "not snoozed" into "snoozed"
    // for every person who never snoozed anything.
    const noRow = joinSessionMarks(neutralWire(BEFORE_READ), myMarks())
    const untilNextMessage = joinSessionMarks(
      neutralWire(BEFORE_READ),
      myMarks({ snoozedUntil: null }),
    )
    const deadline = joinSessionMarks(
      neutralWire(BEFORE_READ),
      myMarks({ snoozedUntil: AFTER_READ }),
    )

    expect.soft('snoozedUntil' in noRow).toBe(false)
    expect.soft(untilNextMessage.snoozedUntil).toBeNull()
    expect.soft(deadline.snoozedUntil).toBe(AFTER_READ)
  })

  it('does not leak the row’s addressing fields onto the session', () => {
    // `userId` / `sessionId` are the row's own identity, not session fields. A
    // join that spread the whole payload would put a user id on every session
    // wire — a per-user key on a shared-shaped row is how this class of defect
    // starts.
    const joined = joinSessionMarks(neutralWire(BEFORE_READ), myMarks()) as Record<string, unknown>

    expect.soft('userId' in joined).toBe(false)
    expect.soft(joined.sessionId).toBe(SESSION)
  })
})
