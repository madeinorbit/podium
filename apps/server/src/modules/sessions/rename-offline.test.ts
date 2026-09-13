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
 * REAL: the store, the SessionRegistry, the SessionLifecycle, the contract, the
 * envelope, the principal, and the applied-mutation table that backs idempotency.
 *
 * SUBSTITUTED: the OWNERSHIP SOURCE only. `SessionLifecycle.sessionOwner` returns
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

import { asMutationId, asSessionId, asUserId, type UserId} from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { type CommandPrincipal, firstAdminMemberId } from '../../command-principal'
import { SessionRegistry } from '../../relay'
import { OPERATOR } from '../../test-support/capabilities'
import { openTestStore } from '../../test-support/open-test-store'
import { type RenameServices, renameOnTargetPath } from './rename-target-path'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const reg of registries.splice(0)) await reg.dispose()
})

/**
 * A real stack whose ONE not-yet-built dependency — the owner/grant lookup — is
 * controllable, so a revocation between enqueue and drain is expressible.
 */
async function revocableStack() {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, () => {})
  const sessions = reg.modules.sessions
  const created = await sessions.createSession({ ownerUserId: firstAdminMemberId(), agentKind: 'shell', cwd: '/p' })

  // Mutable ownership, read LIVE on every call — which is the whole mechanism.
  // There is no snapshot to invalidate because there is no snapshot.
  const ownership = { owner: firstAdminMemberId() as string | null, grants: [] as string[] }

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

  const nameNow = async () => (await sessions.listSessions(undefined, 'rpc')).find((s) => s.sessionId === created.sessionId)?.name

  return { deps, sessions, store, sessionId: created.sessionId, ownership, nameNow }
}

/**
 * THE HUMAN PRINCIPAL, WITH AN `owned` SCOPE — NOT `OPERATOR`.
 *
 * This distinction decides whether this whole file proves anything, and it caught
 * me: every revocation test below FIRST passed with `OPERATOR` because
 * `OPERATOR` is `{ role: 'admin', scope: { kind: 'all' } }`, and `authorize()`
 * used to return `allow` for a scope of `all` BEFORE it ever read the target's
 * owner. A revocation test built on it was vacuous — it would pass against an
 * implementation with no ownership check at all. POD-380's own presence tests
 * carry the same warning in as many words.
 *
 * THAT SHORT CIRCUIT IS GONE FOR PERSONAL TARGETS (A3/PDM-129, A5.1/PDM-245), and
 * the sentence above is kept in the past tense rather than deleted because it is
 * the reason this constant exists. The rule it produced is unchanged: the
 * principal here is the one POD-1075 will actually mint, a `worker` whose scope is
 * `owned` by a specific user, so that the ownership question is asked of a
 * capability that is ABOUT ownership. The last block in this file now pins what
 * today's real tRPC principal does against a session it does not own — a refusal,
 * where it used to be the recorded gap.
 */
const humanScoped = (userId: string): CommandPrincipal => ({
  kind: 'user',
  user: userId as UserId,
  capability: { role: 'worker', scope: { kind: 'owned', userId: asUserId(userId) } },
})

const human = humanScoped(firstAdminMemberId())

/**
 * The AGENT's capability is deliberately left as admin/all. Its own scope is
 * therefore never the thing that refuses — only its HUMAN's current rights are,
 * which is what makes the ceiling tests claims about the delegation intersection
 * (§3.1.3 A1) rather than about the agent's own scope.
 */
const agentOf = (agentSessionId: string, onBehalfOf: string): CommandPrincipal => ({
  kind: 'agent',
  agentSessionId: asSessionId(agentSessionId),
  onBehalfOf: onBehalfOf as UserId,
  capability: { ...OPERATOR, actorSessionId: asSessionId(agentSessionId) },
  chain: [],
})

// ---------------------------------------------------------------------------
// AC: revoked while offline with queued writes → REJECTED on drain
// ---------------------------------------------------------------------------

describe('a rename queued offline is re-authorized at DRAIN, against the world as it is then', () => {
  it('applies on drain when nothing changed', async () => {
    // THE INSTRUMENT MUST SAY YES FIRST. Without this, every refusal below would
    // be consistent with an outbox transport that is simply wired shut, and the
    // whole file would prove nothing.
    const s = await revocableStack()

    const drained = await renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'queued while offline', mutationId: 'm1' },
      human,
      'outbox',
    )

    expect(drained.outcome).toBe('applied')
    expect(await s.nameNow()).toBe('queued while offline')
  })

  it('REJECTS on drain when the principal lost access while offline', async () => {
    const s = await revocableStack()

    // ... the write is authored while the principal still holds the session.
    // Nothing about that authorization is stored — which is the point.

    // ... and then access is revoked while the client is offline. Nothing on the
    // client knows, and nothing on the server was told to go and invalidate a copy.
    s.ownership.owner = 'user:someone-else'

    const drained = await renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'queued while offline', mutationId: 'm1' },
      human,
      'outbox',
    )

    expect(drained.outcome).toBe('denied')
    // The write did NOT land.
    expect(await s.nameNow()).toBeUndefined()
  })

  it('REJECTS on drain when the delegating HUMAN was revoked, though the agent was not', async () => {
    // §3.1.3 A1's transitive property, which is the reason live resolution beats a
    // snapshot: revoke the person and their unattended agents stop, with no reaper
    // to write and none to forget. The AGENT's own capability is admin/all here and
    // is untouched — only its human lost the row.
    const s = await revocableStack()
    const agent = agentOf('agent-sess-1', firstAdminMemberId())

    // Instrument first: this agent CAN write before the revocation.
    expect(
      (await renameOnTargetPath(
        s.deps,
        { sessionId: s.sessionId, name: 'agent name', mutationId: 'pre' },
        agent,
        'outbox',
      )).outcome,
    ).toBe('applied')

    s.ownership.owner = 'user:someone-else'

    const drained = await renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'after revoke', mutationId: 'm2' },
      agent,
      'outbox',
    )

    expect(drained.outcome).toBe('denied')
    expect(await s.nameNow()).toBe('agent name')
  })

  it('re-grants take effect on the next drain, with nothing to invalidate', async () => {
    // The other direction, and the counterfactual for every refusal above: if the
    // rejections came from a wedged transport rather than from live resolution,
    // restoring the grant would change nothing.
    const s = await revocableStack()
    s.ownership.owner = 'user:someone-else'
    expect(
      (await renameOnTargetPath(
        s.deps,
        { sessionId: s.sessionId, name: 'nope', mutationId: 'a' },
        human,
        'outbox',
      )).outcome,
    ).toBe('denied')

    s.ownership.owner = firstAdminMemberId()

    expect(
      (await renameOnTargetPath(
        s.deps,
        { sessionId: s.sessionId, name: 'yes', mutationId: 'b' },
        human,
        'outbox',
      )).outcome,
    ).toBe('applied')
    expect(await s.nameNow()).toBe('yes')
  })

  it('a GRANT, not just ownership, is enough — and is also read live', async () => {
    const s = await revocableStack()
    s.ownership.owner = 'user:someone-else'
    s.ownership.grants = [firstAdminMemberId()]

    expect(
      (await renameOnTargetPath(
        s.deps,
        { sessionId: s.sessionId, name: 'granted', mutationId: 'g1' },
        human,
        'outbox',
      )).outcome,
    ).toBe('applied')

    // Revoke the GRANT specifically (ownership unchanged) — the write stops.
    s.ownership.grants = []
    expect(
      (await renameOnTargetPath(
        s.deps,
        { sessionId: s.sessionId, name: 'after grant revoked', mutationId: 'g2' },
        human,
        'outbox',
      )).outcome,
    ).toBe('denied')
    expect(await s.nameNow()).toBe('granted')
  })
})

// ---------------------------------------------------------------------------
// AC: authorization runs BEFORE idempotency — a revoked REPLAY is refused
// ---------------------------------------------------------------------------

describe('a replay whose grant was revoked is refused, not served from the dedup cache', () => {
  it('refuses the SAME mutationId after revocation, though it is in the applied table', async () => {
    // THE ORDERING TEST. The dedup cache is the thing that would launder this: with
    // idempotency first, the second call returns the recorded success and the
    // principal is told a write it may no longer make succeeded. The envelope runs
    // authorization first precisely so this cannot happen (ADR 3 D8).
    const s = await revocableStack()

    const first = await renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'authored while allowed', mutationId: 'dup-1' },
      human,
      'outbox',
    )
    expect(first.outcome).toBe('applied')

    // The mutation IS in the applied table — so a cache-first envelope would have
    // something to serve. This assertion is what makes the next one meaningful.
    expect(await s.store.sync.getAppliedMutation(asMutationId('dup-1'))).toBeDefined()

    s.ownership.owner = 'user:someone-else'

    const replay = await renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'authored while allowed', mutationId: 'dup-1' },
      human,
      'outbox',
    )

    expect(replay.outcome).toBe('denied')
  })

  it('still dedupes a replay the principal MAY still make', async () => {
    // The counterfactual: idempotency is not simply broken. Same replay, rights
    // intact, and it is served from the cache as `replayed` rather than applied twice.
    const s = await revocableStack()
    await renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'once', mutationId: 'dup-2' },
      human,
      'outbox',
    )
    const replay = await renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'DIFFERENT NAME', mutationId: 'dup-2' },
      human,
      'outbox',
    )

    expect(replay.outcome).toBe('replayed')
    // The second call's payload was NOT applied — that is what dedup means.
    expect(await s.nameNow()).toBe('once')
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

  it('the target path holds no state between calls — two drains resolve independently', async () => {
    // The behavioural half of the same claim. If ANY rights answer were cached
    // between calls, flipping ownership between two otherwise identical drains
    // could not change the outcome. It does.
    const s = await revocableStack()
    const call = async (mutationId: string) =>
      (await renameOnTargetPath(
        s.deps,
        { sessionId: s.sessionId, name: 'n', mutationId },
        human,
        'outbox',
      )).outcome

    expect(await call('s1')).toBe('applied')
    s.ownership.owner = 'user:someone-else'
    expect(await call('s2')).toBe('denied')
    s.ownership.owner = firstAdminMemberId()
    expect(await call('s3')).toBe('applied')
  })
})

// ---------------------------------------------------------------------------
// AC: the contract's exposure gates the offline transport
// ---------------------------------------------------------------------------

describe('the offline transport is served because the CONTRACT says so', () => {
  it('refuses a transport the contract does not declare, before reading the input', async () => {
    // Default-closed, and checked ahead of parse: `relay` is deliberately absent
    // from rename's exposure (agents rename through sessions.title). A garbage
    // payload proves the exposure check ran FIRST — a parse-first envelope would
    // have answered `invalid-input`.
    const s = await revocableStack()
    const refused = await renameOnTargetPath(s.deps, { total: 'garbage' }, human, 'relay')
    expect(refused.outcome).toBe('not-exposed')
  })
})

// ---------------------------------------------------------------------------
// THE TRANSITIONAL GAP, RECORDED RATHER THAN HIDDEN
// ---------------------------------------------------------------------------

/**
 * THE TRANSITIONAL GAP IS CLOSED, AND THIS IS THE TEST THAT SAID IT WOULD BE.
 *
 * This block used to be titled "today's operator principal short-circuits the
 * owner gate" and pinned the opposite outcome: OPERATOR renaming a session owned
 * by somebody else, applied, with the note that "when POD-1075 replaces OPERATOR
 * with a scoped per-user principal this flips to 'denied' and this test is the one
 * that says so". It flipped earlier than that and for a better reason — not
 * because the principal changed, but because the POLICY did.
 *
 * A3 (PDM-129) removed the admin-to-private-resource bypass from `authorize()`'s
 * `all` arm, and A5.1 (PDM-245) removed the grant clause that survived it: a
 * personal target — an owned entity or a per-user row — is now decided by
 * OWNERSHIP against `cap.onBehalfOf` whatever the scope says, because ADR 9
 * Amendment 1 D7 is that an admin may not view or drive another member's session.
 * So the gap this block existed to RECORD no longer exists, and what the block
 * records now is that it stays closed.
 *
 * The qualifier that used to be necessary is therefore retired: the owner gate on
 * this command is real and proven for an agent, for any scoped human, AND for
 * today's unconstrained operator. ADR 3 Amendment 1's rejected-alternatives table
 * warned that with OPERATOR as the tRPC principal "every ownership check would be
 * dead code on the one transport humans actually use". On this command it is not
 * dead code on any transport any more.
 *
 * WHAT KEEPS THIS FROM BECOMING AN ENVELOPE-REFUSES-EVERYTHING TEST: the second
 * case. The same operator, the same command, the same envelope, renaming the
 * session it DOES own — applied. A refusal that cannot be made into an allow by
 * changing only the owner would be evidence about the fixture, not the policy.
 */
describe('the operator short-circuit over a foreign session is CLOSED (A3/A5.1)', () => {
  const operator: CommandPrincipal = {
    kind: 'user',
    user: firstAdminMemberId(),
    capability: OPERATOR,
  }

  it('OPERATOR is REFUSED a session it does not own — `all` no longer answers for a personal target', async () => {
    const s = await revocableStack()
    s.ownership.owner = 'user:someone-else'

    const dispatch = await renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'operator wrote this', mutationId: 'op-1' },
      operator,
      'outbox',
    )

    expect(dispatch.outcome).toBe('denied')
    // And nothing was written on the way to the refusal: denial is decided before
    // the handler, so the foreign session keeps the name it had.
    expect(await s.nameNow()).toBeUndefined()
  })

  it('and the SAME operator renames the session it DOES own', async () => {
    // THE ALLOW ARM, and the only thing that makes the refusal above a statement
    // about ownership. One fact differs between the two cases: who owns the row.
    const s = await revocableStack()
    s.ownership.owner = firstAdminMemberId()

    const dispatch = await renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'operator wrote this', mutationId: 'op-1b' },
      operator,
      'outbox',
    )

    expect(dispatch.outcome).toBe('applied')
    expect(await s.nameNow()).toBe('operator wrote this')
  })

  it('but an AGENT is refused on the same session, even with an admin/all capability', async () => {
    // THE COUNTERFACTUAL that shows the gate is not simply absent. Same session,
    // same foreign owner, same admin/all capability — refused, because the agent's
    // ceiling is its human's CURRENT rights and that check has no scope
    // short-circuit to fall through.
    const s = await revocableStack()
    s.ownership.owner = 'user:someone-else'

    const dispatch = await renameOnTargetPath(
      s.deps,
      { sessionId: s.sessionId, name: 'agent tried', mutationId: 'op-2' },
      agentOf('agent-sess-7', firstAdminMemberId()),
      'outbox',
    )

    expect(dispatch.outcome).toBe('denied')
    expect(await s.nameNow()).toBeUndefined()
  })
})
