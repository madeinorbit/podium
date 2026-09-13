/**
 * THE JOIN THAT MAKES NEUTRAL MARKS SAFE (PDM-408) — and the witness that it is
 * actually wired.
 *
 * The server stopped baking one viewer's `pinned` / `tuckedAt` / `readAt` into
 * the broadcast payload; the three keys stay on `IssueWire` carrying
 * `NEUTRAL_ISSUE_MARKS`, and each reader's real values arrive on the per-user
 * `issueMarks` sidecar, which the replica joins back on by issue id.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIRST TEST IS ABOUT REGISTRATION AND NOT ABOUT DATA
 * ---------------------------------------------------------------------------
 *
 * **A neutral value is indistinguishable from "genuinely unmarked".** If the
 * sidecar never arrives — the kind missing from `BOOTSTRAP_KIND_TO_COLLECTION`,
 * the collection never created, the client never subscribing — every user sees
 * an unmarked board and NOTHING IS RED. That is a false green of exactly the
 * shape this epic collects, and it is the reason the coordinator required a
 * deliberate-removal witness over the REGISTRATION rather than over the values.
 *
 * So the first test drives a real `BootstrapSession` and requires the row to
 * land in the collection. Delete `issueMarks: 'issueMarks'` from `bootstrap.ts`
 * and it reddens BY NAME: the installer skips a kind that map does not name, the
 * collection stays empty, and the join silently falls back to neutral — which is
 * precisely the failure being guarded, reproduced.
 *
 * The value tests below would ALL still pass with that line deleted, because
 * they call the join directly. That is the point: they prove the join is
 * correct, and only the first proves it runs.
 */

import {
  asIssueId,
  asUserId,
  type IssueMarksWire,
  type IssueWire,
  issueMarksRowId,
  joinIssueMarks,
  NEUTRAL_ISSUE_MARKS,
} from '@podium/model'
import type { MetadataChangeLenient } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { BootstrapSession } from './bootstrap'
import { COLD_CURSOR } from './feed'
import { createReplica, memoryStorage } from './replica'

const ME = asUserId('mem_0AAAAAAAAAAAAAAAAAAAAAAAAAA')
const ISSUE = asIssueId('iss_1')
const AT = '2026-06-30T00:00:00.000Z'

const myMarks = (over: Partial<IssueMarksWire> = {}): IssueMarksWire =>
  ({
    userId: ME,
    issueId: ISSUE,
    pinned: true,
    tuckedAt: null,
    readAt: AT,
    ...over,
  }) as IssueMarksWire

describe('the sidecar is REGISTERED, not merely correct', () => {
  it('lands a bootstrapped issueMarks row in the replica collection', async () => {
    // The deliberate-removal witness. This is the ONLY test in this file that
    // fails when the kind is unregistered; every other one calls the join
    // directly and would stay green while no row ever reached a client.
    const replica = createReplica({ storage: memoryStorage() })
    const change = {
      seq: 1,
      entity: 'issueMarks',
      id: issueMarksRowId(ME, ISSUE),
      op: 'upsert',
      value: myMarks(),
    } as MetadataChangeLenient

    const session = new BootstrapSession(
      replica,
      { ...COLD_CURSOR, seq: 1 },
      {
        yieldToLoop: () => Promise.resolve(),
      },
    )
    await session.install({ changes: [change] })
    session.commit()

    expect(replica.rows('issueMarks')).toHaveLength(1)
    expect(replica.rows('issueMarks')[0]).toMatchObject({
      issueId: ISSUE,
      pinned: true,
      readAt: AT,
    })
  })
})

describe('joining this reader’s marks over the broadcast', () => {
  /** A broadcast row as the server now sends it: neutral marks for everybody. */
  const neutralWire = { id: ISSUE, title: 'X', ...NEUTRAL_ISSUE_MARKS } as unknown as IssueWire

  it('replaces the neutral marks with this reader’s own', () => {
    const joined = joinIssueMarks(neutralWire, myMarks())

    expect(joined.pinned).toBe(true)
    expect(joined.readAt).toBe(AT)
  })

  it('leaves the row ALONE when this reader has no marks — the ordinary case', () => {
    // Most people have not touched most issues, and the store only holds a row
    // for an issue somebody actually marked. The producer already sends neutral,
    // so leaving the row alone renders an unmarked issue.
    const joined = joinIssueMarks(neutralWire, undefined)

    expect(joined.pinned).toBe(false)
    expect(joined.tuckedAt).toBeNull()
    expect(joined.readAt).toBeNull()
  })

  it('does NOT overwrite a row this client has painted optimistically', () => {
    // RENAMED AND REVERSED (PDM-408), old name: 'OVERWRITES a payload that still
    // carries somebody else's marks'. The join used to force neutral on an
    // absent row so it could act as a last gate against a regressed producer.
    // That also wiped THE CLIENT'S OWN optimistic overlay — pressing "mark read"
    // stamps `readAt` on the issue row, and the next derivation erased it, so
    // the unread dot flicked straight back on. `runtime.test.ts` caught it.
    //
    // The producer is guarded at the producer instead:
    // `issue-marks.projection.test.ts` asserts the broadcast carries nobody's
    // marks, with a deliberate break that reddens it by name.
    const optimistic = {
      id: ISSUE,
      title: 'X',
      pinned: false,
      tuckedAt: null,
      readAt: AT,
    } as unknown as IssueWire

    const joined = joinIssueMarks(optimistic, undefined)

    expect(joined.readAt).toBe(AT)
  })

  it('does not leak the identity half onto the issue row', () => {
    // `userId` and `issueId` ride the sidecar value so a client can drop a
    // foreign row; they are not fields of an issue and must not become ones.
    const joined = joinIssueMarks(neutralWire, myMarks()) as Record<string, unknown>

    expect(joined.userId).toBeUndefined()
    expect(Object.keys(joined).filter((k) => k === 'issueId')).toEqual([])
  })
})
