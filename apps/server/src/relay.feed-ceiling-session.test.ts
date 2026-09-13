/**
 * THE FEED CEILING'S SESSION ARM, EXERCISED THROUGH THE RELAY'S OWN WIRING
 * (PDM-355).
 *
 * ── WHAT WAS UNWITNESSED, AND WHY IT STAYED THAT WAY ─────────────────────────
 *
 * `relay.ts`'s `policyFor` builds a `HumanCeiling` whose `canSee` answers the
 * SESSION arm from `liveSessionOwnership` — an inline helper that reads
 * `store.grants.listForResource('session', …)` DIRECTLY and never consults
 * `sessionOwner` or the authorization model at all. Until B2/PDM-251 it decided
 * with `owner?.grants.includes(userId) === true`, so a live grant edge on a
 * SESSION resource admitted a second person to the feed ceiling — a live
 * cross-user leak, and one that B1's "session grants are inactive history" never
 * reached BECAUSE IT NEVER ASKED.
 *
 * PDM-251 fixed it. Nothing witnessed the fix. The nearest test —
 * `authz-matrix.test.ts`'s D20 suite — stubs the ENTIRE ceiling
 * (`ceiling: { canSee: async () => canSee }`) to characterise the
 * consistent-error rule, which is the right fixture for THAT claim and covers
 * exactly nothing about who `canSee` admits. A stubbed ceiling cannot fail when
 * the real one is wrong.
 *
 * So this file builds a REAL `SessionRegistry`, writes a REAL grant edge on a
 * session resource, and asks the REAL gate. There is no ceiling fixture here;
 * `reg.messageGate` carries the object `policyFor` produced.
 *
 * ── HOW TO BREAK IT ON PURPOSE (do this before trusting it) ──────────────────
 *
 * In `relay.ts`'s `policyFor`, replace the session arm's `mayReadPrivate(...)`
 * with the expression that was the defect:
 *
 *     return owner.owner === userId || (owner.legacyGrants as readonly string[]).includes(userId)
 *
 * `the grantee is refused` must go RED and `the owner is admitted` must stay
 * GREEN. If both stay green the address is being refused by something else and
 * this file is measuring that instead — catalogue shape 14.
 */

import { asUserId, firstAdminMemberId, type SessionId, type UserId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { userCommandPrincipal } from './command-principal'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'

/**
 * Ask the REAL ceiling, through the REAL composed policy.
 *
 * `reg.mailPolicyFor` is the identical closure `MessageGate` was constructed
 * with — not a re-derivation — so what this asks is what a `sess:` address
 * resolution asks on the relay arm. Nothing here substitutes a `canSee`.
 */
const ceilingSees = async (
  reg: SessionRegistry,
  user: UserId,
  role: 'admin' | 'member',
  sessionId: SessionId,
): Promise<boolean> => {
  const policy = await reg.modules.mailPolicyFor(userCommandPrincipal(user, role))
  return await policy.ceiling.canSee({ kind: 'session', id: sessionId })
}

/** A second real member. Not the first admin, and not a stranger either: the
 *  whole point is that they hold a live `read` grant edge on the session. */
const GRANTEE = asUserId('mem_2GRANTEE000000000000000000')

let open: { reg: SessionRegistry; store: SessionStore } | undefined
afterEach(async () => {
  await open?.reg.dispose()
  await open?.store.close()
  open = undefined
})

async function world(): Promise<{
  reg: SessionRegistry
  store: SessionStore
  sessionId: SessionId
  owner: ReturnType<typeof firstAdminMemberId>
}> {
  // `:memory:` PER TEST. The default path is the shared state-dir database, so
  // three `world()` calls reused one store and the second `users.create` hit a
  // UNIQUE violation — and, worse, the grant edge from an earlier test would
  // have survived into a later one's "fixture".
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'feed-ceiling' })
  open = { reg, store }
  const owner = firstAdminMemberId()
  const { sessionId } = await reg.modules.sessions.createSession({
    ownerUserId: owner,
    agentKind: 'claude-code',
    cwd: '/w',
  })
  await store.users.create(
    {
      id: GRANTEE,
      displayName: 'The grantee',
      role: 'member',
      createdAt: '2026-09-13T00:00:00.000Z',
      disabledAt: null,
    },
    'scrypt:hash',
  )
  // THE EDGE IS REAL AND IT IS ON THE SESSION RESOURCE. `liveSessionOwnership`
  // filters to read/write/manage, so `read` is inside the set it collects — this
  // is the row that used to buy admission, not a near-miss that never would have.
  await store.grants.upsert({
    resourceKind: 'session',
    resourceId: sessionId,
    grantee: GRANTEE,
    verb: 'read',
    owner,
    visibility: 'owned-compute',
    createdAt: '2026-09-13T00:00:00.000Z',
    actorKind: 'user',
    actorId: owner,
    onBehalfOf: owner,
  } as never)
  return { reg, store, sessionId, owner }
}

describe("the relay feed ceiling's session arm", () => {
  it('collects the grant edge — the fixture is not vacuous', async () => {
    const { store, sessionId } = await world()
    // If this were empty the two tests below would pass with or without the
    // grant arm, and the deliberate break could not redden anything.
    expect(
      (await store.grants.listForResource('session', sessionId)).map((edge) => edge.grantee),
    ).toEqual([GRANTEE])
  })

  it('refuses a session GRANTEE — a grant edge is evidence, not admission', async () => {
    const { reg, sessionId } = await world()
    expect(await ceilingSees(reg, GRANTEE, 'member', sessionId)).toBe(false)
  })

  it('admits the OWNER — the refusal above is not "nobody sees anything"', async () => {
    const { reg, sessionId, owner } = await world()
    expect(await ceilingSees(reg, owner, 'admin', sessionId)).toBe(true)
  })
})
