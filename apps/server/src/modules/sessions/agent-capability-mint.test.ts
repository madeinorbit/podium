/**
 * NO AGENT CAPABILITY MINT CAN SAY `admin` — both of them (PDM-299).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHAT IT IS *NOT*
 * ---------------------------------------------------------------------------
 *
 * Before PDM-299, `operations`' `assertActionAuthorized` decided the admin floor
 * with `ctx.principal.capability.role !== 'admin'`. That refused every agent —
 * but not because a rule refused it. It refused because no mint can produce the
 * value the comparison needs, so the guard could have been deleted outright and
 * every "an agent is refused" assertion in the repository would have gone on
 * passing. False-green catalogue entry 14: the fixture decided, not the gate.
 *
 * **This file is therefore explicitly NOT the gate.** After PDM-299 the admin
 * floor is decided by `modules/role-floor.ts`'s `adminFloorRefusal`, which
 * refuses on the principal's KIND and never reads `capability.role` at all — so
 * a mint that started emitting `admin` tomorrow would not re-open anything. The
 * tests that carry that load are the ones which hand the rule an agent WEARING
 * an admin capability and watch it refused anyway:
 *   · `modules/role-floor.test.ts`   — "…even wearing an admin CAPABILITY"
 *   · `modules/operations/trpc.test.ts` — the whole PDM-299 describe block
 *   · `modules/settings/authz.test.ts`  — the discriminating case
 *
 * What this file pins is the OTHER half of the sentence: that the two mints do
 * in fact agree with each other, across every arm, so nobody reading one of them
 * concludes something false about the door as a whole. Stated plainly, because
 * catalogue entry 25's lesson is that a guard kept for defence in depth must say
 * so rather than let a green imply it is load-bearing.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE HALF IS DYNAMIC AND THE OTHER IS STRUCTURAL
 * ---------------------------------------------------------------------------
 *
 * There are TWO functions of this shape and the brief that opened PDM-299 named
 * only one of them, with two of its arms:
 *
 *   · `SessionAuthz.capabilityForSession` — exported, three returns, exercised
 *     below for real;
 *   · `relay.ts`'s `capabilityForLiveSession` — a CLOSURE inside
 *     `SessionRegistry`, not exported and not reachable from a test without
 *     booting a registry and driving the mail policy that consumes it.
 *
 * Four `return` statements between them, carrying SIX capability shapes — each
 * of the two functions returns early for an unknown session and then hands back
 * one of two objects from a ternary. (PDM-299's brief counted two shapes in one
 * function; the first draft of this file counted return keywords as though they
 * were shapes. The number that matters is six, because each shape is a separate
 * chance to mint the wrong role.) The closure is pinned by reading its source,
 * which is a weaker instrument and is guarded accordingly: the test
 * asserts it FOUND the function and found the expected number of role literals
 * before asserting anything about their values, so it cannot degrade into
 * catalogue entry 1 — a matcher that matches nothing and passes for that reason.
 */

import { readFileSync } from 'node:fs'
import { asIssueId, asSessionId, asUserId, type Capability, type SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionAuthz, type SessionAuthzPorts } from './session-authz'

const OWNER = asUserId('u_owner')
const ISSUE = asIssueId('iss_scoped')

/** A session whose `issueId` is set — the subtree arm. */
const ATTACHED = asSessionId('s_attached')
/** A session with no issue and a cwd that resolves to none — the scopeless arm. */
const LOOSE = asSessionId('s_loose')

function authzFor(sessions: Record<string, { issueId?: string; cwd: string }>): SessionAuthz {
  return new SessionAuthz({
    sessions: {
      get: (sessionId: SessionId) => {
        const row = sessions[sessionId as unknown as string]
        return row === undefined
          ? undefined
          : ({ sessionId, ownerUserId: OWNER, cwd: row.cwd, ...(row.issueId ? { issueId: row.issueId } : {}) } as never)
      },
    },
    deps: { issueAccess: { issueForCwd: async () => undefined } },
    sessionById: async () => undefined,
    machines: { ownershipRows: async () => [] },
    clientControl: {},
    store: { sessions: { getSession: async () => undefined }, users: {} },
  } as unknown as SessionAuthzPorts)
}

describe('SessionAuthz.capabilityForSession mints worker on every arm', () => {
  const authz = authzFor({
    [ATTACHED as unknown as string]: { issueId: ISSUE as unknown as string, cwd: '/wt/a' },
    [LOOSE as unknown as string]: { cwd: '/wt/b' },
  })

  it('the ISSUE-SCOPED arm: worker, subtree, and the owner carried as onBehalfOf', async () => {
    const capability: Capability = await authz.capabilityForSession(ATTACHED)
    expect(capability.role).toBe('worker')
    expect(capability.scope).toEqual({ kind: 'subtree', rootId: ISSUE })
    // The delegation half is present — which is exactly why "it is only a worker
    // capability" was never the reason an agent was refused. The human IS
    // resolvable from here; PDM-299 decided not to let that confer the grade.
    expect(capability.onBehalfOf).toBe(OWNER)
    expect(capability.actorSessionId).toBe(ATTACHED)
  })

  it('the SCOPELESS arm: worker, scope none, owner still carried', async () => {
    const capability: Capability = await authz.capabilityForSession(LOOSE)
    expect(capability.role).toBe('worker')
    expect(capability.scope).toEqual({ kind: 'none' })
    expect(capability.onBehalfOf).toBe(OWNER)
  })

  it('the UNKNOWN-SESSION arm: worker, most restricted, and NO delegation at all', async () => {
    // The arm the opening brief did not count. It differs from the other two in
    // a way that matters to a reader — it carries neither `actorSessionId` nor
    // `onBehalfOf` — so "both arms" was an undercount in substance, not only in
    // arithmetic.
    const capability: Capability = await authz.capabilityForSession(asSessionId('s_nope'))
    expect(capability.role).toBe('worker')
    expect(capability.scope).toEqual({ kind: 'none' })
    expect(capability.onBehalfOf).toBeUndefined()
    expect(capability.actorSessionId).toBeUndefined()
  })
})

describe("relay.ts's capabilityForLiveSession is the same mint", () => {
  /**
   * Extract the closure's body by brace matching from its declaration.
   *
   * A SOURCE READ IS A WEAK INSTRUMENT and the guards below are what keep it
   * honest: if the function is renamed, moved, or its shape changes, the
   * non-vacuity assertions fail LOUDLY rather than the value assertions passing
   * over an empty string.
   */
  const body = (() => {
    const source = readFileSync(new URL('../../relay.ts', import.meta.url), 'utf8')
    const marker = 'const capabilityForLiveSession = async ('
    const start = source.indexOf(marker)
    if (start === -1) return undefined
    const open = source.indexOf('{', source.indexOf('=>', start))
    let depth = 0
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) return source.slice(open, i + 1)
      }
    }
    return undefined
  })()

  it('the function is still there and still has its two returns — the non-vacuity guard', () => {
    // Entry 1: assert the matcher binds to something BEFORE asserting what it
    // says. Without this the two tests below pass over `undefined` forever.
    //
    // TWO `return` STATEMENTS, THREE CAPABILITY SHAPES, and the difference is
    // worth the sentence because both PDM-299's brief and this file's first
    // draft got it wrong in opposite directions. The early `if (!session)` is
    // one return; `return issueId ? … : …` is a second return carrying two
    // shapes. Counting keywords gives two, counting outcomes gives three, and
    // the value assertion below counts outcomes — which is the number that
    // matters, since each one is a separate chance to mint the wrong role.
    expect(body).toBeDefined()
    expect(body?.length ?? 0).toBeGreaterThan(200)
    expect(body?.match(/\breturn\b/g)?.length).toBe(2)
  })

  it('every role literal in it is worker, and there are three of them', () => {
    const roles = body?.match(/role:\s*'([a-z]+)'/g) ?? []
    expect(roles).toHaveLength(3)
    expect(new Set(roles.map((r) => r.replace(/.*'([a-z]+)'.*/, '$1')))).toEqual(new Set(['worker']))
  })

  it('and the word admin does not appear in it at all', () => {
    expect(body).not.toContain('admin')
  })
})
