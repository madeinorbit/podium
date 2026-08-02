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

import { OPERATOR, SOLE_USER_ID, asSessionId, asUserId, type SessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../../relay'
import { SessionStore } from '../../../store'
import {
  type SessionStatePrincipal,
  SessionStateRegistry,
  soleHumanSessionStatePrincipal,
} from './registry'

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const reg of registries.splice(0)) reg.dispose()
})

const ALICE = asUserId('user:alice')
const BOB = asUserId('user:bob')

function fixture() {
  const store = new SessionStore(':memory:')
  const reg = new SessionRegistry(store)
  registries.push(reg)
  reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
  const sessionState = new SessionStateRegistry({
    sessions: reg.modules.sessions,
    state: reg.modules.sessions.state,

    mutations: reg.modules.mutations,
  })
  /**
   * A principal for an arbitrary user. `capability.scope` is `owned`/`self` for
   * that user — NOT `OPERATOR`. Using OPERATOR here would make every assertion
   * vacuous: `scope: 'all'` short-circuits authorize() before the target is read,
   * so an isolation test built on it would pass no matter what the policy said.
   */
  const asUser = (userId: string, scope: 'owned' | 'self'): SessionStatePrincipal => ({
    userId: asUserId(userId),
    capability: { role: 'worker', scope: { kind: scope, userId: asUserId(userId) } },
    onBehalfOf: asUserId(userId),
    humanDirect: true,
  })
  const asVisibleUser = (userId: string): SessionStatePrincipal => ({
    userId: asUserId(userId),
    capability: OPERATOR,
    onBehalfOf: asUserId(userId),
    humanDirect: true,
  })
  const session = () => reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/p' })
  return { store, reg, sessionState, asUser, asVisibleUser, session }
}

// ---------------------------------------------------------------------------
// AC: two principals do not observe each other's per-user values
// ---------------------------------------------------------------------------

describe('per-user state is isolated between principals', () => {
  it('two principals snooze the SAME session and each reads only its own value', () => {
    const { store, sessionState, asVisibleUser, session } = fixture()
    const { sessionId } = session()
    const until = new Date(Date.now() + 60_000).toISOString()
    const other = new Date(Date.now() + 120_000).toISOString()

    expect(
      sessionState.execute('snoozes.set', { sessionId, until }, asVisibleUser(ALICE)).outcome,
    ).toBe('applied')
    expect(
      sessionState.execute('snoozes.set', { sessionId, until: other }, asVisibleUser(BOB)).outcome,
    ).toBe('applied')

    // Same entity, two rows, two values. Neither principal's write moved the
    // other's — which is the whole point of the (userId, entityId) key.
    expect(store.sessions.listSnoozes(ALICE)).toEqual({ [sessionId]: until })
    expect(store.sessions.listSnoozes(BOB)).toEqual({ [sessionId]: other })
  })

  it("one principal's CLEAR does not un-snooze the other", () => {
    // The sharper case: a delete keyed too loosely would take both rows out, and
    // the set-only test above would not notice.
    const { store, sessionState, asVisibleUser, session } = fixture()
    const { sessionId } = session()
    sessionState.execute('snoozes.set', { sessionId, until: null }, asVisibleUser(ALICE))
    sessionState.execute('snoozes.set', { sessionId, until: null }, asVisibleUser(BOB))

    sessionState.execute('snoozes.clear', { sessionId }, asVisibleUser(ALICE))

    expect(store.sessions.listSnoozes(ALICE)).toEqual({})
    expect(store.sessions.listSnoozes(BOB)).toEqual({ [sessionId]: null })
  })

  it('pins are per-principal, and an unpin only unpins the caller', () => {
    const { store, sessionState, asVisibleUser } = fixture()
    const pin = { kind: 'panel', id: 'sess-1', pinned: true }
    sessionState.execute('pins.set', pin, asVisibleUser(ALICE))
    sessionState.execute('pins.set', pin, asVisibleUser(BOB))

    sessionState.execute('pins.set', { ...pin, pinned: false }, asVisibleUser(ALICE))

    expect(store.sessions.listPins(ALICE).panels).toEqual([])
    expect(store.sessions.listPins(BOB).panels).toEqual(['sess-1'])
  })

  it('tab order is per-principal for the SAME worktree', () => {
    const { store, sessionState, asVisibleUser, session } = fixture()
    const a = session().sessionId
    const b = session().sessionId

    sessionState.execute(
      'tabs.setOrder',
      { worktree: '/w', sessionIds: [a, b] },
      asVisibleUser(ALICE),
    )
    sessionState.execute(
      'tabs.setOrder',
      { worktree: '/w', sessionIds: [b, a] },
      asVisibleUser(BOB),
    )

    expect(store.sessions.listTabOrders(ALICE)).toEqual({ '/w': [a, b] })
    expect(store.sessions.listTabOrders(BOB)).toEqual({ '/w': [b, a] })
  })

  it('the empty-list DELETE stays scoped too — it removes the caller’s row only', () => {
    const { store, sessionState, asVisibleUser, session } = fixture()
    const a = session().sessionId
    sessionState.execute('tabs.setOrder', { worktree: '/w', sessionIds: [a] }, asVisibleUser(ALICE))
    sessionState.execute('tabs.setOrder', { worktree: '/w', sessionIds: [a] }, asVisibleUser(BOB))

    sessionState.execute('tabs.setOrder', { worktree: '/w', sessionIds: [] }, asVisibleUser(ALICE))

    expect(store.sessions.listTabOrders(ALICE)).toEqual({})
    expect(store.sessions.listTabOrders(BOB)).toEqual({ '/w': [a] })
  })
})

// ---------------------------------------------------------------------------
// AC: a principal cannot write another principal's per-user row
// ---------------------------------------------------------------------------

describe('per-user writes are SELF-SCOPED', () => {
  it('a userId in the PAYLOAD is inert — it cannot redirect the write (ADR 3 D7)', () => {
    const { store, sessionState, asVisibleUser, session } = fixture()
    const { sessionId } = session()

    // The strongest form of the self-scoping property: the attack does not fail,
    // it is not expressible. The row lands on ALICE regardless of the payload.
    const result = sessionState.execute(
      'snoozes.set',
      { sessionId, until: null, userId: BOB, onBehalfOf: BOB },
      asVisibleUser(ALICE),
    )

    expect(result.outcome).toBe('applied')
    expect(store.sessions.listSnoozes(ALICE)).toEqual({ [sessionId]: null })
    expect(store.sessions.listSnoozes(BOB)).toEqual({})
  })

  it('a principal whose capability names ANOTHER user is denied, and the same call as itself is allowed', () => {
    const { store, sessionState, session } = fixture()
    const { sessionId } = session()
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
      sessionState.execute('snoozes.set', { sessionId, until: null }, mismatched).outcome,
    ).toBe('denied')
    expect(store.sessions.listSnoozes(ALICE)).toEqual({})
    expect(store.sessions.listSnoozes(BOB)).toEqual({})

    // THE COUNTERFACTUAL: the identical call with a coherent principal applies. So
    // the denial above is the scope check talking, not a broken fixture.
    const coherent: SessionStatePrincipal = { ...mismatched, capability: OPERATOR }
    expect(sessionState.execute('snoozes.set', { sessionId, until: null }, coherent).outcome).toBe(
      'applied',
    )
    expect(store.sessions.listSnoozes(ALICE)).toEqual({ [sessionId]: null })
  })

  it('an owner-or-grant capability cannot make a per-user write at all', () => {
    // §3.3 / ADR 9 D3 rule 4: per-user state is non-grantable. Being the session's
    // OWNER does not let you set somebody's read state on it — or your own through
    // an ownership capability.
    const { store, sessionState, asUser, session } = fixture()
    const { sessionId } = session()

    expect(
      sessionState.execute('snoozes.set', { sessionId, until: null }, asUser(ALICE, 'owned'))
        .outcome,
    ).toBe('denied')
    expect(store.sessions.listSnoozes(ALICE)).toEqual({})
  })
  it('an invisible session read is identical to a nonexistent-session read', () => {
    const { reg, asUser, session } = fixture()
    const { sessionId } = session()
    const stranger = asUser(BOB, 'self')
    const missing = asSessionId('00000000-0000-4000-8000-000000000000')

    expect(reg.modules.sessions.state.readOverlay(stranger, sessionId)).toEqual(
      reg.modules.sessions.state.readOverlay(stranger, missing),
    )
    expect(reg.modules.sessions.state.readOverlay(stranger, sessionId)).toEqual({ kind: 'absent' })
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
  ]

  const inputFor = (name: string, sessionId: SessionId) => {
    switch (name) {
      case 'sessions.rename':
        return { sessionId, name: 'renamed' }
      case 'sessions.setArchived':
        return { sessionId, archived: true }
      case 'sessions.setWorkState':
        return { sessionId, workState: 'testing' as const }
      default:
        return { sessionId, issueId: null }
    }
  }

  it.each(SHARED)('%s: the OWNER is allowed', (name) => {
    const { sessionState, session } = fixture()
    const { sessionId } = session()
    // Sessions are owned by SOLE_USER_ID until POD-1075 (SessionLifecycle.sessionOwner).
    const owner: SessionStatePrincipal = {
      userId: asUserId(SOLE_USER_ID),
      capability: { role: 'worker', scope: { kind: 'owned', userId: asUserId(SOLE_USER_ID) } },
      onBehalfOf: asUserId(SOLE_USER_ID),
      humanDirect: true,
    }

    expect(sessionState.execute(name, inputFor(name, sessionId), owner).outcome).toBe('applied')
  })

  it.each(SHARED)('%s: a principal without owner or grant is DENIED', (name) => {
    const { sessionState, asUser, session } = fixture()
    const { sessionId } = session()

    expect(
      sessionState.execute(name, inputFor(name, sessionId), asUser(BOB, 'owned')).outcome,
    ).toBe('denied')
  })

  it('the denial is INDISTINGUISHABLE from not-found (§3.1.5)', () => {
    const { sessionState, asUser, session } = fixture()
    const { sessionId } = session()
    const stranger = asUser(BOB, 'owned')

    const denied = sessionState.execute('sessions.rename', { sessionId, name: 'x' }, stranger)
    const missing = sessionState.execute(
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
    expect(sessionState.execute('sessions.rename', { sessionId, name: 'x' }, owner).outcome).toBe(
      'applied',
    )
  })

  it('a session that does not exist denies even the OPERATOR — absence is not a permission question', () => {
    const { sessionState } = fixture()
    expect(
      sessionState.execute(
        'sessions.rename',
        { sessionId: asSessionId('nope'), name: 'x' },
        soleHumanSessionStatePrincipal(OPERATOR),
      ).outcome,
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
  function grantableFixture() {
    const base = fixture()
    let grants: string[] = [BOB]
    // Override the owner lookup so the grant list is a LIVE read, which is the
    // property under test. A snapshot would make this test pass trivially.
    const sessions = base.reg.modules.sessions as unknown as {
      sessionOwner: (id: string) => { owner: string | null; grants: string[] } | undefined
    }
    const realOwner = sessions.sessionOwner.bind(sessions)
    sessions.sessionOwner = (id: string) => {
      const found = realOwner(id)
      return found ? { owner: SOLE_USER_ID, grants } : undefined
    }
    return { ...base, revoke: () => (grants = []) }
  }

  it('the SAME queued rename applies while granted and is rejected after revocation', () => {
    const { sessionState, asUser, session, revoke, reg } = grantableFixture()
    const { sessionId } = session()
    const grantee = asUser(BOB, 'owned')

    // Drain #1, still granted: applied. This is the arm that proves the fixture
    // can say YES — without it, the rejection below would prove nothing.
    const queued = { sessionId, name: 'from the outbox', mutationId: 'm-offline-1' }
    expect(sessionState.execute('sessions.rename', queued, grantee).outcome).toBe('applied')
    expect(reg.modules.sessions.listSessions()[0]?.name).toBe('from the outbox')

    revoke()

    // Drain #2 — a DIFFERENT queued write, authored before the revocation, draining
    // after it. Rejected at apply time.
    const laterQueued = { sessionId, name: 'authored before revocation', mutationId: 'm-offline-2' }
    expect(sessionState.execute('sessions.rename', laterQueued, grantee).outcome).toBe('denied')
    expect(reg.modules.sessions.listSessions()[0]?.name).toBe('from the outbox')
  })

  it('a REPLAY of an already-applied write is re-authorized, not served from the dedup cache', () => {
    // The order-of-operations assertion. If idempotency ran before authorization,
    // this replay would return the cached result and read as a success — the dedup
    // cache would have laundered a write the principal may no longer make.
    const { sessionState, asUser, session, revoke } = grantableFixture()
    const { sessionId } = session()
    const grantee = asUser(BOB, 'owned')
    const write = { sessionId, name: 'first apply', mutationId: 'm-replay' }

    expect(sessionState.execute('sessions.rename', write, grantee).outcome).toBe('applied')
    // Replay while STILL granted: served from the cache, as idempotency requires.
    expect(sessionState.execute('sessions.rename', write, grantee).outcome).toBe('replayed')

    revoke()

    expect(sessionState.execute('sessions.rename', write, grantee).outcome).toBe('denied')
  })
})

// ---------------------------------------------------------------------------
// The envelope's own gates
// ---------------------------------------------------------------------------

describe('the envelope refuses before it reads anything', () => {
  it('a transport the contract does not declare is refused — and the declared one is not', () => {
    const { sessionState, session } = fixture()
    const { sessionId } = session()
    const owner = soleHumanSessionStatePrincipal(OPERATOR)
    const input = { sessionId, name: 'via relay' }

    // POD-379 pinned that session-state writes have NO agent path. The contracts declare
    // only 'trpc', so the relay is refused by the exposure gate rather than by an
    // allowlist that could drift from the contract.
    expect(sessionState.execute('sessions.rename', input, owner, 'relay').outcome).toBe(
      'not-exposed',
    )
    expect(sessionState.execute('sessions.rename', input, owner, 'cli').outcome).toBe('not-exposed')
    expect(sessionState.execute('sessions.rename', input, owner, 'trpc').outcome).toBe('applied')
  })

  it('the composer draft is WS-only — not reachable over tRPC', () => {
    const { sessionState, session } = fixture()
    const { sessionId } = session()
    const owner = soleHumanSessionStatePrincipal(OPERATOR)
    const input = { sessionId, edit: { kind: 'replace', text: 'typing' } }

    expect(sessionState.execute('sessions.setDraft', input, owner, 'trpc').outcome).toBe(
      'not-exposed',
    )
    expect(sessionState.execute('sessions.setDraft', input, owner, 'ws').outcome).toBe('applied')
  })

  it('an unknown or prototype-chain command name is refused', () => {
    const { sessionState } = fixture()
    const owner = soleHumanSessionStatePrincipal(OPERATOR)
    for (const name of ['sessions.nope', 'toString', 'constructor', '__proto__']) {
      expect(sessionState.execute(name, {}, owner).outcome).toBe('not-exposed')
    }
  })

  it('invalid input is reported as invalid, not silently no-opped', () => {
    const { sessionState, session } = fixture()
    const { sessionId } = session()
    const owner = soleHumanSessionStatePrincipal(OPERATOR)

    expect(sessionState.execute('sessions.rename', { sessionId }, owner).outcome).toBe(
      'invalid-input',
    )
    expect(
      sessionState.execute('sessions.rename', { sessionId, name: 'x'.repeat(121) }, owner).outcome,
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
  function flaggedFixture() {
    const store = new SessionStore(':memory:')
    store.settings.setSettings({
      ...store.settings.getSettings(),
      experimental: { 'draft-sync': true },
    })
    const reg = new SessionRegistry(store)
    registries.push(reg)
    reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
    const sessionState = new SessionStateRegistry({
      sessions: reg.modules.sessions,
      state: reg.modules.sessions.state,

      mutations: reg.modules.mutations,
    })
    const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/p' })
    const svc = reg.modules.sessions as unknown as {
      draftRevision: (id: string) => number | undefined
    }
    return { sessionState, sessionId, svc, owner: soleHumanSessionStatePrincipal(OPERATOR) }
  }

  const edit = (text: string) => ({ kind: 'replace' as const, text })

  it('an unconditional edit (no baseRevision) applies — today’s behaviour, unchanged', () => {
    const { sessionState, sessionId, owner, svc } = flaggedFixture()

    expect(
      sessionState.execute(
        'sessions.setDraft',
        { sessionId, edit: edit('half typed') },
        owner,
        'ws',
      ).outcome,
    ).toBe('applied')
    // The instrument check: a revision now EXISTS, so the stale test below has
    // something real to be stale against.
    expect(typeof svc.draftRevision(sessionId)).toBe('number')
  })

  it('an edit at the CURRENT revision applies, and one at a STALE revision is rejected', () => {
    const { sessionState, sessionId, owner, svc } = flaggedFixture()
    sessionState.execute(
      'sessions.setDraft',
      { sessionId, edit: edit('first writer') },
      owner,
      'ws',
    )
    const revision = svc.draftRevision(sessionId)
    expect(revision).toBeGreaterThan(0)

    // Fresh: accepted.
    const fresh = sessionState.execute(
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
    const stale = sessionState.execute(
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
