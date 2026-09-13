import { asSessionId, asUserId, firstAdminMemberId } from '@podium/model'
import { type Operation, parseOperation } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from '../../command-principal'
import { SuperagentService } from '../../modules/superagent'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { appRouter } from '../../router'
import { OPERATOR } from '../../test-support/capabilities'
import type { OperationKindDefinition, StepOutcome } from './kinds'

/**
 * THE OPERATION SURFACE, over the real router (POD-2154, closing G1 of the
 * wave-two review).
 *
 * `operations.active`, `history` and `cancel` had no test of any kind. Two
 * things about this file are deliberate:
 *
 *  - It goes through `appRouter.createCaller`, not the engine, because every
 *    claim here is about what the WIRE carries. The engine's own behaviour is
 *    unit-tested next door under a fake clock; nothing in that file can see
 *    whether the bytes a client receives are the bytes the store holds.
 *  - `active`'s answer is fed through `parseOperation` — the conformance parser
 *    from `@podium/protocol`. That is the framework plan's second acceptance
 *    line ("`operations.active` serves a payload that the conformance parser
 *    accepts"), and it was unverifiable before: `trpc.ts` reads the payload
 *    with a bare `JSON.parse`, deliberately, so the served bytes and the parser
 *    had no shared test point anywhere in the repo.
 */

const registries: SessionRegistry[] = []

async function harness() {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'operations-test' })
  registries.push(registry)
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  const caller = appRouter.createCaller({
    registry,
    repos,
    superagent,
    capability: OPERATOR,
    principal: userCommandPrincipal(firstAdminMemberId(), 'admin'),
  } as Parameters<typeof appRouter.createCaller>[0])
  /**
   * A MEMBER-GRADE CALLER over the same registry (PDM-294). `userCommandPrincipal`
   * mints a `worker` capability scoped to that person's own rows, which is what
   * `assertActionAuthorized` reads — so nothing decided by this caller can be
   * decided by the admin path.
   */
  const memberPrincipal = userCommandPrincipal(asUserId('user:ops-member'), 'member')
  const member = appRouter.createCaller({
    registry,
    repos,
    superagent,
    capability: memberPrincipal.capability,
    principal: memberPrincipal,
  } as Parameters<typeof appRouter.createCaller>[0])
  return { registry, caller, member, operations: registry.modules.operations }
}

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.dispose()
})

const done = async (): Promise<StepOutcome> => ({ state: 'done' })
/** A step that hands work outside this call, so the operation stays live. */
const blocks = async (): Promise<StepOutcome> => ({ state: 'running' })

function testKind(over: Partial<OperationKindDefinition> = {}): OperationKindDefinition {
  return {
    kind: 'test',
    exclusionGroup: 'lifecycle',
    plan: () => ({ steps: [{ id: 'first' }, { id: 'second' }] }),
    reconcile: (operation) => operation,
    runners: { first: { ensure: blocks }, second: { ensure: done } },
    ...over,
  } as OperationKindDefinition
}

describe('operations.active', () => {
  it('serves a payload the conformance parser accepts', async () => {
    const { caller, operations } = await harness()
    operations.kinds.register(testKind())
    const started = await operations.engine.start('test', undefined, { createdBy: 'user' })
    expect(started.started).toBe(true)

    const served = await caller.operations.active()
    // The acceptance line, made checkable: the bytes a client receives are an
    // operation by the one shared definition of what that word means.
    const parsed = parseOperation(served)
    expect(parsed).not.toBeNull()
    expect(parsed?.kind).toBe('test')
    expect(parsed?.state).toBe('running')
    expect(parsed?.steps?.map((s) => s.id)).toEqual(['first', 'second'])
  })

  it('answers null when nothing is live — the ordinary case', async () => {
    const { caller } = await harness()
    expect(await caller.operations.active()).toBeNull()
  })

  it('answers null once the operation has an outcome', async () => {
    const { caller, operations } = await harness()
    operations.kinds.register(testKind({ runners: { first: { ensure: done } } }))
    const started = await operations.engine.start('test')
    if (started.started) await operations.engine.whenSettled(started.operation.id)

    expect(await caller.operations.active()).toBeNull()
  })

  it('scopes to an exclusion group when asked', async () => {
    const { caller, operations } = await harness()
    operations.kinds.register(testKind())
    operations.kinds.register(
      testKind({
        kind: 'reindex',
        exclusionGroup: 'maintenance',
        plan: () => ({ steps: [{ id: 'first' }] }),
        runners: { first: { ensure: blocks } },
      }),
    )
    await operations.engine.start('test')
    await operations.engine.start('reindex')

    expect((await caller.operations.active({ group: 'maintenance' })) as Operation).toMatchObject({
      kind: 'reindex',
    })
    expect((await caller.operations.active({ group: 'lifecycle' })) as Operation).toMatchObject({
      kind: 'test',
    })
    expect(await caller.operations.active({ group: 'nothing-here' })).toBeNull()
  })

  it('serves a field this binary never invented, byte for byte (P8)', async () => {
    const { caller, registry, operations } = await harness()
    operations.kinds.register(testKind())
    await operations.engine.start('test')
    // What a NEWER server wrote before this one adopted its operation. The
    // endpoint must hand it back rather than re-shaping the operation on the
    // way out — the two ends are guaranteed to be different builds here,
    // because the web bundle is swapped during the operation it renders.
    const row = (await registry.sessionStore.operations.active())[0]
    if (!row) throw new Error('expected a live operation')
    await registry.sessionStore.operations.update({
      ...(JSON.parse(row.payload) as Operation),
      exclusionGroup: row.exclusionGroup,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      aFieldAddedNextYear: 'keep me',
    } as never)

    const served = (await caller.operations.active()) as Record<string, unknown>
    expect(served.aFieldAddedNextYear).toBe('keep me')
    expect(parseOperation(served)).not.toBeNull()
  })
  it('serves successor fields after a second engine transition (P8)', async () => {
    const { caller, registry, operations } = await harness()
    operations.kinds.register(testKind())
    const started = await operations.engine.start('test')
    if (!started.started) throw new Error('expected start')
    const id = started.operation.id
    await operations.engine.whenSettled(id)
    const store = registry.sessionStore.operations
    const row = (await store.get(id))!
    await store.update({ ...JSON.parse(row.payload), aFieldAddedNextYear: { text: 'keep me' } })
    for (const done of [1, 2]) {
      await operations.engine.recordProgress(id, 'first', { progress: { done, total: 3 } })
      const served = await caller.operations.active()
      expect(served).toMatchObject({ aFieldAddedNextYear: { text: 'keep me' },
        steps: [expect.objectContaining({ id: 'first', progress: { done, total: 3 } }), expect.anything()],
      })
    }
  })

})

describe('operations.history', () => {
  const finishThree = async (operations: Awaited<ReturnType<typeof harness>>['operations']) => {
    operations.kinds.register(
      testKind({
        plan: () => ({ steps: [{ id: 'first' }] }),
        runners: { first: { ensure: done } },
      }),
    )
    for (let i = 0; i < 3; i++) {
      const started = await operations.engine.start('test')
      if (started.started) await operations.engine.whenSettled(started.operation.id)
    }
  }

  it('lists finished operations, newest first, and every entry parses', async () => {
    const { caller, operations } = await harness()
    await finishThree(operations)

    const history = (await caller.operations.history()) as unknown[]
    expect(history).toHaveLength(3)
    for (const entry of history) expect(parseOperation(entry)).not.toBeNull()
    const created = history.map((e) => (e as Operation).createdAt ?? 0)
    expect([...created].sort((a, b) => b - a)).toEqual(created)
  })

  it('filters by kind', async () => {
    const { caller, operations } = await harness()
    await finishThree(operations)
    expect(await caller.operations.history({ kind: 'server-move' })).toEqual([])
    expect((await caller.operations.history({ kind: 'test' })) as unknown[]).toHaveLength(3)
  })

  it('honours the limit', async () => {
    const { caller, operations } = await harness()
    await finishThree(operations)
    expect((await caller.operations.history({ limit: 2 })) as unknown[]).toHaveLength(2)
  })

  it('is empty, not an error, before anything has ever run', async () => {
    const { caller } = await harness()
    expect(await caller.operations.history()).toEqual([])
  })
})

describe('operations action authorization', () => {
  it.each(['settleAsk', 'action'] as const)(
    '%s authorizes a managed target through the real machines ownership adapter',
    async (procedure) => {
      const { registry, caller, operations } = await harness()
      const targetMachineId = registry.modules.machines.ensureHostMachine('Target machine')
      const onAction = vi.fn(async () => ({ outcome: 'recovered' }))
      operations.kinds.register(
        testKind({
          plan: () => ({
            steps: [{ id: 'first' }],
            details: { targetMachineId },
            awaiting: [{ id: 'recover', required: true }],
          }),
          runners: { first: { ensure: done } },
          onAction,
        }),
      )
      const started = await operations.engine.start('test')
      if (!started.started) throw new Error('expected a live operation')

      const input = { id: started.operation.id, actionId: 'recover' }
      const result =
        procedure === 'settleAsk'
          ? await caller.operations.settleAsk(input)
          : await caller.operations.action(input)

      expect(result).toEqual({ handled: true, result: { outcome: 'recovered' } })
      expect(onAction).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: 'recover', mode: 'engine' }),
      )
    },
  )
})

describe('operations.cancel', () => {
  it('cancels while the step in flight says it is safe', async () => {
    const { caller, operations } = await harness()
    operations.kinds.register(
      testKind({
        plan: () => ({ steps: [{ id: 'first' }] }),
        runners: { first: { ensure: blocks, reversible: true } },
      }),
    )
    const started = await operations.engine.start('test')
    if (!started.started) throw new Error('expected a live operation')

    expect(await caller.operations.cancel({ id: started.operation.id })).toMatchObject({
      canceled: true,
    })
    expect(await caller.operations.active()).toBeNull()
  })

  it('returns a refusal rather than throwing, and names the step', async () => {
    const { caller, operations } = await harness()
    operations.kinds.register(testKind())
    const started = await operations.engine.start('test')
    if (!started.started) throw new Error('expected a live operation')

    // "This can't be canceled now, it will finish or fail" is a sentence the
    // panel renders — so it arrives as a value, not as a 500.
    expect(await caller.operations.cancel({ id: started.operation.id })).toEqual({
      canceled: false,
      refused: 'irreversible',
      step: 'first',
    })
    expect(await caller.operations.active()).not.toBeNull()
  })

  it('refuses an operation that never existed', async () => {
    const { caller } = await harness()
    expect(await caller.operations.cancel({ id: 'op_nope' })).toEqual({
      canceled: false,
      refused: 'not-found',
    })
  })

  it('refuses one that already finished', async () => {
    const { caller, operations } = await harness()
    operations.kinds.register(
      testKind({
        plan: () => ({ steps: [{ id: 'first' }] }),
        runners: { first: { ensure: done } },
      }),
    )
    const started = await operations.engine.start('test')
    if (!started.started) throw new Error('expected a live operation')
    await operations.engine.whenSettled(started.operation.id)

    expect(await caller.operations.cancel({ id: started.operation.id })).toEqual({
      canceled: false,
      refused: 'already-finished',
    })
  })
})

/**
 * THE ADMIN FLOOR ON `cancel` (PDM-294).
 *
 * All three operation contracts declare `roleFloor: 'admin'` with
 * `machineVerb: 'manage'`; `settleAsk` and `action` asked and `cancel` did not.
 * Both arms are asserted from the same fixture — a member refused, and the SAME
 * call succeeding for an admin — because a gate that refused everyone would
 * satisfy the refusal on its own (false-green catalogue entry 1).
 */
describe('operations.cancel is behind the floor its contract declares', () => {
  const liveOperation = async () => {
    const h = await harness()
    h.operations.kinds.register(
      testKind({
        plan: () => ({ steps: [{ id: 'first' }] }),
        runners: { first: { ensure: blocks, reversible: true } },
      }),
    )
    const started = await h.operations.engine.start('test')
    if (!started.started) throw new Error('expected a live operation')
    return { ...h, id: started.operation.id }
  }

  it('refuses a member, naming the grade', async () => {
    const { member, id } = await liveOperation()
    await expect(member.operations.cancel({ id })).rejects.toThrow(
      /operation recovery requires an admin account/,
    )
  })

  it('leaves the operation running when it refuses', async () => {
    const { member, caller, id } = await liveOperation()
    await expect(member.operations.cancel({ id })).rejects.toThrow()
    // The refusal is not merely a thrown message: the work it was asked to tear
    // down is still there.
    expect(await caller.operations.active()).toMatchObject({ id })
  })

  it('still cancels for an admin', async () => {
    const { caller, id } = await liveOperation()
    expect(await caller.operations.cancel({ id })).toMatchObject({ canceled: true })
  })
})

/**
 * AN AGENT IS REFUSED ALL THREE, WHOEVER IT ACTS FOR (PDM-299).
 *
 * ---------------------------------------------------------------------------
 * WHY THE OBVIOUS TEST WOULD HAVE BEEN WORTHLESS HERE
 * ---------------------------------------------------------------------------
 *
 * "An agent is refused `operations.action`" passed in this file before PDM-299
 * — and it passed for a reason that had nothing to do with any rule. The check
 * was `ctx.principal.capability.role !== 'admin'`, and no agent capability can
 * carry `admin`: `relay.ts`'s `capabilityForLiveSession` and
 * `SessionAuthz.capabilityForSession` hard-code `role: 'worker'` across six
 * return statements between them. The comparison could never be satisfied, so
 * deleting the rule outright would not have reddened such a test. That is
 * false-green catalogue entry 14 in its purest form: the FIXTURE decided, not
 * the gate.
 *
 * So the discriminating principal below carries `role: 'admin'` on its
 * capability — a value no mint produces, constructed deliberately. Against the
 * old line it is PERMITTED and these tests fail; against
 * `adminFloorRefusal` it is refused because it is an agent.
 *
 * ---------------------------------------------------------------------------
 * AND NO AGENT CAN ACTUALLY ROUTE HERE, WHICH IS WHY THIS IS A UNIT OF THE RULE
 * ---------------------------------------------------------------------------
 *
 * All three operation contracts declare `exposure: ['trpc']` and `operations`
 * has no entry in `RELAY_ALLOWED`, so there is no transport by which an agent
 * reaches these procedures — the family's pre-PDM-299 refusal of every agent was
 * refusing nobody. These tests therefore pin the RULE at the door rather than a
 * reachable behaviour, and they are the thing that will still be true on the day
 * `PDM-297` joins this family to the contract table and something else changes
 * how it is served.
 */
describe("an agent does not inherit its human's admin grade (PDM-299)", () => {
  /** A live agent session delegating from the instance's first admin. */
  const adminsAgent = async () => {
    const h = await harness()
    h.operations.kinds.register(
      testKind({
        plan: () => ({ steps: [{ id: 'first' }] }),
        runners: { first: { ensure: blocks, reversible: true } },
      }),
    )
    const started = await h.operations.engine.start('test')
    if (!started.started) throw new Error('expected a live operation')
    // THE DISCRIMINATING CAPABILITY: an actorSessionId (so the principal resolves
    // as an agent) AND `role: 'admin'` (so a gate reading the capability lets it
    // straight through). `onBehalfOf` is the first admin, whose store row really
    // does say `admin` — the delegation resolves to a genuine administrator.
    const capability = {
      role: 'admin' as const,
      scope: { kind: 'all' as const },
      actorSessionId: asSessionId('sess-ops-agent'),
      onBehalfOf: firstAdminMemberId(),
    }
    const agent = appRouter.createCaller({
      registry: h.registry,
      repos: new RepoRegistry(h.registry, h.registry.sessionStore),
      superagent: await SuperagentService.create(
        h.registry.modules,
        new RepoRegistry(h.registry, h.registry.sessionStore),
        h.registry.sessionStore,
      ),
      capability,
      principal: {
        kind: 'agent' as const,
        agentSessionId: asSessionId('sess-ops-agent'),
        onBehalfOf: firstAdminMemberId(),
        capability,
        chain: [],
      },
    } as Parameters<typeof appRouter.createCaller>[0])
    return { ...h, agent, id: started.operation.id }
  }

  const NAMES = ['cancel', 'settleAsk', 'action'] as const

  it.each(NAMES)("operations.%s refuses an ADMIN'S agent, naming the delegation", async (proc) => {
    const { agent, id } = await adminsAgent()
    const call =
      proc === 'cancel'
        ? agent.operations.cancel({ id })
        : proc === 'settleAsk'
          ? agent.operations.settleAsk({ id, actionId: 'anything' })
          : agent.operations.action({ id, actionId: 'anything' })
    await expect(call).rejects.toThrow(
      /operation recovery requires an admin account — and an agent does not inherit its human's admin grade/,
    )
  })

  it('leaves the operation running when it refuses an agent', async () => {
    // Entry 4's question asked of this gate: the refusal is not merely a thrown
    // string, the work it was asked to tear down is still there.
    const { agent, caller, id } = await adminsAgent()
    await expect(agent.operations.cancel({ id })).rejects.toThrow()
    expect(await caller.operations.active()).toMatchObject({ id })
  })

  it('and the SAME human, acting directly, is still served — the counterfactual', async () => {
    // Without this, every assertion above is satisfied by a gate that refuses
    // everyone. The delegating human here is the very account the agent acts
    // for, so the only difference between the two calls is the delegation.
    const { caller, id } = await adminsAgent()
    expect(await caller.operations.cancel({ id })).toMatchObject({ canceled: true })
  })
})
