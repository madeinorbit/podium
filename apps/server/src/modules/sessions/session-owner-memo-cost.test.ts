/**
 * The per-pass ownership memo: what it COSTS, and that batching it did not
 * change what it ANSWERS [POD-1653].
 *
 * Since POD-6283 a session's owner is its own durable `owner_user_id` and
 * nothing else, so the only reads a pass makes are the session rows of the
 * sessions that are not in memory. Two failures are still pinned here, because
 * they fail independently.
 *
 * 1. THE MEMO MUST REACH THIS CODE. A full projection that drops the memo
 *    re-reads every parked session's row one statement at a time. Nothing
 *    fails; it is only slow, and the cost assertions below are the only thing
 *    that can see it.
 *
 * 2. BATCHING MUST NOT CHANGE THE ANSWER. The equivalence test grades the
 *    primed path against the unprimed one as an oracle, over sessions on a task
 *    (whose owner is NOT the answer), on a missing task, with no task, and an id
 *    with no row at all. The task double counts its reads, so a resolver that
 *    still consults the task is caught.
 */

import { asSessionId, asUserId, type SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionAuthz } from './session-authz'
import type { SessionOwnerMemo } from './session-state/service'

interface Counts {
  loadSession: number
  getSessions: number
  issueReads: number
}

const ISSUE_A = 'iss_a'
const ISSUE_MISSING = 'iss_gone'

/** Sessions: two on one task, one on a missing task, two with none. */
const SESSIONS: { sessionId: SessionId; issueId?: string; ownerUserId: string }[] = [
  { sessionId: asSessionId('s1'), issueId: ISSUE_A, ownerUserId: 'u_one' },
  { sessionId: asSessionId('s2'), issueId: ISSUE_A, ownerUserId: 'u_two' },
  { sessionId: asSessionId('s3'), issueId: ISSUE_MISSING, ownerUserId: 'u_three' },
  { sessionId: asSessionId('s4'), ownerUserId: 'u_four' },
  { sessionId: asSessionId('s5'), ownerUserId: 'u_five' },
]
const UNKNOWN = asSessionId('s_unknown')

const row = (sessionId: SessionId) => {
  const found = SESSIONS.find((s) => s.sessionId === sessionId)
  return found ? { ...found, ownerUserId: asUserId(found.ownerUserId) } : undefined
}

function harness() {
  const counts: Counts = { loadSession: 0, getSessions: 0, issueReads: 0 }
  const authz = new SessionAuthz({
    sessions: { get: () => undefined },
    store: {
      sessions: {
        loadSession: async (sessionId: SessionId) => {
          counts.loadSession += 1
          return row(sessionId)
        },
        // The batched read a primed pass makes for the sessions not in memory.
        getSessions: async (sessionIds: readonly SessionId[]) => {
          counts.getSessions += 1
          return new Map(sessionIds.flatMap((id) => (row(id) ? [[id, row(id)] as const] : [])))
        },
      },
      issues: {
        getIssue: async (id: string) => {
          counts.issueReads += 1
          return id === ISSUE_A ? { id, ownerUserId: asUserId('u_task_owner') } : null
        },
        getIssues: async (ids: readonly string[]) => {
          counts.issueReads += 1
          return new Map(ids.map((id) => [id, { id, ownerUserId: asUserId('u_task_owner') }]))
        },
      },
    },
  } as never)
  return { authz, counts }
}

const emptyMemo = (): SessionOwnerMemo => ({})
const ids = [...SESSIONS.map((s) => s.sessionId), UNKNOWN]

describe('per-pass ownership memo [POD-1653, POD-6283]', () => {
  it('answers identically primed and unprimed — batching changed cost, not meaning', async () => {
    const slow = harness()
    // The ORACLE: no memo at all, every question asked one at a time.
    const unprimed = await Promise.all(ids.map(async (id) => await slow.authz.sessionOwner(id)))

    const fast = harness()
    const memo = emptyMemo()
    await fast.authz.primeOwnerMemo(memo, ids)
    const primed = await Promise.all(ids.map(async (id) => await fast.authz.sessionOwner(id, memo)))

    expect(primed).toEqual(unprimed)
    // Not vacuous: a session on a task is its own owner's, and an unknown id has none.
    expect(unprimed[0]).toEqual({ owner: 'u_one' })
    expect(unprimed[2]).toEqual({ owner: 'u_three' })
    expect(unprimed[ids.length - 1]).toBeUndefined()
    expect(slow.counts.issueReads + fast.counts.issueReads).toBe(0)
  })

  it('costs one batched read for a whole pass, not one per session', async () => {
    const { authz, counts } = harness()
    const memo = emptyMemo()
    await authz.primeOwnerMemo(memo, ids)
    for (const id of ids) await authz.sessionOwner(id, memo)

    // Crucially ZERO per-session statements: a miss in the memo is what would
    // fall through to those, and an unrecorded missing row is a miss.
    expect(counts.getSessions).toBe(1)
    expect(counts.loadSession).toBe(0)
  })

  it('does not grow its read count when the pass grows', async () => {
    const cost = async (repeats: number): Promise<Counts> => {
      const { authz, counts } = harness()
      const memo = emptyMemo()
      const pass = Array.from({ length: repeats }, () => ids).flat()
      await authz.primeOwnerMemo(memo, pass)
      for (const id of pass) await authz.sessionOwner(id, memo)
      return counts
    }
    // The property that matters: 10x the sessions is the SAME number of reads.
    expect(await cost(10)).toEqual(await cost(1))
  })
})
