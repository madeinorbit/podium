/**
 * OWNERSHIP IS RESOLVED FROM THE STORE, NOT FROM A PENDING PROMISE [POD-3507].
 *
 * Every assertion here names the OWNER (or the grantee list, or the machine
 * verdict) it expects. That is deliberate and it is the whole point of the
 * file: the defect this pins does not throw at three of its five sites, it
 * ANSWERS WRONGLY AND QUIETLY, so a test that asserts "no error was raised"
 * passes on the broken version. Two of the fixtures below would also pass if
 * they only checked for a defined result — they are written so the broken code
 * returns a DIFFERENT, plausible owner rather than nothing at all.
 *
 * THE FIXTURE IS BUILT TO DISCRIMINATE. `u_issue_owner` (the issue's owner, the
 * right answer) is never equal to `u_session_fallback` (the session row's own
 * ownerUserId, the answer an unawaited issue read falls back to). If those two
 * were the same value — the tempting, tidier fixture — every ownership
 * assertion here would pass with all four awaits removed.
 *
 * The doubles are ASYNC, matching the store. A synchronous double cannot
 * exercise an await at all: it makes the unawaited and the awaited code
 * indistinguishable, which is how this defect reached the integration branch
 * past the fixtures that already existed.
 */

import { asMachineId, asSessionId, asUserId, type SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { GrantRow } from '../../store/grants'
import { SessionAuthz } from './session-authz'
import type { SessionOwnerMemo } from './session-state/service'

const ISSUE = 'iss_x'
/** The RIGHT answer: the owner of the issue the session belongs to. */
const ISSUE_OWNER = 'u_issue_owner'
/** The WRONG-but-plausible answer an unawaited issue read falls back to. */
const SESSION_FALLBACK = 'u_session_fallback'
const GRANTEE = 'u_grantee'
const MACHINE = asMachineId('m1')

/** Not in the live map — every read must come from the durable row, which is
 *  the async path. A session that IS in memory never reaches it. */
const PARKED = asSessionId('s_parked')

const edge = (grantee: string, verb: string): GrantRow =>
  ({
    resourceKind: 'issue',
    resourceId: ISSUE,
    grantee,
    verb,
    owner: ISSUE_OWNER,
    visibility: 'private',
    createdAt: '2026-09-06T00:00:00.000Z',
    actorKind: 'user',
    actorId: ISSUE_OWNER,
    onBehalfOf: null,
  }) as GrantRow

const GRANTS: GrantRow[] = [edge(GRANTEE, 'read'), edge('u_not_a_reader', 'unknown-verb')]

interface Counts {
  getSession: number
  getIssue: number
  getIssues: number
  listForResource: number
  listForResources: number
}

function harness() {
  const counts: Counts = {
    getSession: 0,
    getIssue: 0,
    getIssues: 0,
    listForResource: 0,
    listForResources: 0,
  }
  const authz = new SessionAuthz({
    clientControl: {},
    deps: {},
    listSessions: () => [],
    sessionById: async () => undefined,
    machines: { ownershipRows: () => [{ id: MACHINE, ownerUserId: asUserId(ISSUE_OWNER) }] },
    sessions: { get: () => undefined },
    store: {
      users: { get: async () => undefined, roleOf: async () => undefined },
      sessions: {
        getSession: async (sessionId: SessionId) => {
          counts.getSession += 1
          return sessionId === PARKED
            ? {
                sessionId: PARKED,
                issueId: ISSUE,
                ownerUserId: asUserId(SESSION_FALLBACK),
                machineId: MACHINE,
              }
            : undefined
        },
      },
      issues: {
        getIssue: async (id: string) => {
          counts.getIssue += 1
          return id === ISSUE ? { id, ownerUserId: asUserId(ISSUE_OWNER) } : null
        },
        getIssues: async (ids: readonly string[]) => {
          counts.getIssues += 1
          const out = new Map<string, unknown>()
          for (const id of ids) {
            if (id === ISSUE) out.set(id, { id, ownerUserId: asUserId(ISSUE_OWNER) })
          }
          return out
        },
      },
      grants: {
        listForResource: async (kind: string, id: string) => {
          counts.listForResource += 1
          return kind === 'issue' && id === ISSUE ? GRANTS : []
        },
        listForResources: async (kind: string, ids: readonly string[]) => {
          counts.listForResources += 1
          const out = new Map<string, GrantRow[]>()
          for (const id of ids) {
            if (kind === 'issue' && id === ISSUE) out.set(id, GRANTS)
          }
          return out
        },
      },
    },
  } as never)
  return { authz, counts }
}

const emptyMemo = (): SessionOwnerMemo => ({ issues: new Map(), grants: new Map() })

describe('session ownership resolves through the store reads [POD-3507]', () => {
  it('names the ISSUE owner, not the session row fallback (no memo)', async () => {
    const { authz, counts } = harness()

    const owner = await authz.sessionOwner(PARKED)

    // The whole defect in one assertion. Unawaited, `getIssue(...)` is a promise
    // whose `?.ownerUserId` is undefined, so `?? durable.ownerUserId` answers
    // SESSION_FALLBACK — a real user id, silently the wrong one.
    expect(owner?.owner).toBe(ISSUE_OWNER)
    expect(owner?.owner).not.toBe(SESSION_FALLBACK)
    // And the grants half, which crashes rather than lying when unawaited
    // (`edges.filter is not a function`). The non-read verb must not confer.
    expect(owner?.grants).toEqual([GRANTEE])
    // The durable row was actually read — the session is not in the live map,
    // so a fixture that accidentally served it from memory would prove nothing.
    expect(counts.getSession).toBe(1)
    expect(counts.getIssue).toBe(1)
    expect(counts.listForResource).toBe(1)
  })

  it('names the ISSUE owner through an UNPRIMED memo', async () => {
    const { authz, counts } = harness()

    // The memo branch of `memoIssueOwner` is a separate site from the branch
    // above: it STORES the read and reads it back out, so an unawaited store
    // puts a promise in the map and the read-back finds no `ownerUserId`.
    const owner = await authz.sessionOwner(PARKED, emptyMemo())

    expect(owner?.owner).toBe(ISSUE_OWNER)
    expect(owner?.owner).not.toBe(SESSION_FALLBACK)
    expect(owner?.grants).toEqual([GRANTEE])
    expect(counts.getIssue).toBe(1)
  })

  it('names the ISSUE owner through a PRIMED memo, and asks the batched reads once', async () => {
    const { authz, counts } = harness()
    const memo = emptyMemo()

    await authz.primeOwnerMemo(memo, [PARKED])
    const owner = await authz.sessionOwner(PARKED, memo)

    expect(owner?.owner).toBe(ISSUE_OWNER)
    expect(owner?.owner).not.toBe(SESSION_FALLBACK)
    expect(owner?.grants).toEqual([GRANTEE])
    // Primed means the per-resource reads are never reached — if they were, the
    // assertions above could pass while `primeOwnerMemo` itself was broken.
    expect(counts.getIssues).toBe(1)
    expect(counts.listForResources).toBe(1)
    expect(counts.getIssue).toBe(0)
    expect(counts.listForResource).toBe(0)
  })

  it('primes the memo with ROWS, not with pending promises', async () => {
    const { authz } = harness()
    const memo = emptyMemo()

    await authz.primeOwnerMemo(memo, [PARKED])

    // Stated against the memo's own contents, because `primeOwnerMemo` returns
    // nothing: its whole observable effect is what it wrote here. An unawaited
    // batch throws `found.get is not a function`, and an unawaited single read
    // would leave a thenable sitting in the map.
    expect(memo.issues.get(ISSUE)).toEqual({ id: ISSUE, ownerUserId: ISSUE_OWNER })
    expect(memo.issues.get(ISSUE)).not.toBeInstanceOf(Promise)
    expect(memo.grants.get(`issue:${ISSUE}`)).toEqual([GRANTEE])
  })

  it('reads the durable row for a machine-use decision on a session not in memory', async () => {
    const { authz } = harness()

    // Unawaited, `session.machineId` is undefined on the promise, so the
    // decision is taken against a machine that does not exist. The verdict this
    // pins is 'granted' — the principal owns MACHINE — which is exactly the
    // answer the broken version cannot reach.
    const verdict = await authz.machineUseForClient(
      { user: ISSUE_OWNER, role: 'admin' } as never,
      PARKED,
    )

    expect(verdict).toBe('granted')
  })

  it('answers absent — not granted — for a session with no durable row', async () => {
    const { authz } = harness()

    // The other side of the same read: a miss must stay a miss. An unawaited
    // read makes EVERY session look present, because a promise is truthy, so
    // this is the assertion that catches a "fix" that awaits nothing and simply
    // never reaches the `!session` branch.
    const verdict = await authz.machineUseForClient(
      { user: ISSUE_OWNER, role: 'admin' } as never,
      asSessionId('s_unknown'),
    )

    expect(verdict).toBe('absent')
  })
})
