/**
 * THE OFFLINE PATH FOR `sessions.rename` — POD-351.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE ADDS THAT POD-373'S CONFORMANCE SUITE DOES NOT
 * ---------------------------------------------------------------------------
 *
 * POD-373 already proves `scoped/revoked-offline-with-queued-writes` at the
 * KERNEL level, against a derived authority with a STUB policy. That is the right
 * place for the mechanism and this file does not repeat it.
 *
 * What it cannot prove is the VERTICAL: that a real command, with a real
 * contract, reaching a real service through the real apply path, is
 * re-authorized on its drain by the SAME code that authorized it online. That is
 * this issue's claim, and it is the one that would break silently — a replay path
 * with its own weaker check typechecks, passes the kernel suite, and hands back a
 * write the principal may no longer make.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE AND WHAT IS SUBSTITUTED, AND WHY
 * ---------------------------------------------------------------------------
 *
 * REAL: the store, the SessionRegistry, the SessionsService, the contract, the
 * envelope, the principal, and the applied-mutation table that backs idempotency.
 *
 * SUBSTITUTED: the OWNERSHIP SOURCE only. `SessionsService.sessionOwner` returns
 * a constant today — every session is owned by the sole user and the grant list
 * is always empty — because the owner column is POD-1075's and does not exist
 * yet. So "revoke this principal's access" is not expressible against the real
 * service at all.
 *
 * Substituting exactly that one function is substituting THE PART THAT IS NOT
 * BUILT, not the part under test: the re-authorization logic, the envelope order,
 * the delegation ceiling and the handler are all the shipped ones. The
 * alternative — waiting for POD-1075 — would mean this acceptance criterion is
 * unproven at the moment the skeleton is signed off, which is when the port
 * shapes it justifies get frozen.
 *
 * The honest limit is stated once, here: these tests prove the WRITE path
 * re-authorizes live. They do not prove read-side scoping, which is POD-1077's
 * and is recorded as an open gap in the ledger.
 */

import { OPERATOR } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTANCE_OWNER, type CommandPrincipal } from '../../command-principal'
import { SessionRegistry } from '../../relay'
import { SessionStore } from '../../store'
import { renameOnTargetPath, type RenameServices } from './rename-target-path'

const registries: SessionRegistry[] = []
afterEach(() => {
  for (const reg of registries.splice(0)) reg.dispose()
})

/**
 * A real stack whose ONE not-yet-built dependency — the owner/grant lookup — is
 * controllable, so a revocation between enqueue and drain is expressible.
 */
function revocableStack() {
  const store = new SessionStore(':memory:')
  const reg = new SessionRegistry(store)
  registries.push(reg)
  reg.gateway.attachDaemon('local', () => {})
  const sessions = reg.modules.sessions
  const created = sessions.createSession({ agentKind: 'shell', cwd: '/p' })

  // Mutable ownership, read LIVE on every call — which is the whole mechanism.
  // There is no snapshot to invalidate because there is no snapshot.
  const ownership = { owner: INSTANCE_OWNER as string | null, grants: [] as string[] }

  const deps = {
    sessions: new Proxy(sessions, {
      get(target, prop, receiver) {
        if (prop === 'sessionOwner') {
          return (sessionId: string) =>
            sessionId === created.sessionId
              ? { owner: ownership.owner, grants: ownership.grants }
              : undefined
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as unknown as RenameServices,
    mutations: reg.modules.mutations,
  }

  const nameNow = () =>
    sessions.listSessions().find((s) => s.sessionId === created.sessionId)?.name

  return { deps, sessions, store, sessionId: created.sessionId, ownership, nameNow }
}

/**
 * THE HUMAN PRINCIPAL, WITH AN `owned` SCOPE — NOT `OPERATOR`.
 *
 * This distinction decides whether this whole file proves anything, and it caught
 * me: every revocation test below FIRST passed with `OPERATOR` because
 * `OPERATOR` is `{ role: 'admin', scope: { kind: 'all' } }`, and `authorize()`
 * returns `allow` for a scope of `all` BEFORE it ever reads the target's owner. A
 * revocation test built on it is vacuous — it would pass against an
 * implementation with no ownership check at all. POD-380's own presence tests
 * carry the same warning in as many words.
 *
 * So the principal here is the one POD-1075 will actually mint: a `worker` whose
 * scope is `owned` by a specific user. `renameOperatorShortCircuit` below pins
 * what today's real tRPC principal does, so the gap is RECORDED rather than
 * hidden by this substitution.
 */
const humanScoped = (userId: string): CommandPrincipal => ({
  kind: 'user',
  user: userId as typeof INSTANCE_OWNER,
  capability: { role: 'worker', scope: { kind: 'owned', userId } },
})

const human = humanScoped(INSTANCE_OWNER)

/**
 * The AGENT's capability is deliberately left as admin/all. Its own scope is
 * therefore never the thing that refuses — only its HUMAN's current rights are,
 * which is what makes the ceiling tests claims about the delegation intersection
 * (§3.1.3 A1) rather than about the agent's own scope.
 */
const agentOf = (agentSessionId: string, onBehalfOf: string): CommandPrincipal => ({
  kind: 'agent',
  agentSessionId,
  onBehalfOf: onBehalfOf as typeof INSTANCE_OWNER,
  capability: { ...OPERATOR, actorSessionId: agentSessionId },
  chain: [],
})

// ---------------------------------------------------------------------------
// AC: revoked while offline with queued writes → REJECTED on drain
// ---------------------------------------------------------------------------

describe('a rename queued offline is re-authorized at DRAIN, against the world as it is then', () => {
  it('applies on drain when nothing changed', () => {
    // THE INSTRUMENT MUST SAY YES FIRST. Without this, every refusal below would
    // be consistent with an outbox transport that is simply wired shut, and the
    // whole file would prove nothing.
    const s = revocableStack()

    const drained = renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'queued while offline', mutationId: 'm1' },
      human,
      'outbox',
    )

    expect(drained.outcome).toBe('applied')
    expect(s.nameNow()).toBe('queued while offline')
  })

  it('REJECTS on drain when the principal lost access while offline', () => {
    const s = revocableStack()

    // ... the write is authored while the principal still holds the session.
    // Nothing about that authorization is stored — which is the point.

    // ... and then access is revoked while the client is offline. Nothing on the
    // client knows, and nothing on the server was told to go and invalidate a copy.
    s.ownership.owner = 'user:someone-else'

    const drained = renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'queued while offline', mutationId: 'm1' },
      human,
      'outbox',
    )

    expect(drained.outcome).toBe('denied')
    // The write did NOT land.
    expect(s.nameNow()).toBeUndefined()
  })

  it('REJECTS on drain when the delegating HUMAN was revoked, though the agent was not', () => {
    // §3.1.3 A1's transitive property, which is the reason live resolution beats a
    // snapshot: revoke the person and their unattended agents stop, with no reaper
    // to write and none to forget. The AGENT's own capability is admin/all here and
    // is untouched — only its human lost the row.
    const s = revocableStack()
    const agent = agentOf('agent-sess-1', INSTANCE_OWNER)

    // Instrument first: this agent CAN write before the revocation.
    expect(
      renameOnTargetPath(
        s.deps,
        { sessionId: s.sessionId, name: 'agent name', mutationId: 'pre' },
        agent,
        'outbox',
      ).outcome,
    ).toBe('applied')

    s.ownership.owner = 'user:someone-else'

    const drained = renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'after revoke', mutationId: 'm2' },
      agent,
      'outbox',
    )

    expect(drained.outcome).toBe('denied')
    expect(s.nameNow()).toBe('agent name')
  })

  it('re-grants take effect on the next drain, with nothing to invalidate', () => {
    // The other direction, and the counterfactual for every refusal above: if the
    // rejections came from a wedged transport rather than from live resolution,
    // restoring the grant would change nothing.
    const s = revocableStack()
    s.ownership.owner = 'user:someone-else'
    expect(
      renameOnTargetPath(
        s.deps,
        { sessionId: s.sessionId, name: 'nope', mutationId: 'a' },
        human,
        'outbox',
      ).outcome,
    ).toBe('denied')

    s.ownership.owner = INSTANCE_OWNER

    expect(
      renameOnTargetPath(
        s.deps,
        { sessionId: s.sessionId, name: 'yes', mutationId: 'b' },
        human,
        'outbox',
      ).outcome,
    ).toBe('applied')
    expect(s.nameNow()).toBe('yes')
  })

  it('a GRANT, not just ownership, is enough — and is also read live', () => {
    const s = revocableStack()
    s.ownership.owner = 'user:someone-else'
    s.ownership.grants = [INSTANCE_OWNER]

    expect(
      renameOnTargetPath(
        s.deps,
        { sessionId: s.sessionId, name: 'granted', mutationId: 'g1' },
        human,
        'outbox',
      ).outcome,
    ).toBe('applied')

    // Revoke the GRANT specifically (ownership unchanged) — the write stops.
    s.ownership.grants = []
    expect(
      renameOnTargetPath(
        s.deps,
        { sessionId: s.sessionId, name: 'after grant revoked', mutationId: 'g2' },
        human,
        'outbox',
      ).outcome,
    ).toBe('denied')
    expect(s.nameNow()).toBe('granted')
  })
})

// ---------------------------------------------------------------------------
// AC: authorization runs BEFORE idempotency — a revoked REPLAY is refused
// ---------------------------------------------------------------------------

describe('a replay whose grant was revoked is refused, not served from the dedup cache', () => {
  it('refuses the SAME mutationId after revocation, though it is in the applied table', () => {
    // THE ORDERING TEST. The dedup cache is the thing that would launder this: with
    // idempotency first, the second call returns the recorded success and the
    // principal is told a write it may no longer make succeeded. The envelope runs
    // authorization first precisely so this cannot happen (ADR 3 D8).
    const s = revocableStack()

    const first = renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'authored while allowed', mutationId: 'dup-1' },
      human,
      'outbox',
    )
    expect(first.outcome).toBe('applied')

    // The mutation IS in the applied table — so a cache-first envelope would have
    // something to serve. This assertion is what makes the next one meaningful.
    expect(s.store.sync.getAppliedMutation('dup-1')).toBeDefined()

    s.ownership.owner = 'user:someone-else'

    const replay = renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'authored while allowed', mutationId: 'dup-1' },
      human,
      'outbox',
    )

    expect(replay.outcome).toBe('denied')
  })

  it('still dedupes a replay the principal MAY still make', () => {
    // The counterfactual: idempotency is not simply broken. Same replay, rights
    // intact, and it is served from the cache as `replayed` rather than applied twice.
    const s = revocableStack()
    renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'once', mutationId: 'dup-2' },
      human,
      'outbox',
    )
    const replay = renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'DIFFERENT NAME', mutationId: 'dup-2' },
      human,
      'outbox',
    )

    expect(replay.outcome).toBe('replayed')
    // The second call's payload was NOT applied — that is what dedup means.
    expect(s.nameNow()).toBe('once')
  })
})

// ---------------------------------------------------------------------------
// AC: no capability snapshot is taken at enqueue time, anywhere in the path
// ---------------------------------------------------------------------------

describe('no capability snapshot exists anywhere in the rename path', () => {
  it('the outbox record type has nowhere to put one', async () => {
    // BY ABSENCE, over the real module's source rather than over a description of
    // it. ADR 3 D16 refuses a stored capability, and the structural guarantee is
    // that `OutboxRecord` has no field for one — so an implementation could not
    // take a snapshot even if it wanted to.
    const records = await import('@podium/sync')
    // The exported surface carries the attribution PAIR and no rights vocabulary.
    const forbidden = ['capability', 'rights', 'acl', 'scopeSnapshot', 'allowed']
    for (const key of forbidden) {
      expect(Object.keys(records).some((k) => k.toLowerCase().includes(key))).toBe(false)
    }
  })

  it('the target path holds no state between calls — two drains resolve independently', () => {
    // The behavioural half of the same claim. If ANY rights answer were cached
    // between calls, flipping ownership between two otherwise identical drains
    // could not change the outcome. It does.
    const s = revocableStack()
    const call = (mutationId: string) =>
      renameOnTargetPath(
        s.deps,
        { sessionId: s.sessionId, name: 'n', mutationId },
        human,
        'outbox',
      ).outcome

    expect(call('s1')).toBe('applied')
    s.ownership.owner = 'user:someone-else'
    expect(call('s2')).toBe('denied')
    s.ownership.owner = INSTANCE_OWNER
    expect(call('s3')).toBe('applied')
  })
})

// ---------------------------------------------------------------------------
// AC: the contract's exposure gates the offline transport
// ---------------------------------------------------------------------------

describe('the offline transport is served because the CONTRACT says so', () => {
  it('refuses a transport the contract does not declare, before reading the input', () => {
    // Default-closed, and checked ahead of parse: `relay` is deliberately absent
    // from rename's exposure (agents rename through sessions.title). A garbage
    // payload proves the exposure check ran FIRST — a parse-first envelope would
    // have answered `invalid-input`.
    const s = revocableStack()
    const refused = renameOnTargetPath(s.deps, { total: 'garbage' }, human, 'relay')
    expect(refused.outcome).toBe('not-exposed')
  })
})

// ---------------------------------------------------------------------------
// THE TRANSITIONAL GAP, RECORDED RATHER THAN HIDDEN
// ---------------------------------------------------------------------------

/**
 * TODAY'S REAL tRPC HUMAN IS `OPERATOR`, AND `OPERATOR` IS NOT OWNER-GATED.
 *
 * The tests above use a `worker`/`owned` capability — the principal POD-1075 will
 * mint. The principal the product mints TODAY is `OPERATOR`
 * (`{ role: 'admin', scope: { kind: 'all' } }`), and `authorize()` answers `allow`
 * for scope `all` before it reads the target's owner at all.
 *
 * So the owner/grant gate on this command is REAL and PROVEN for an agent (whose
 * human ceiling is checked separately and unconditionally) and for any scoped
 * human, and is SHORT-CIRCUITED for today's unconstrained operator. That is
 * correct-as-designed — one shared password means one unconstrained human, and
 * §3.2 says so — but it must not be reported as "owner-gated" without the
 * qualifier, which is why it is a test and not a footnote.
 *
 * This is exactly the state ADR 3 Amendment 1's rejected-alternatives table warns
 * about: with OPERATOR as the tRPC principal, "every ownership check would be dead
 * code on the one transport humans actually use". It is NOT dead code here — the
 * agent path exercises it on every call — but it is unexercised for the human, and
 * that distinction belongs in the record.
 */
describe('today’s operator principal short-circuits the owner gate (transitional, §3.2)', () => {
  it('OPERATOR renames a session it does not own, because scope `all` allows it', () => {
    const s = revocableStack()
    s.ownership.owner = 'user:someone-else'

    const operator: CommandPrincipal = {
      kind: 'user',
      user: INSTANCE_OWNER,
      capability: OPERATOR,
    }

    const dispatch = renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'operator wrote this', mutationId: 'op-1' },
      operator,
      'outbox',
    )

    // Pinned as the CURRENT behaviour, not endorsed as the target one. When
    // POD-1075 replaces OPERATOR with a scoped per-user principal this flips to
    // 'denied' and this test is the one that says so.
    expect(dispatch.outcome).toBe('applied')
    expect(s.nameNow()).toBe('operator wrote this')
  })

  it('but an AGENT is refused on the same session, even with an admin/all capability', () => {
    // THE COUNTERFACTUAL that shows the gate is not simply absent. Same session,
    // same foreign owner, same admin/all capability — refused, because the agent's
    // ceiling is its human's CURRENT rights and that check has no scope
    // short-circuit to fall through.
    const s = revocableStack()
    s.ownership.owner = 'user:someone-else'

    const dispatch = renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'agent tried', mutationId: 'op-2' },
      agentOf('agent-sess-7', INSTANCE_OWNER),
      'outbox',
    )

    expect(dispatch.outcome).toBe('denied')
    expect(s.nameNow()).toBeUndefined()
  })
})
