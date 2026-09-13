/**
 * A SESSION CANNOT BE CREATED WITHOUT SAYING WHO IT IS FOR (PDM-276, the last of
 * B1's ownerless-creation paths).
 *
 * WHAT WAS WRONG. `SessionStart.create` ended its owner chain with
 * `?? (await firstAdminMemberId(store))`, and B1's comment beside it argued the
 * term was harmless because "no production caller" omits an owner. One does.
 * POD-3902 makes `spawnOwner()` answer "nobody" for a system principal
 * deliberately — ADR 3 Amendment 1 D17.5/D21.2, "representable none, never
 * defaulted to an operator or to a row's owner" — and three conditional spreads
 * between there and `create()` drop the key when it is falsy
 * (`issues/registry.ts`, `issues/service/workflow.ts`, `relay.ts`'s
 * `spawnSession`). So an unattributable spawn arrived here with no owner and
 * left owned by the earliest-enrolled admin. Not merely mis-READ: `create()`
 * builds the daemon binding FROM the value it invented, so the run was also
 * BOUND to and attributed to that person.
 *
 * THE PROOF THAT IT WAS REAL IS IN THE HISTORY, NOT IN THIS FILE. The commit
 * that introduced this file contained only the witness, and it FAILED —
 * `expected 'mem_3JFczcvGnWIaTbMGb6Z0Wl2mPrn' not to be
 * 'mem_3JFczcvGnWIaTbMGb6Z0Wl2mPrn'` — on a real store through the real
 * `createSession`. That red is bisectable and is the evidence the defect
 * existed; what follows is the evidence it cannot come back.
 *
 * WHY THE ORIGINAL ASSERTION IS GONE, which is the honest part. The fix made the
 * defect UNREPRESENTABLE rather than merely wrong: `SessionOwnerInput` requires
 * either an explicit `ownerUserId` or a `binding`, so the call the old test made
 * no longer compiles. A runtime assertion about it would now be asserting
 * something the type system forbids anyone from writing. The guarantee therefore
 * moved from an assertion to the compiler, and this file pins BOTH halves of it:
 * the compile-time half below, and the two runtime holes the type cannot close.
 *
 * NOTHING IN A VITEST RUN TYPECHECKS (false-green catalogue shape 3). The
 * `@ts-expect-error` claim below is inert in this lane and is only witnessed by
 * `bun run --filter @podium/server typecheck`. That is stated here so a green
 * services shard is not read as evidence for it.
 *
 * WHY THE EXISTING POD-3902 TEST NEVER CAUGHT THIS, worth copying rather than
 * the assertion. `issues/service/multi-user.test.ts` has `it('leaves the owner
 * UNSET when no human initiated the spawn, rather than inventing the task's')`,
 * and it is a correct test OF ITS OWN SEAM: it asserts `spawns[0]?.ownerUserId`
 * is `undefined` against a RECORDING `spawnSession` port. The defect lived one
 * layer BELOW that port, so the mock recorded the absence faithfully while the
 * real port substituted a person. Catalogue shapes 19 and 20 — an instrument
 * check mistaken for a claim check, and a real rule that nothing witnesses
 * end-to-end.
 */

import { asSessionId, asUserId, firstAdminMemberId } from '@podium/model'
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

describe('an unattributable session is refused, never assigned to the first admin', () => {
  it('createSession without an owner or a binding does not COMPILE', async () => {
    const reg = await makeRegistry()

    // THE STRUCTURAL CLAIM, and the only instrument that can see it is the
    // compiler. `@ts-expect-error` is self-verifying in the right direction: if
    // `ownerUserId` ever goes back to being optional, this line stops erroring
    // and the TYPECHECK fails on the unused directive. It is not evidence in a
    // vitest run — see the file header.
    // @ts-expect-error — the claim: create() refuses an input that names no human.
    const refused = reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/r/w' })
    // The promise is still created, so settle it rather than leaking a rejection.
    await refused.catch(() => undefined)

    // NON-VACUITY for the file as a whole: the well-formed call DOES work, so
    // the tests below are not passing because session creation is broken.
    const owner = await firstAdminMemberId(reg.sessionStore)
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/w',
      ownerUserId: owner,
    })
    const row = (await reg.sessionStore.sessions.loadSessions()).find((r) => r.id === sessionId)
    expect(row?.ownerUserId).toBe(owner)
  })

  it('a binding whose human does not resolve is refused, not filled in', async () => {
    const reg = await makeRegistry()
    const admin = await firstAdminMemberId(reg.sessionStore)

    // THE RUNTIME HOLE THE TYPE CANNOT CLOSE. The `binding` arm satisfies the
    // compiler, but an AGENT principal reaches its human through its parent
    // session's owner, and that lookup answers undefined for a parent that does
    // not exist. This is the same absence the deleted fallback used to fill.
    await expect(
      reg.modules.sessions.createSession({
        agentKind: 'shell',
        cwd: '/r/w',
        binding: { principal: { kind: 'agent', parentBindingId: asSessionId('sess_not_a_session') } },
      }),
    ).rejects.toThrow(/must belong to a human/)

    // AND IT REFUSED RATHER THAN QUIETLY SUCCEEDING AS SOMEBODY. Without this,
    // a future change that swallows the throw and falls back would still satisfy
    // the rejects assertion above by throwing somewhere else entirely.
    const rows = await reg.sessionStore.sessions.loadSessions()
    expect(rows.filter((r) => r.ownerUserId === admin)).toHaveLength(0)
    expect(rows).toHaveLength(0)
  })

  it('an issue spawn with no initiating human is refused at the relay seam', async () => {
    const reg = await makeRegistry()

    // The production shape, one layer up: this is exactly what
    // `issues/registry.ts` emits once `spawnOwner()` has answered "nobody" and
    // every hop between has dropped the key. It used to reach `create()` and
    // come back as the admin's session.
    await expect(
      reg.issues.addSession(
        (await reg.issues.create({ repoPath: '/r', title: 'Nobody started this', startNow: false }))
          .id,
        'shell',
        { spawnedBy: 'issue:x' },
      ),
    ).rejects.toThrow()

    const rows = await reg.sessionStore.sessions.loadSessions()
    expect(rows).toHaveLength(0)
  })

  it('a system principal really does resolve to no human, so the chain above is reachable', async () => {
    // The precondition, pinned beside the claims it feeds. If this ever starts
    // returning a person, the tests above go green for a reason that has nothing
    // to do with the fallback, and the next reader should be told so here rather
    // than discovering it in `command-principal.ts` — whose own interface doc
    // states the rule this file enforces: a system principal "has NO human and
    // must never be assigned one" (ADR 3 Amendment 1 D21).
    expect(onBehalfOfUser({ kind: 'system', job: 'boot-reconcile' })).toBeNull()
    // Pin the OTHER two arms too, so "resolves to no human" cannot silently
    // become true of everybody (catalogue shape 19: pin the property the
    // subject is relied upon for, next to the assertion).
    const human = asUserId('u_a_real_person')
    expect(onBehalfOfUser({ kind: 'user', user: human, capability: { role: 'admin', scope: { kind: 'all' } } })).toBe(human)
  })
})
