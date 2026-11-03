/**
 * OWNERSHIP IS RESOLVED FROM THE STORE, NOT FROM A PENDING PROMISE [POD-3507],
 * AND IT IS THE SESSION'S OWN [POD-6283].
 *
 * Every assertion here names the OWNER (or the machine verdict) it expects. The
 * defect POD-3507 pinned does not throw, it ANSWERS WRONGLY AND QUIETLY, so a
 * test that asserts "no error was raised" passes on the broken version.
 *
 * THE FIXTURE IS BUILT TO DISCRIMINATE. The session sits on an issue whose owner
 * (`u_issue_owner`) is never the session's own owner (`u_session_owner`).
 * Sessions are private (design §2.3): the right answer is the session's own
 * owner, and the issue's owner is the plausible wrong one that the task-owner
 * substitution POD-6283 removed would give. The issue double counts its reads,
 * so a resolver that still consults the issue is caught even when it happens to
 * answer correctly.
 *
 * The doubles are ASYNC, matching the store. A synchronous double cannot
 * exercise an await at all: it makes the unawaited and the awaited code
 * indistinguishable.
 */

import { asMachineId, asSessionId, asUserId, type SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionAuthz } from './session-authz'
import type { SessionOwnerMemo } from './session-state/service'

const ISSUE = 'iss_x'
/** The WRONG-but-plausible answer: the owner of the task the session sits on. */
const ISSUE_OWNER = 'u_issue_owner'
/** The RIGHT answer: the session's own durable owner. */
const SESSION_OWNER = 'u_session_owner'
const MACHINE = asMachineId('m1')

/** Not in the live map — every read must come from the durable row, which is
 *  the async path. A session that IS in memory never reaches it. */
const PARKED = asSessionId('s_parked')

interface Counts {
  loadSession: number
  getSessions: number
  issueReads: number
}

const parkedRow = (sessionId: SessionId) =>
  sessionId === PARKED
    ? { sessionId: PARKED, issueId: ISSUE, ownerUserId: asUserId(SESSION_OWNER), machineId: MACHINE }
    : undefined

function harness() {
  const counts: Counts = { loadSession: 0, getSessions: 0, issueReads: 0 }
  const authz = new SessionAuthz({
    clientControl: {},
    deps: {},
    listSessions: () => [],
    sessionById: async () => undefined,
    machines: { ownershipRows: () => [{ id: MACHINE }], grantsForMachine: () => [{ grantee: asUserId(SESSION_OWNER), verb: 'use' }, { grantee: asUserId(SESSION_OWNER), verb: 'manage', custody: true }] },
    sessions: { get: () => undefined },
    store: {
      users: { get: async () => undefined, roleOf: async () => undefined },
      sessions: {
        loadSession: async (sessionId: SessionId) => {
          counts.loadSession += 1
          return parkedRow(sessionId)
        },
        // The batched read a primed pass makes for the sessions not in memory.
        getSessions: async (sessionIds: readonly SessionId[]) => {
          counts.getSessions += 1
          return new Map(sessionIds.flatMap((id) => (parkedRow(id) ? [[id, parkedRow(id)] as const] : [])))
        },
      },
      // Present so a resolver that still asks the task for its owner answers
      // the WRONG owner rather than crashing, and is counted.
      issues: {
        getIssue: async (id: string) => {
          counts.issueReads += 1
          return id === ISSUE ? { id, ownerUserId: asUserId(ISSUE_OWNER) } : null
        },
        getIssues: async (ids: readonly string[]) => {
          counts.issueReads += 1
          return new Map(ids.map((id) => [id, { id, ownerUserId: asUserId(ISSUE_OWNER) }]))
        },
      },
    },
  } as never)
  return { authz, counts }
}

const emptyMemo = (): SessionOwnerMemo => ({})

describe('session ownership resolves through the store reads [POD-3507, POD-6283]', () => {
  it('names the SESSION’s own owner, not the task owner (no memo)', async () => {
    const { authz, counts } = harness()

    const owner = await authz.sessionOwner(PARKED)

    expect(owner).toEqual({ owner: SESSION_OWNER })
    // The durable row was actually read — the session is not in the live map,
    // so a fixture that accidentally served it from memory would prove nothing.
    expect(counts.loadSession).toBe(1)
    // And the task was never asked who owns it.
    expect(counts.issueReads).toBe(0)
  })

  it('names the session’s own owner through an UNPRIMED memo', async () => {
    const { authz, counts } = harness()

    expect(await authz.sessionOwner(PARKED, emptyMemo())).toEqual({ owner: SESSION_OWNER })
    expect(counts.issueReads).toBe(0)
  })

  it('names the session’s own owner through a PRIMED memo, reading the rows once', async () => {
    const { authz, counts } = harness()
    const memo = emptyMemo()

    await authz.primeOwnerMemo(memo, [PARKED])
    expect(await authz.sessionOwner(PARKED, memo)).toEqual({ owner: SESSION_OWNER })
    // Primed means the per-session read is never reached — if it were, the
    // assertion above could pass while `primeOwnerMemo` itself was broken.
    expect(counts.getSessions).toBe(1)
    expect(counts.loadSession).toBe(0)
    expect(counts.issueReads).toBe(0)
  })

  it('primes the memo with ROWS, not with pending promises', async () => {
    const { authz } = harness()
    const memo = emptyMemo()

    await authz.primeOwnerMemo(memo, [PARKED, asSessionId('s_unknown')])

    // Stated against the memo's own contents, because `primeOwnerMemo` returns
    // nothing: its whole observable effect is what it wrote here. A missing id
    // is recorded as null, so it is not read again.
    expect(memo.sessions?.get(PARKED)).toMatchObject({ ownerUserId: SESSION_OWNER })
    expect(memo.sessions?.get(PARKED)).not.toBeInstanceOf(Promise)
    expect(memo.sessions?.get(asSessionId('s_unknown'))).toBeNull()
  })

  it('reads the durable row for a machine-use decision on a session not in memory', async () => {
    const { authz } = harness()

    // Unawaited, `session.machineId` is undefined on the promise, so the
    // decision is taken against a machine that does not exist. The verdict this
    // pins is 'granted' — the principal holds custody of MACHINE — which is
    // exactly the answer the broken version cannot reach.
    const verdict = await authz.machineUseForClient(
      { user: SESSION_OWNER, role: 'member' } as never,
      PARKED,
    )

    expect(verdict).toBe('granted')
  })

  it('answers absent — not granted — for a session with no durable row', async () => {
    const { authz } = harness()

    // The other side of the same read: a miss must stay a miss. An unawaited
    // read makes EVERY session look present, because a promise is truthy.
    const verdict = await authz.machineUseForClient(
      { user: SESSION_OWNER, role: 'member' } as never,
      asSessionId('s_unknown'),
    )

    expect(verdict).toBe('absent')
  })
})
