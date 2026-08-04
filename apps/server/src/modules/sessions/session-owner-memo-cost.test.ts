/**
 * The per-pass ownership memo: what it COSTS, and that batching it did not
 * change what it ANSWERS [POD-1653].
 *
 * Two separate failures are pinned here, because they fail independently.
 *
 * 1. THE MEMO WAS NOT REACHING THIS CODE AT ALL. `SessionStateService` was
 *    wired with `sessionOwner: (sessionId) => bag.sessionOwner(sessionId)` —
 *    one argument. The memo was built by `project()`, threaded through
 *    `canReadSession`, and silently dropped at that arity mismatch, so every
 *    session in a full projection re-read its issue row and its grant edges.
 *    Nothing failed; it was only slow, which is why it survived. The cost
 *    assertions below are the only thing that can see it.
 *
 * 2. BATCHING MUST NOT CHANGE THE ANSWER. `primeOwnerMemo` computes the same
 *    values `sessionOwner` would have computed one at a time. The equivalence
 *    test grades the primed path against the unprimed one as an oracle, over a
 *    fixture that deliberately mixes the cases that could diverge: sessions
 *    with an issue and without, an issue that does not exist, a resource with
 *    grants and resources with none, and a verb that must NOT confer read.
 */

import { asSessionId, asUserId, type SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { GrantRow } from '../../store/grants'
import { SessionAuthz } from './session-authz'

interface Counts {
  getIssue: number
  getIssues: number
  listForResource: number
  listForResources: number
}

const ISSUE_A = 'iss_a'
const ISSUE_MISSING = 'iss_gone'

/** Sessions: two on one issue, one on a missing issue, two with no issue. */
const SESSIONS: { sessionId: SessionId; issueId?: string; ownerUserId: string }[] = [
  { sessionId: asSessionId('s1'), issueId: ISSUE_A, ownerUserId: 'u_fallback' },
  { sessionId: asSessionId('s2'), issueId: ISSUE_A, ownerUserId: 'u_fallback' },
  { sessionId: asSessionId('s3'), issueId: ISSUE_MISSING, ownerUserId: 'u_fallback' },
  { sessionId: asSessionId('s4'), ownerUserId: 'u_four' },
  { sessionId: asSessionId('s5'), ownerUserId: 'u_five' },
]

const edge = (resourceKind: string, resourceId: string, grantee: string, verb: string): GrantRow =>
  ({
    resourceKind,
    resourceId,
    grantee,
    verb,
    owner: 'u_owner',
    visibility: 'private',
    createdAt: '2026-08-04T00:00:00.000Z',
    actorKind: 'user',
    actorId: 'u_owner',
    onBehalfOf: null,
  }) as GrantRow

/** Only `issue:iss_a` and `session:s4` carry edges; s4's is a NON-read verb. */
const GRANTS: GrantRow[] = [
  edge('issue', ISSUE_A, 'u_shared', 'write'),
  edge('issue', ISSUE_A, 'u_shared', 'read'),
  edge('session', 's4', 'u_nope', 'admin-only-unknown-verb'),
]

function harness() {
  const counts: Counts = { getIssue: 0, getIssues: 0, listForResource: 0, listForResources: 0 }
  const matching = (kind: string, id: string): GrantRow[] =>
    GRANTS.filter((g) => g.resourceKind === kind && g.resourceId === id)

  const authz = new SessionAuthz({
    sessions: { get: () => undefined },
    store: {
      sessions: {
        getSession: (sessionId: SessionId) => {
          const found = SESSIONS.find((s) => s.sessionId === sessionId)
          return found ? { ...found, ownerUserId: asUserId(found.ownerUserId) } : undefined
        },
      },
      issues: {
        getIssue: (id: string) => {
          counts.getIssue += 1
          return id === ISSUE_A ? { id, ownerUserId: asUserId('u_issue_owner') } : null
        },
        getIssues: (ids: readonly string[]) => {
          counts.getIssues += 1
          const out = new Map<string, unknown>()
          for (const id of ids) {
            if (id === ISSUE_A) out.set(id, { id, ownerUserId: asUserId('u_issue_owner') })
          }
          return out
        },
      },
      grants: {
        listForResource: (kind: string, id: string) => {
          counts.listForResource += 1
          return matching(kind, id)
        },
        listForResources: (kind: string, ids: readonly string[]) => {
          counts.listForResources += 1
          const out = new Map<string, GrantRow[]>()
          for (const id of ids) {
            const hit = matching(kind, id)
            if (hit.length > 0) out.set(id, hit)
          }
          return out
        },
      },
    },
  } as never)

  return { authz, counts }
}

const emptyMemo = () => ({
  issues: new Map<string, unknown>(),
  grants: new Map<string, string[]>(),
})
const ids = SESSIONS.map((s) => s.sessionId)

describe('per-pass ownership memo [POD-1653]', () => {
  it('answers identically primed and unprimed — batching changed cost, not meaning', () => {
    const slow = harness()
    // The ORACLE: no memo at all, every question asked one at a time. This is
    // the behaviour every single-session caller still gets.
    const unprimed = ids.map((id) => slow.authz.sessionOwner(id))

    const fast = harness()
    const memo = emptyMemo()
    fast.authz.primeOwnerMemo(memo, ids)
    const primed = ids.map((id) => fast.authz.sessionOwner(id, memo))

    expect(primed).toEqual(unprimed)
    // The fixture must actually exercise the interesting cases, or the equality
    // above is vacuous: a real owner-from-issue, a fallback owner, a real
    // grantee, and a non-read verb that confers nothing.
    expect(unprimed[0]).toEqual({ owner: 'u_issue_owner', grants: ['u_shared'] })
    expect(unprimed[2]).toEqual({ owner: 'u_fallback', grants: [] })
    expect(unprimed[3]).toEqual({ owner: 'u_four', grants: [] })
  })

  it('costs one batched read per kind for a whole pass, not one per session', () => {
    const { authz, counts } = harness()
    const memo = emptyMemo()
    authz.primeOwnerMemo(memo, ids)
    for (const id of ids) authz.sessionOwner(id, memo)

    // One issue batch, one grants batch per resource kind present (issue +
    // session). Crucially ZERO per-resource statements: a miss in the memo is
    // what used to fall through to those, and an unrecorded empty result is a
    // miss.
    expect(counts.getIssues).toBe(1)
    expect(counts.getIssue).toBe(0)
    expect(counts.listForResources).toBe(2)
    expect(counts.listForResource).toBe(0)
  })

  it('does not grow its read count when the pass grows', () => {
    const cost = (repeats: number): Counts => {
      const { authz, counts } = harness()
      const memo = emptyMemo()
      const pass = Array.from({ length: repeats }, () => ids).flat()
      authz.primeOwnerMemo(memo, pass)
      for (const id of pass) authz.sessionOwner(id, memo)
      return counts
    }
    // The property that matters: 10x the sessions is the SAME number of reads.
    expect(cost(10)).toEqual(cost(1))
  })
})
