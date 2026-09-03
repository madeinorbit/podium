import { FIRST_ADMIN_USER_ID } from '@podium/model'
import { type Operation, parseOperation } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
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

function harness() {
  const registry = SessionRegistry.create(undefined, undefined, { instanceId: 'operations-test' })
  registries.push(registry)
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = SuperagentService.create(registry.modules, repos, registry.sessionStore)
  const caller = appRouter.createCaller({
    registry,
    repos,
    superagent,
    capability: OPERATOR,
    principal: userCommandPrincipal(FIRST_ADMIN_USER_ID, 'admin'),
  } as Parameters<typeof appRouter.createCaller>[0])
  return { registry, caller, operations: registry.modules.operations }
}

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
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
    const { caller, operations } = harness()
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
    const { caller } = harness()
    expect(await caller.operations.active()).toBeNull()
  })

  it('answers null once the operation has an outcome', async () => {
    const { caller, operations } = harness()
    operations.kinds.register(testKind({ runners: { first: { ensure: done } } }))
    const started = await operations.engine.start('test')
    if (started.started) await operations.engine.whenSettled(started.operation.id)

    expect(await caller.operations.active()).toBeNull()
  })

  it('scopes to an exclusion group when asked', async () => {
    const { caller, operations } = harness()
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
    const { caller, registry, operations } = harness()
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
})

describe('operations.history', () => {
  const finishThree = async (operations: ReturnType<typeof harness>['operations']) => {
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
    const { caller, operations } = harness()
    await finishThree(operations)

    const history = (await caller.operations.history()) as unknown[]
    expect(history).toHaveLength(3)
    for (const entry of history) expect(parseOperation(entry)).not.toBeNull()
    const created = history.map((e) => (e as Operation).createdAt ?? 0)
    expect([...created].sort((a, b) => b - a)).toEqual(created)
  })

  it('filters by kind', async () => {
    const { caller, operations } = harness()
    await finishThree(operations)
    expect(await caller.operations.history({ kind: 'server-move' })).toEqual([])
    expect((await caller.operations.history({ kind: 'test' })) as unknown[]).toHaveLength(3)
  })

  it('honours the limit', async () => {
    const { caller, operations } = harness()
    await finishThree(operations)
    expect((await caller.operations.history({ limit: 2 })) as unknown[]).toHaveLength(2)
  })

  it('is empty, not an error, before anything has ever run', async () => {
    const { caller } = harness()
    expect(await caller.operations.history()).toEqual([])
  })
})

describe('operations.cancel', () => {
  it('cancels while the step in flight says it is safe', async () => {
    const { caller, operations } = harness()
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
    const { caller, operations } = harness()
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
    const { caller } = harness()
    expect(await caller.operations.cancel({ id: 'op_nope' })).toEqual({
      canceled: false,
      refused: 'not-found',
    })
  })

  it('refuses one that already finished', async () => {
    const { caller, operations } = harness()
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
