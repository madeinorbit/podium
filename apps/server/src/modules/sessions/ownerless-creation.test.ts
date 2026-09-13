/**
 * CREATING A SESSION WITHOUT SAYING WHO IT IS FOR HANDS IT TO THE EARLIEST ADMIN
 * (PDM-276, the last of B1's ownerless-creation paths).
 *
 * `SessionStart.create` still ends its owner chain with
 *
 *     bindingOwner ?? input.ownerUserId ?? (await firstAdminMemberId(store))
 *
 * and B1's own comment beside it argues the last term is harmless because "no
 * production caller" omits an owner. THAT ARGUMENT IS WRONG, and this file is
 * the witness. POD-3902 deliberately produces an absent owner — `spawnOwner()`
 * returns `undefined` for a system principal, on the stated ground that
 * "recording that is strictly better than substituting a person". The value then
 * travels through three conditional spreads that each omit the key when it is
 * falsy (`issues/registry.ts`, `issues/service/workflow.ts`, `relay.ts`'s
 * `spawnSession`) and arrives here, where it is substituted for a person after
 * all — and not merely recorded: `create()` builds the daemon binding FROM the
 * value it just invented, so the run is owned by, bound to and attributed to
 * whoever enrolled first.
 *
 * WHY THE EXISTING POD-3902 TEST DOES NOT CATCH THIS, because that is the part
 * worth copying rather than the assertion. `issues/service/multi-user.test.ts`
 * has `it('leaves the owner UNSET when no human initiated the spawn, rather than
 * inventing the task's')`, and it is a correct test of its own seam: it asserts
 * `spawns[0]?.ownerUserId` is `undefined` against a RECORDING `spawnSession`
 * port. The defect lives one layer BELOW that port. The mock records the absence
 * faithfully; the real port substitutes. So the rule its comment cites — ADR 3
 * Amendment 1 D17.5/D21.2, "representable none, never defaulted to an operator
 * or to a row's owner" — is asserted at the one boundary where it still holds.
 * False-green catalogue shapes 19 and 20: an instrument check mistaken for a
 * claim check, and a real rule that nothing witnesses end-to-end.
 *
 * WHAT IS PROVED HERE BY EXECUTION, AND WHAT IS NOT. The two tests below run the
 * real store and the real `SessionStart.create` — nothing is mocked, and the
 * owner is read back from the DURABLE ROW rather than from a return value. The
 * three intermediate hops are established by READING those files, not by running
 * them; they are plain conditional spreads over the same optional field, and the
 * second test pins the precondition (a system principal really does resolve to
 * no human) so the chain's two ends are both executed even though its middle is
 * read.
 */

import { asUserId, firstAdminMemberId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { onBehalfOfUser } from '../../command-principal'
import { SessionRegistry } from '../../relay'

const registries: SessionRegistry[] = []

afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

async function makeRegistry(): Promise<SessionRegistry> {
  const reg = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registries.push(reg)
  return reg
}

describe('an unattributable session must not become the earliest admin’s', () => {
  it('createSession with neither an owner nor a binding is handed to the earliest admin', async () => {
    const reg = await makeRegistry()
    const store = reg.sessionStore

    // NON-VACUITY, both halves. There must BE an earliest admin for the
    // substitution to be observable at all, and a second real member so that
    // "the admin" is visibly one person among several rather than the only
    // answer the fixture could have produced (catalogue shape 14).
    const admin = await firstAdminMemberId(store)
    expect(admin).toBeDefined()
    const second = asUserId('u_someone_else')
    expect(second).not.toBe(admin)

    // THE PRODUCTION CONDITION, reproduced exactly: no `ownerUserId`, no
    // `binding`. This is what `relay.ts`'s `spawnSession` emits once
    // `...(o.ownerUserId ? { ownerUserId: o.ownerUserId } : {})` has dropped the
    // key, which is what it does whenever `spawnOwner()` answered "nobody".
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/w',
    })

    const row = (await store.sessions.loadSessions()).find((r) => r.id === sessionId)
    expect(row).toBeDefined()

    // THE CLAIM. A run nobody started must not be recorded as somebody's. This
    // is the assertion that fails today, and it fails with the admin's id in the
    // message — which is the whole point: the failure NAMES the person the
    // instance silently handed the session to.
    expect(row?.ownerUserId).not.toBe(admin)
  })

  it('a system principal really does resolve to no human, so the chain above is reachable', async () => {
    // The precondition, pinned next to the claim it feeds. If this ever starts
    // returning a person, the test above is still green for a reason that has
    // nothing to do with the fallback, and the next reader should be told so
    // here rather than discovering it in `command-principal.ts`, whose own
    // interface doc states the rule this whole file exists to enforce: a system
    // principal "has NO human and must never be assigned one" (ADR 3
    // Amendment 1 D21).
    expect(onBehalfOfUser({ kind: 'system', job: 'boot-reconcile' })).toBeNull()
  })
})
