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
 * THE FIXTURE IS BUILT TO DISCRIMINATE, and B1 (PDM-133) reversed WHICH of its
 * two users is right without touching that property. `u_issue_owner` (the
 * attached issue's owner) is never equal to `u_session_fallback` (the session
 * row's own ownerUserId). If those two were the same value — the tempting,
 * tidier fixture — every ownership assertion here would pass against either
 * precedence, and the change this file now pins would be invisible.
 *
 * WHAT B1 REMOVED FROM THIS FILE'S REACH. `sessionOwner` no longer reads the
 * issue row or the grant edges at all, so the unawaited-issue-read defect is no
 * longer reachable through it — that lookup is gone rather than fixed. The
 * POD-3507 property still under test here is the one remaining async read,
 * `getSession`, plus `primeOwnerMemo` and the machine-use decision below, which
 * are unchanged. Said plainly because a file that keeps its name after its
 * subject narrows is how a test quietly stops covering what its header claims.
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
/**
 * THE TWO ANSWERS SWAPPED ROLES IN B1 (PDM-133).
 *
 * `ISSUE_OWNER` was "the RIGHT answer" and `SESSION_FALLBACK` was "the WRONG-
 * but-plausible answer an unawaited issue read falls back to". Session authority
 * is now the durable row, so the session's own owner is right and the attached
 * issue's owner must not appear at all. The NAMES are kept exactly as they were,
 * deliberately: renaming them would hide from the next reader that this file
 * once asserted the reverse, and the git blame is the cheapest explanation of
 * why the precedence changed.
 *
 * What did NOT change is the property that makes the fixture worth anything:
 * the two values are never equal, so no assertion here can pass by the two
 * identities coinciding.
 */
/** Owner of the attached issue. Since B1 it must NEVER be the answer. */
const ISSUE_OWNER = 'u_issue_owner'
/** The session row's own `ownerUserId` — the initiating human, and the answer. */
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
  it('names the SESSION row owner, and never the attached issue owner (no memo)', async () => {
    const { authz, counts } = harness()

    const owner = await authz.sessionOwner(PARKED)

    // The B1 boundary in one assertion: this session is attached to an issue
    // owned by somebody else, and the answer is the human on the row.
    expect(owner?.owner).toBe(SESSION_FALLBACK)
    expect(owner?.owner).not.toBe(ISSUE_OWNER)
    // The durable row was actually read — the session is not in the live map,
    // so a fixture that accidentally served it from memory would prove nothing.
    // This is also what still discriminates an UNAWAITED read: `getSession` is
    // the one async lookup left, and unawaited it yields a promise whose
    // `ownerUserId` is undefined, which now returns `undefined` rather than a
    // plausible wrong human.
    expect(counts.getSession).toBe(1)
    // AND THE ISSUE WAS NEVER CONSULTED. Asserting the owner alone would pass on
    // an implementation that still read the issue and merely preferred the row —
    // leaving the read on the authorization path for the next edit to re-prefer.
    // These two are the structural claim: the lookup is gone.
    expect(counts.getIssue).toBe(0)
    expect(counts.listForResource).toBe(0)
  })

  it('is unaffected by the memo, primed or unprimed', async () => {
    const { authz, counts } = harness()
    const memo = emptyMemo()

    // Three routes that used to reach three DIFFERENT lookup sites — no memo,
    // an unprimed memo (`memoIssueOwner`'s store-and-read-back branch) and a
    // primed one. They now have one answer because they share one code path.
    const noMemo = await authz.sessionOwner(PARKED)
    const unprimed = await authz.sessionOwner(PARKED, emptyMemo())
    await authz.primeOwnerMemo(memo, [PARKED])
    const primed = await authz.sessionOwner(PARKED, memo)

    expect(noMemo).toEqual({ owner: SESSION_FALLBACK, grants: [] })
    expect(unprimed).toEqual(noMemo)
    expect(primed).toEqual(noMemo)
    // NON-VACUITY for the primed leg: `primeOwnerMemo` really did run its
    // batched reads above, so `primed` is not simply the unprimed path again.
    expect(counts.getIssues).toBe(1)
    expect(counts.listForResources).toBe(1)
    // The per-resource reads stay at zero across all three.
    expect(counts.getIssue).toBe(0)
    expect(counts.listForResource).toBe(0)
  })

  it('treats grants as inactive history — a live read grant confers nothing', async () => {
    const { authz, counts } = harness()
    const memo = emptyMemo()

    // NON-VACUITY FIRST, and this is the whole point of the test. Prime the memo
    // from the SAME store: it comes back holding a real `read` edge for GRANTEE.
    // So the edge exists, the store serves it, and the reader can reach it.
    await authz.primeOwnerMemo(memo, [PARKED])
    expect(memo.grants.get(`issue:${ISSUE}`)).toEqual([GRANTEE])

    const owner = await authz.sessionOwner(PARKED, memo)

    // ...and ownership still reports none. Empty because B1 stopped CONSULTING
    // grants, not because there was nothing to find — which is the difference
    // between "inactive history" and "no data", and the reason the assertion
    // above has to be here. Without it this is catalogue #13: a comparison that
    // passes trivially when both sides are empty.
    expect(owner?.grants).toEqual([])
    expect(owner?.owner).toBe(SESSION_FALLBACK)
    // The grantee did not become the owner by another route either.
    expect(owner?.owner).not.toBe(GRANTEE)
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
