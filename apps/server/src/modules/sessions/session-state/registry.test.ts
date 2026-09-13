import { soleHumanSessionStatePrincipal } from '../../../test-support/session-state-principal'
/**
 * MULTI-USER PROPERTIES of the session-state command envelope (POD-380).
 *
 * These are the assertions POD-379's oracle structurally CANNOT make. The oracle
 * drives the tRPC surface, and that surface has exactly one principal today (one
 * shared password ⇒ `OPERATOR`, and `client_sessions` has no user column — §3.2).
 * So the oracle can prove behaviour is preserved; it cannot prove two people do
 * not see each other's state, because it cannot produce a second person.
 *
 * This file tests the ENFORCEMENT POINT directly — `SessionStateRegistry.execute` —
 * where a principal is an argument. That is not a workaround for a missing
 * feature: `SessionStateRegistry` is where the policy is decided at runtime, so it is
 * the thing that actually has to hold when POD-1075 mints real users.
 *
 * WHAT WOULD MAKE THESE VACUOUS, and how each is guarded: a test that only ever
 * shows refusals passes against an envelope wired shut. Every denial assertion
 * here is paired with the corresponding ALLOW using the same fixture, so the
 * envelope has to discriminate rather than merely refuse.
 */

import {
  asSessionId,
  asUserId,
  firstAdminMemberId,
  type SessionId,
  type UserId,
} from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../../relay'
import { OPERATOR } from '../../../test-support/capabilities'
import { openTestStore } from '../../../test-support/open-test-store'
import {
  type SessionStatePrincipal,
  SessionStateRegistry,
} from './registry'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const reg of registries.splice(0)) await reg.dispose()
})

const ALICE = asUserId('user:alice')
const BOB = asUserId('user:bob')

async function fixture() {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
  const sessionState = new SessionStateRegistry({
    sessions: reg.modules.sessions,
    state: reg.modules.sessions.state,

    mutations: reg.modules.mutations,
  })
  /**
   * A principal for an arbitrary user. `capability.scope` is `owned`/`self` for
   * that user — NOT `OPERATOR`.
   *
   * THE REASON HAS CHANGED AND THE RULE HAS NOT (A5.6/PDM-250). This used to read
   * "`scope: 'all'` short-circuits authorize() before the target is read, so an
   * isolation test built on it would pass no matter what the policy said". That
   * short circuit is gone for personal targets — A3 and A5.1 made the `all` arm
   * decide an owned entity or a per-user row by ownership, and A5.2 gave `none`
   * and `subtree` the same rule — so an OPERATOR-based fixture no longer passes
   * vacuously; it is simply REFUSED, which is a different and equally useless
   * instrument. Either way the capability under test must be the one the policy
   * is about, and for a per-user row that is a `self` scope naming its user.
   */
  const asUser = (userId: string, scope: 'owned' | 'self'): SessionStatePrincipal => ({
    userId: asUserId(userId),
    capability: { role: 'worker', scope: { kind: scope, userId: asUserId(userId) } },
    onBehalfOf: asUserId(userId),
    humanDirect: true,
  })
  /**
   * THE SECOND PERSON, MINTED THE WAY THE CONTRACT NOW ALLOWS ONE (A5.6/PDM-250).
   *
   * This used to be `asVisibleUser`: `{ userId: alice, capability: OPERATOR }` — a
   * second IDENTITY wearing the unconstrained ADMIN capability, because `scope:
   * 'all'` was the only way to make a session visible to somebody who did not own
   * it. Every isolation assertion below was then decided by the short circuit
   * rather than by the policy, which is precisely what the paragraph above this
   * function and the file header both warn against. The fixture contradicted its
   * own warning, and A3/A5.1/A5.2 removed the short circuit it depended on: a
   * personal target is now decided by ownership against `cap.onBehalfOf` under
   * EVERY scope, so an admin capability no longer reaches another person's row.
   *
   * A `self` principal is the strictly stronger instrument, and the one POD-1075
   * mints for a person writing their own state: it CANNOT pass against a policy
   * with no ownership check, which is exactly what the OPERATOR version did.
   */
  const asSelf = (userId: string): SessionStatePrincipal => asUser(userId, 'self')
  const session = async () => await reg.modules.sessions.createSession({ ownerUserId: firstAdminMemberId(), agentKind: 'shell', cwd: '/p' })
  /**
   * A SESSION THIS PERSON OWNS — and since B1 (PDM-133) that is the only way a
   * session is readable by anybody.
   *
   * WHAT THIS REPLACED, AND WHY. Until B1 the fixture here was `sharedSession`:
   * it minted one session and attached a durable `read` GRANT EDGE for ALICE and
   * another for BOB, on the reasoning (A5.6/PDM-250) that a grant edge was "the
   * way the product admits" a second person to a session, and that two people who
   * can both legitimately SEE one session are the interesting case for per-user
   * isolation. That reasoning was right about the isolation being the interesting
   * case and has been overtaken on the mechanism: B1 requirement 4 makes
   * compatibility session grants INACTIVE HISTORY, so `sessionOwner` no longer
   * reads them and `canReadSession` refuses both principals. The old fixture
   * cannot be built any more — by design, not by accident.
   *
   * The isolation property is preserved below rather than dropped. Where a test
   * needs two per-user rows on ONE entity id — which is the only shape that
   * catches a delete keyed too loosely — the second row is seeded through the
   * STORE, which is where the (userId, entityId) key actually lives, and the
   * SERVICE call under test is still made by the person who owns the session.
   * That models exactly what the product now has: rows written before ownership
   * tightened, and one human entitled to act.
   */
  const ownedSession = async (userId: UserId) =>
    await reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/p', ownerUserId: userId })
  return { store, reg, sessionState, asUser, asSelf, session, ownedSession }
}

// ---------------------------------------------------------------------------
// AC: two principals do not observe each other's per-user values
// ---------------------------------------------------------------------------

describe('per-user state is isolated between principals', () => {
  it('two principals hold rows on the SAME session and each reads only its own', async () => {
    const { store, sessionState, asSelf, ownedSession } = await fixture()
    const { sessionId } = await ownedSession(ALICE)
    const until = new Date(Date.now() + 60_000).toISOString()
    const other = new Date(Date.now() + 120_000).toISOString()

    // ALICE owns the session, so her write goes through the service.
    expect(
      (await sessionState.execute('snoozes.set', { sessionId, until }, asSelf(ALICE))).outcome,
    ).toBe('applied')

    // BOB IS REFUSED THE SAME CALL — the B1 (PDM-133) property, and the reason
    // his row has to be seeded below rather than written here. Before B1 a grant
    // edge let him through; grants are inactive history now.
    expect(
      (await sessionState.execute('snoozes.set', { sessionId, until: other }, asSelf(BOB))).outcome,
    ).toBe('denied')

    // The pre-existing row, at the level the (userId, entityId) key lives.
    await store.sessions.setSnooze(BOB, sessionId, other)

    // Same entity, two rows, two values. Neither read sees the other's — which
    // is the whole point of the key, and is independent of who may write.
    expect(await store.sessions.listSnoozes(ALICE)).toEqual({ [sessionId]: until })
    expect(await store.sessions.listSnoozes(BOB)).toEqual({ [sessionId]: other })
  })

  it("one principal's CLEAR does not un-snooze the other", async () => {
    // The sharper case, and the reason a same-entity fixture is worth keeping at
    // all: a delete keyed by sessionId ALONE would take both rows out, and the
    // set-only test above would not notice. Two rows on ONE entity id is the
    // only shape that catches it.
    const { store, sessionState, asSelf, ownedSession } = await fixture()
    const { sessionId } = await ownedSession(ALICE)
    await sessionState.execute('snoozes.set', { sessionId, until: null }, asSelf(ALICE))
    // BOB's row is seeded, because since B1 he cannot write one through the
    // service on a session ALICE owns. The DELETE under test is still the real
    // service-level clear, made by the person entitled to make it.
    await store.sessions.setSnooze(BOB, sessionId, null)
    expect(await store.sessions.listSnoozes(BOB)).toEqual({ [sessionId]: null })

    await sessionState.execute('snoozes.clear', { sessionId }, asSelf(ALICE))

    expect(await store.sessions.listSnoozes(ALICE)).toEqual({})
    expect(await store.sessions.listSnoozes(BOB)).toEqual({ [sessionId]: null })
  })

  it('pins are per-principal, and an unpin only unpins the caller', async () => {
    const { store, sessionState, asSelf } = await fixture()
    const pin = { kind: 'panel', id: 'sess-1', pinned: true }
    await sessionState.execute('pins.set', pin, asSelf(ALICE))
    await sessionState.execute('pins.set', pin, asSelf(BOB))

    await sessionState.execute('pins.set', { ...pin, pinned: false }, asSelf(ALICE))

    expect((await store.sessions.listPins(ALICE)).panels).toEqual([])
    expect((await store.sessions.listPins(BOB)).panels).toEqual(['sess-1'])
  })

  it('tab order is per-principal for the SAME worktree', async () => {
    // The worktree KEY is what is shared here, and it is the key the row is
    // stored under — so this still pins "two rows, one worktree, no bleed".
    // Each principal orders sessions they own, because `tabs.setOrder` resolves
    // every id in the list through `canReadSession` and since B1 that is
    // ownership.
    const { store, sessionState, asSelf, ownedSession } = await fixture()
    const a1 = (await ownedSession(ALICE)).sessionId
    const a2 = (await ownedSession(ALICE)).sessionId
    const b1 = (await ownedSession(BOB)).sessionId
    const b2 = (await ownedSession(BOB)).sessionId

    const order = (sessionIds: SessionId[]) => ({ worktree: '/w', sessionIds })
    await sessionState.execute('tabs.setOrder', order([a1, a2]), asSelf(ALICE))
    await sessionState.execute('tabs.setOrder', order([b2, b1]), asSelf(BOB))

    expect(await store.sessions.listTabOrders(ALICE)).toEqual({ '/w': [a1, a2] })
    expect(await store.sessions.listTabOrders(BOB)).toEqual({ '/w': [b2, b1] })

    // AND THE GATE IS LIVE: ordering a list containing somebody else's session
    // is refused outright, rather than silently dropping the id.
    expect(
      (await sessionState.execute('tabs.setOrder', order([a1, b1]), asSelf(ALICE))).outcome,
    ).toBe('denied')
    expect(await store.sessions.listTabOrders(ALICE)).toEqual({ '/w': [a1, a2] })
  })

  it('the empty-list DELETE stays scoped too — it removes the caller’s row only', async () => {
    const { store, sessionState, asSelf, ownedSession } = await fixture()
    const a = (await ownedSession(ALICE)).sessionId
    const b = (await ownedSession(BOB)).sessionId
    await sessionState.execute('tabs.setOrder', { worktree: '/w', sessionIds: [a] }, asSelf(ALICE))
    await sessionState.execute('tabs.setOrder', { worktree: '/w', sessionIds: [b] }, asSelf(BOB))

    await sessionState.execute('tabs.setOrder', { worktree: '/w', sessionIds: [] }, asSelf(ALICE))

    // Same worktree key, one row removed, the other untouched.
    expect(await store.sessions.listTabOrders(ALICE)).toEqual({})
    expect(await store.sessions.listTabOrders(BOB)).toEqual({ '/w': [b] })
  })
})

// ---------------------------------------------------------------------------
// AC: a principal cannot write another principal's per-user row
// ---------------------------------------------------------------------------

describe('per-user writes are SELF-SCOPED', () => {
  it('a userId in the PAYLOAD is inert — it cannot redirect the write (ADR 3 D7)', async () => {
    const { store, sessionState, asSelf, ownedSession } = await fixture()
    const { sessionId } = await ownedSession(ALICE)

    // The strongest form of the self-scoping property: the attack does not fail,
    // it is not expressible. The row lands on ALICE regardless of the payload.
    const result = await sessionState.execute(
      'snoozes.set',
      { sessionId, until: null, userId: BOB, onBehalfOf: BOB },
      asSelf(ALICE),
    )

    expect(result.outcome).toBe('applied')
    expect(await store.sessions.listSnoozes(ALICE)).toEqual({ [sessionId]: null })
    expect(await store.sessions.listSnoozes(BOB)).toEqual({})
  })

  it('a principal whose capability names ANOTHER user is denied, and the same call as itself is allowed', async () => {
    const { store, sessionState, asSelf, ownedSession } = await fixture()
    const { sessionId } = await ownedSession(ALICE)
    // A forged/stale principal: identity says alice, capability is scoped to bob.
    // authorize() compares the target row's user against the CAPABILITY's user, so
    // the mismatch is caught rather than trusted.
    const mismatched: SessionStatePrincipal = {
      userId: ALICE,
      capability: { role: 'worker', scope: { kind: 'self', userId: asUserId(BOB) } },
      onBehalfOf: ALICE,
      humanDirect: true,
    }

    expect(
      (await sessionState.execute('snoozes.set', { sessionId, until: null }, mismatched)).outcome,
    ).toBe('denied')
    expect(await store.sessions.listSnoozes(ALICE)).toEqual({})
    expect(await store.sessions.listSnoozes(BOB)).toEqual({})

    // THE COUNTERFACTUAL: the identical call with a coherent principal applies. So
    // the denial above is the scope check talking, not a broken fixture.
    //
    // It used to be spelled `{ ...mismatched, capability: OPERATOR }`, and that
    // stopped being a counterfactual when A3/A5.1 closed the `all` arm over
    // personal targets: an admin capability whose `onBehalfOf` is the first admin
    // is now REFUSED alice's row, so the arm meant to prove the instrument can say
    // YES said no, for a reason that had nothing to do with the scope check above.
    // The coherent principal is the same identity with a capability that agrees
    // with it, which is the only difference this test means to isolate.
    const coherent = asSelf(ALICE)
    const write = { sessionId, until: null }
    expect((await sessionState.execute('snoozes.set', write, coherent)).outcome).toBe('applied')
    expect(await store.sessions.listSnoozes(ALICE)).toEqual({ [sessionId]: null })
  })

  it('an owner-or-grant capability cannot make a per-user write at all', async () => {
    // §3.3 / ADR 9 D3 rule 4: per-user state is non-grantable. Being the session's
    // OWNER does not let you set somebody's read state on it — or your own through
    // an ownership capability.
    const { store, sessionState, asUser, session } = await fixture()
    const { sessionId } = await session()

    expect(
      (await sessionState.execute(
        'snoozes.set',
        { sessionId, until: null },
        asUser(ALICE, 'owned'),
      )).outcome,
    ).toBe('denied')
    expect(await store.sessions.listSnoozes(ALICE)).toEqual({})
  })
  it('an invisible session read is identical to a nonexistent-session read', async () => {
    const { reg, asUser, session } = await fixture()
    const { sessionId } = await session()
    const stranger = asUser(BOB, 'self')
    const missing = asSessionId('00000000-0000-4000-8000-000000000000')

    expect(await reg.modules.sessions.state.readOverlay(stranger, sessionId)).toEqual(
      await reg.modules.sessions.state.readOverlay(stranger, missing),
    )
    expect(await reg.modules.sessions.state.readOverlay(stranger, sessionId)).toEqual({ kind: 'absent' })
  })
})

// ---------------------------------------------------------------------------
// AC: owner-or-grant on the shared session writes; denial == not-found
// ---------------------------------------------------------------------------

describe('owner-or-grant policy on the shared session writes', () => {
  const SHARED = [
    'sessions.rename',
    'sessions.setArchived',
    'sessions.setWorkState',
    'sessions.setIssueId',
    'sessions.dismissOffer',
  ]

  const inputFor = (name: string, sessionId: SessionId) => {
    switch (name) {
      case 'sessions.rename':
        return { sessionId, name: 'renamed' }
      case 'sessions.setArchived':
        return { sessionId, archived: true }
      case 'sessions.setWorkState':
        return { sessionId, workState: 'testing' as const }
      case 'sessions.dismissOffer':
        return { sessionId, offerCreatedAt: '2026-01-01T00:00:00.000Z' }
      default:
        return { sessionId, issueId: null }
    }
  }

  it.each(SHARED)('%s: the OWNER is allowed', async (name) => {
    const { sessionState, session } = await fixture()
    const { sessionId } = await session()
    // Sessions are owned by firstAdminMemberId() until POD-1075 (SessionLifecycle.sessionOwner).
    const owner: SessionStatePrincipal = {
      userId: firstAdminMemberId(),
      capability: { role: 'worker', scope: { kind: 'owned', userId: firstAdminMemberId() } },
      onBehalfOf: firstAdminMemberId(),
      humanDirect: true,
    }

    expect((await sessionState.execute(name, inputFor(name, sessionId), owner)).outcome).toBe('applied')
  })

  it.each(SHARED)('%s: a principal without owner or grant is DENIED', async (name) => {
    const { sessionState, asUser, session } = await fixture()
    const { sessionId } = await session()

    expect(
      (await sessionState.execute(name, inputFor(name, sessionId), asUser(BOB, 'owned'))).outcome,
    ).toBe('denied')
  })

  it('the denial is INDISTINGUISHABLE from not-found (§3.1.5)', async () => {
    const { sessionState, asUser, session } = await fixture()
    const { sessionId } = await session()
    const stranger = asUser(BOB, 'owned')

    const denied = await sessionState.execute('sessions.rename', { sessionId, name: 'x' }, stranger)
    const missing = await sessionState.execute(
      'sessions.rename',
      { sessionId: asSessionId('00000000-0000-4000-8000-000000000000'), name: 'x' },
      stranger,
    )

    // Same outcome AND same returned value. Compared to each other rather than each
    // pinned separately, because the property IS the equality — that is what stops
    // the command surface being an existence oracle.
    expect(denied).toEqual(missing)
    expect(denied.value).toBeUndefined()

    // And the counterfactual, so "everything looks the same" is not just the
    // envelope refusing uniformly: the OWNER gets a DIFFERENT outcome for the
    // session that exists, and the SAME not-found for the one that does not.
    const owner = soleHumanSessionStatePrincipal(OPERATOR)
    expect((await sessionState.execute('sessions.rename', { sessionId, name: 'x' }, owner)).outcome).toBe(
      'applied',
    )
  })

  it('a session that does not exist denies even the OPERATOR — absence is not a permission question', async () => {
    const { sessionState } = await fixture()
    expect(
      (await sessionState.execute(
        'sessions.rename',
        { sessionId: asSessionId('nope'), name: 'x' },
        soleHumanSessionStatePrincipal(OPERATOR),
      )).outcome,
    ).toBe('denied')
  })
})

// ---------------------------------------------------------------------------
// AC: offline-drain re-authorization (ADR 3 D8, §3.1.3 A1)
// ---------------------------------------------------------------------------

describe('a queued write drained AFTER the grant was revoked is rejected at apply time', () => {
  /**
   * The scenario D8 was designed for, and the one §3.1.3 A1 makes non-theoretical:
   * the session-state writes are offline-eligible, so a rename can sit in the client
   * Outbox for hours. When it drains, the principal's rights must be resolved
   * AGAIN — not read from a capability frozen when the write was authored.
   *
   * Modelled by moving the stored grant between two applies of the SAME envelope
   * call, because that is exactly what a drain is: the same envelope, later.
   */
  async function grantableFixture() {
    const base = await fixture()
    let grants: string[] = [BOB]
    // Override the owner lookup so the grant list is a LIVE read, which is the
    // property under test. A snapshot would make this test pass trivially.
    const sessions = base.reg.modules.sessions as unknown as {
      sessionOwner: (id: string) => { owner: string | null; grants: string[] } | undefined
    }
    const realOwner = sessions.sessionOwner.bind(sessions)
    sessions.sessionOwner = (id: string) => {
      const found = realOwner(id)
      return found ? { owner: firstAdminMemberId(), grants } : undefined
    }
    return { ...base, revoke: () => (grants = []) }
  }

  it('the SAME queued rename applies while granted and is rejected after revocation', async () => {
    const { sessionState, asUser, session, revoke, reg } = await grantableFixture()
    const { sessionId } = await session()
    const grantee = asUser(BOB, 'owned')

    // Drain #1, still granted: applied. This is the arm that proves the fixture
    // can say YES — without it, the rejection below would prove nothing.
    const queued = { sessionId, name: 'from the outbox', mutationId: 'm-offline-1' }
    expect((await sessionState.execute('sessions.rename', queued, grantee)).outcome).toBe('applied')
    expect((await reg.modules.sessions.listSessions(undefined, 'rpc'))[0]?.name).toBe('from the outbox')

    revoke()

    // Drain #2 — a DIFFERENT queued write, authored before the revocation, draining
    // after it. Rejected at apply time.
    const laterQueued = { sessionId, name: 'authored before revocation', mutationId: 'm-offline-2' }
    expect((await sessionState.execute('sessions.rename', laterQueued, grantee)).outcome).toBe('denied')
    expect((await reg.modules.sessions.listSessions(undefined, 'rpc'))[0]?.name).toBe('from the outbox')
  })

  it('a REPLAY of an already-applied write is re-authorized, not served from the dedup cache', async () => {
    // The order-of-operations assertion. If idempotency ran before authorization,
    // this replay would return the cached result and read as a success — the dedup
    // cache would have laundered a write the principal may no longer make.
    const { sessionState, asUser, session, revoke } = await grantableFixture()
    const { sessionId } = await session()
    const grantee = asUser(BOB, 'owned')
    const write = { sessionId, name: 'first apply', mutationId: 'm-replay' }

    expect((await sessionState.execute('sessions.rename', write, grantee)).outcome).toBe('applied')
    // Replay while STILL granted: served from the cache, as idempotency requires.
    expect((await sessionState.execute('sessions.rename', write, grantee)).outcome).toBe('replayed')

    revoke()

    expect((await sessionState.execute('sessions.rename', write, grantee)).outcome).toBe('denied')
  })
})

// ---------------------------------------------------------------------------
// The envelope's own gates
// ---------------------------------------------------------------------------

describe('the envelope refuses before it reads anything', () => {
  it('a transport the contract does not declare is refused — and the declared one is not', async () => {
    const { sessionState, session } = await fixture()
    const { sessionId } = await session()
    const owner = soleHumanSessionStatePrincipal(OPERATOR)
    const input = { sessionId, name: 'via relay' }

    // POD-379 pinned that session-state writes have NO agent path. The contracts declare
    // only 'trpc', so the relay is refused by the exposure gate rather than by an
    // allowlist that could drift from the contract.
    expect((await sessionState.execute('sessions.rename', input, owner, 'relay')).outcome).toBe(
      'not-exposed',
    )
    expect((await sessionState.execute('sessions.rename', input, owner, 'cli')).outcome).toBe('not-exposed')
    expect((await sessionState.execute('sessions.rename', input, owner, 'trpc')).outcome).toBe('applied')
  })

  it('the composer draft is WS-only — not reachable over tRPC', async () => {
    const { sessionState, session } = await fixture()
    const { sessionId } = await session()
    const owner = soleHumanSessionStatePrincipal(OPERATOR)
    const input = { sessionId, edit: { kind: 'replace', text: 'typing' } }

    expect((await sessionState.execute('sessions.setDraft', input, owner, 'trpc')).outcome).toBe(
      'not-exposed',
    )
    expect((await sessionState.execute('sessions.setDraft', input, owner, 'ws')).outcome).toBe('applied')
  })

  it('an unknown or prototype-chain command name is refused', async () => {
    const { sessionState } = await fixture()
    const owner = soleHumanSessionStatePrincipal(OPERATOR)
    for (const name of ['sessions.nope', 'toString', 'constructor', '__proto__']) {
      expect((await sessionState.execute(name, {}, owner)).outcome).toBe('not-exposed')
    }
  })

  it('invalid input is reported as invalid, not silently no-opped', async () => {
    const { sessionState, session } = await fixture()
    const { sessionId } = await session()
    const owner = soleHumanSessionStatePrincipal(OPERATOR)

    expect((await sessionState.execute('sessions.rename', { sessionId }, owner)).outcome).toBe(
      'invalid-input',
    )
    expect(
      (await sessionState.execute('sessions.rename', { sessionId, name: 'x'.repeat(121) }, owner)).outcome,
    ).toBe('invalid-input')
  })
})

describe('the composer draft rejects a stale revision instead of overwriting', () => {
  /**
   * Draft Sync v2 (POD-859) is what gives a draft a REVISION, so the flag is turned
   * on here through the canonical experiments store. Without it there is no
   * revision, the guard has nothing to compare, and a test written against the
   * flag-off path would assert nothing while looking like it passed — the
   * "prove the instrument can say YES first" rule.
   */
  async function flaggedFixture() {
    const store = await openTestStore(':memory:')
    await store.settings.setSettings({
      ...(await store.settings.getSettings()),
      experimental: { 'draft-sync': true },
    })
    const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(reg)
    reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
    const sessionState = new SessionStateRegistry({
      sessions: reg.modules.sessions,
      state: reg.modules.sessions.state,

      mutations: reg.modules.mutations,
    })
    const { sessionId } = await reg.modules.sessions.createSession({ ownerUserId: firstAdminMemberId(), agentKind: 'shell', cwd: '/p' })
    const svc = reg.modules.sessions as unknown as {
      draftRevision: (id: string) => number | undefined
    }
    return { sessionState, sessionId, svc, owner: soleHumanSessionStatePrincipal(OPERATOR) }
  }

  const edit = (text: string) => ({ kind: 'replace' as const, text })

  it('an unconditional edit (no baseRevision) applies — today’s behaviour, unchanged', async () => {
    const { sessionState, sessionId, owner, svc } = await flaggedFixture()

    expect(
      (await sessionState.execute(
        'sessions.setDraft',
        { sessionId, edit: edit('half typed') },
        owner,
        'ws',
      )).outcome,
    ).toBe('applied')
    // The instrument check: a revision now EXISTS, so the stale test below has
    // something real to be stale against.
    expect(typeof svc.draftRevision(sessionId)).toBe('number')
  })

  it('an edit at the CURRENT revision applies, and one at a STALE revision is rejected', async () => {
    const { sessionState, sessionId, owner, svc } = await flaggedFixture()
    await sessionState.execute(
      'sessions.setDraft',
      { sessionId, edit: edit('first writer') },
      owner,
      'ws',
    )
    const revision = svc.draftRevision(sessionId)
    expect(revision).toBeGreaterThan(0)

    // Fresh: accepted.
    const fresh = await sessionState.execute(
      'sessions.setDraft',
      { sessionId, baseRevision: revision, edit: edit('same writer continues') },
      owner,
      'ws',
    )
    expect(fresh.outcome).toBe('applied')
    expect(fresh.value).toBeUndefined()

    // STALE: a second writer composing against an older revision. Rejected with a
    // reason the author can see — NOT silently applied over the first writer's text,
    // which is the one promise the op-stream reservation makes today (§3.3/§4).
    const staleAt = svc.draftRevision(sessionId)
    expect(staleAt).toBeGreaterThan(0)
    const stale = await sessionState.execute(
      'sessions.setDraft',
      { sessionId, baseRevision: (staleAt as number) - 1, edit: edit('CLOBBER') },
      owner,
      'ws',
    )
    expect(stale.outcome).toBe('applied') // the command ran; its EDIT was refused
    expect(stale.value).toMatchObject({ ok: false, reason: 'stale-revision' })
    // The refusal is the point: the clobbering text never reached the document.
    expect(svc.draftRevision(sessionId)).toBe(staleAt)
  })
})
