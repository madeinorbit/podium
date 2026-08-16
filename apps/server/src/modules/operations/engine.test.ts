import type { Operation } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it, vi } from 'vitest'
import { runDrizzleMigrations } from '../../migrations'
import { DRIZZLE_MIGRATIONS } from '../../migrations/drizzle-manifest.generated'
import {
  type OperationClock,
  OperationEngine,
  type OperationTimerHandle,
  STALLED_ERROR_CODE,
  UNKNOWN_KIND_ERROR_CODE,
} from './engine'
import {
  type OperationKindDefinition,
  OperationKindRegistry,
  type StepOutcome,
  type StepRunner,
} from './kinds'
import { OperationStore, type PersistedOperation } from './store'

/**
 * The engine's behaviour, all of it under a FAKE CLOCK. Nothing here sleeps:
 * a deadline fires because the test moved time, which is the same reason it
 * fires in production (§3.3) and the only way to assert on it without a
 * `setTimeout` before an assertion — a bug in this repo's unit lane.
 */

function fakeClock() {
  let now = 0
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  const clock: OperationClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const handle = ++seq
      pending.set(handle, { at: now + ms, fn })
      return handle
    },
    clearTimeout: (handle: OperationTimerHandle) => {
      pending.delete(handle as number)
    },
  }
  return {
    clock,
    armed: () => pending.size,
    /** Move time forward, firing anything that comes due on the way. */
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (!due || due[1].at > target) break
        pending.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = target
    },
  }
}

function harness() {
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
  const store = new OperationStore(db)
  const registry = new OperationKindRegistry()
  const clock = fakeClock()
  let minted = 0
  const engine = new OperationEngine({
    store,
    registry,
    clock: clock.clock,
    newId: () => `op_${++minted}`,
  })
  return { store, registry, engine, clock }
}

const done = async (): Promise<StepOutcome> => ({ state: 'done' })
/** A step that hands work to something outside this call and waits (§3.3). */
const blocks = async (): Promise<StepOutcome> => ({ state: 'running' })

const runner = (ensure: StepRunner['ensure'], reversible?: boolean): StepRunner => ({
  ensure,
  ...(reversible === undefined ? {} : { reversible }),
})

function testKind(
  over: Partial<OperationKindDefinition> = {},
): OperationKindDefinition<unknown, unknown> {
  return {
    kind: 'test',
    exclusionGroup: 'lifecycle',
    plan: () => ({ steps: [{ id: 'first' }, { id: 'second' }] }),
    reconcile: (operation) => operation,
    runners: { first: runner(done), second: runner(done) },
    ...over,
  } as OperationKindDefinition<unknown, unknown>
}

const step = (operation: Operation | null | undefined, id: string) =>
  (operation?.steps ?? []).find((s) => s.id === id)

describe('starting an operation', () => {
  it('runs the plan through, in order, and lands on done', async () => {
    const { registry, engine, store } = harness()
    const order: string[] = []
    registry.register(
      testKind({
        runners: {
          first: runner(async () => {
            order.push('first')
            return { state: 'done' }
          }),
          second: runner(async () => {
            order.push('second')
            return { state: 'done' }
          }),
        },
      }),
    )

    const result = await engine.start('test')
    expect(result).toMatchObject({ started: true })
    expect(order).toEqual(['first', 'second'])
    const row = store.get('op_1')
    expect(row?.state).toBe('done')
    expect(row?.finishedAt).not.toBeNull()
    expect(row?.operation?.steps?.map((s) => s.state)).toEqual(['done', 'done'])
  })

  it('stops at the first step that hands work outside, and waits there', async () => {
    const { registry, engine, store } = harness()
    const second = vi.fn(done)
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(second) } }))

    await engine.start('test')
    expect(store.get('op_1')?.state).toBe('running')
    expect(step(store.get('op_1')?.operation, 'first')?.state).toBe('running')
    expect(second).not.toHaveBeenCalled()
  })

  it('counts the attempt and stamps the step before the runner is called', async () => {
    const { registry, engine, store } = harness()
    registry.register(
      testKind({
        runners: {
          first: runner(async ({ step: current }) => {
            // What the runner is handed is already persisted: a crash here
            // must not lose the fact that the step was begun.
            expect(current.state).toBe('running')
            expect(current.attempts).toBe(1)
            return { state: 'running' }
          }),
          second: runner(done),
        },
      }),
    )
    await engine.start('test')
    expect(step(store.get('op_1')?.operation, 'first')?.startedAt).toBe(0)
  })

  it('refuses a kind it does not know, rather than throwing', async () => {
    const { engine } = harness()
    expect(await engine.start('server-move')).toEqual({ started: false, refused: 'unknown-kind' })
  })

  it('records who asked', async () => {
    const { registry, engine, store } = harness()
    registry.register(testKind())
    await engine.start('test', undefined, { createdBy: 'user' })
    expect(store.get('op_1')?.operation?.createdBy).toBe('user')
  })

  it('hands the kind the context it was started with, unread', async () => {
    const { registry, engine } = harness()
    const seen: unknown[] = []
    registry.register(
      testKind({
        plan: (context) => {
          seen.push(context)
          return { steps: [{ id: 'first' }] }
        },
        runners: {
          first: runner(async ({ context }) => {
            seen.push(context)
            return { state: 'done' }
          }),
        },
      }),
    )
    const context = { fleet: ['vmi'] }
    await engine.start('test', context)
    expect(seen).toEqual([context, context])
  })
})

describe('single-flight (P6)', () => {
  it('tells the second caller who is already holding the group', async () => {
    const { registry, engine } = harness()
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))

    await engine.start('test')
    expect(await engine.start('test')).toEqual({ started: false, alreadyRunning: 'op_1' })
  })

  it('holds even when two starts race through the async plan window', async () => {
    const { registry, engine, store } = harness()
    registry.register(
      testKind({
        plan: async () => {
          await Promise.resolve()
          return { steps: [{ id: 'first' }] }
        },
        runners: { first: runner(blocks) },
      }),
    )

    const [a, b] = await Promise.all([engine.start('test'), engine.start('test')])
    const outcomes = [a, b]
    expect(outcomes.filter((r) => r.started)).toHaveLength(1)
    expect(outcomes.find((r) => !r.started)).toMatchObject({ alreadyRunning: 'op_1' })
    expect(store.history('test')).toHaveLength(1)
  })

  it('releases the group the moment the operation reaches an outcome', async () => {
    const { registry, engine } = harness()
    registry.register(testKind())
    await engine.start('test')
    expect(await engine.start('test')).toMatchObject({ started: true })
  })

  it('does not let one group block another', async () => {
    const { registry, engine } = harness()
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))
    registry.register(
      testKind({
        kind: 'reindex',
        exclusionGroup: 'maintenance',
        plan: () => ({ steps: [{ id: 'first' }] }),
        runners: { first: runner(blocks) },
      }),
    )
    await engine.start('test')
    expect(await engine.start('reindex')).toMatchObject({ started: true })
  })
})

describe('progress and liveness (P4)', () => {
  it('stamps the heartbeat on every accepted report', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))
    await engine.start('test')

    clock.advance(4000)
    await engine.recordProgress('op_1', 'first', { progress: { done: 1, total: 3 } })

    const row = store.get('op_1')
    expect(step(row?.operation, 'first')?.lastProgressAt).toBe(4000)
    expect(step(row?.operation, 'first')?.progress).toEqual({ done: 1, total: 3 })
    expect(row?.updatedAt).toBe(4000)
  })

  it('carries on with the plan when a report finishes the step', async () => {
    const { registry, engine, store } = harness()
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))
    await engine.start('test')

    await engine.recordProgress('op_1', 'first', { state: 'done' })
    expect(store.get('op_1')?.state).toBe('done')
  })

  it('ignores a report for a step that has already finished', async () => {
    const { registry, engine, store } = harness()
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(blocks) } }))
    await engine.start('test')
    await engine.recordProgress('op_1', 'first', { state: 'done' })

    await engine.recordProgress('op_1', 'first', { detail: 'late' })
    expect(step(store.get('op_1')?.operation, 'first')?.detail).toBeUndefined()
  })
})

describe('deadlines fire on a timer, not on a poll (§3.3)', () => {
  const stalling = (over: Partial<OperationKindDefinition> = {}) =>
    testKind({
      plan: () => ({ steps: [{ id: 'first' }] }),
      runners: { first: runner(blocks) },
      deadlines: { first: { silenceMs: 1000 } },
      ...over,
    })

  it('stalls the step visibly, retries it once, then fails the operation', async () => {
    const { registry, engine, store, clock } = harness()
    const ensure = vi.fn(blocks)
    registry.register(stalling({ runners: { first: runner(ensure) } }))
    await engine.start('test')
    expect(ensure).toHaveBeenCalledTimes(1)

    clock.advance(1000)
    await engine.whenSettled('op_1')
    const retried = step(store.get('op_1')?.operation, 'first')
    expect(retried?.stalls).toBe(1)
    expect(retried?.attempts).toBe(2)
    expect(ensure).toHaveBeenCalledTimes(2)
    expect(store.get('op_1')?.state).toBe('running')

    clock.advance(1000)
    await engine.whenSettled('op_1')
    const row = store.get('op_1')
    expect(row?.state).toBe('failed')
    expect(row?.operation?.error?.code).toBe(STALLED_ERROR_CODE)
    expect(step(row?.operation, 'first')?.state).toBe('failed')
    expect(ensure).toHaveBeenCalledTimes(2)
  })

  it('lets progress push the deadline out', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(stalling())
    await engine.start('test')

    clock.advance(600)
    await engine.recordProgress('op_1', 'first', { detail: 'still going' })
    clock.advance(600)
    await engine.whenSettled('op_1')
    expect(step(store.get('op_1')?.operation, 'first')?.state).toBe('running')

    clock.advance(500)
    await engine.whenSettled('op_1')
    expect(step(store.get('op_1')?.operation, 'first')?.stalls).toBe(1)
  })

  it('records a stall that recovered instead of erasing it', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(stalling())
    await engine.start('test')

    clock.advance(1000)
    await engine.whenSettled('op_1')
    await engine.recordProgress('op_1', 'first', { state: 'done' })

    const finished = step(store.get('op_1')?.operation, 'first')
    expect(finished?.state).toBe('done')
    expect(finished?.stalls).toBe(1)
    expect(store.get('op_1')?.state).toBe('done')
  })

  it('fails a step that overruns its total budget, with no retry', async () => {
    const { registry, engine, store, clock } = harness()
    const ensure = vi.fn(blocks)
    registry.register(
      stalling({ runners: { first: runner(ensure) }, deadlines: { first: { totalMs: 500 } } }),
    )
    await engine.start('test')

    clock.advance(500)
    await engine.whenSettled('op_1')
    expect(store.get('op_1')?.state).toBe('failed')
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(step(store.get('op_1')?.operation, 'first')?.stalls).toBeUndefined()
  })

  it('arms nothing for a step whose kind declares no budget', async () => {
    const { registry, engine, clock } = harness()
    registry.register(stalling({ deadlines: {} }))
    await engine.start('test')
    expect(clock.armed()).toBe(0)
  })

  it('drops the timer when the operation ends', async () => {
    const { registry, engine, clock } = harness()
    registry.register(stalling())
    await engine.start('test')
    expect(clock.armed()).toBe(1)
    await engine.recordProgress('op_1', 'first', { state: 'done' })
    expect(clock.armed()).toBe(0)
  })
})

describe('failure', () => {
  it('fails the operation when a runner reports failure', async () => {
    const { registry, engine, store } = harness()
    registry.register(
      testKind({
        runners: {
          first: runner(async () => ({
            state: 'failed',
            error: { code: 'machine-dirty-checkout', places: ['vmi'] },
          })),
          second: runner(done),
        },
      }),
    )
    await engine.start('test')
    const row = store.get('op_1')
    expect(row?.state).toBe('failed')
    expect(row?.operation?.error).toMatchObject({ code: 'machine-dirty-checkout' })
    expect(step(row?.operation, 'second')?.state).toBe('pending')
  })

  it('turns a runner that throws into a failed step, not a crashed server', async () => {
    const { registry, engine, store } = harness()
    registry.register(
      testKind({
        runners: {
          first: runner(async () => {
            throw new Error('ssh: connection refused')
          }),
          second: runner(done),
        },
      }),
    )
    await engine.start('test')
    const row = store.get('op_1')
    expect(row?.state).toBe('failed')
    expect(row?.operation?.error?.code).toBe('step-threw')
    expect(row?.operation?.error?.detail).toContain('connection refused')
  })

  it('fails an operation whose plan names a step with no runner', async () => {
    const { registry, engine, store } = harness()
    registry.register(testKind({ plan: () => ({ steps: [{ id: 'ghost' }] }) }))
    await engine.start('test')
    expect(store.get('op_1')?.operation?.error?.code).toBe('no-runner')
  })
})

describe('cancel is gated on reversibility (§3.2)', () => {
  it('cancels while the step in flight says it is safe', async () => {
    const { registry, engine, store } = harness()
    registry.register(testKind({ runners: { first: runner(blocks, true), second: runner(done) } }))
    await engine.start('test')

    expect(engine.cancel('op_1')).toMatchObject({ canceled: true })
    expect(store.get('op_1')?.state).toBe('canceled')
    expect(store.get('op_1')?.finishedAt).not.toBeNull()
  })

  it('refuses once an irreversible step is in flight, and names it', async () => {
    const { registry, engine, store } = harness()
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))
    await engine.start('test')

    expect(engine.cancel('op_1')).toEqual({
      canceled: false,
      refused: 'irreversible',
      step: 'first',
    })
    expect(store.get('op_1')?.state).toBe('running')
  })

  it('treats an unmarked runner as irreversible', async () => {
    // The dangerous steps are the ones nobody remembers to mark.
    const { registry, engine } = harness()
    registry.register(
      testKind({ runners: { first: runner(blocks, undefined), second: runner(done) } }),
    )
    await engine.start('test')
    expect(engine.cancel('op_1')).toMatchObject({ refused: 'irreversible' })
  })

  it('refuses an operation that never existed, or already ended', async () => {
    const { registry, engine } = harness()
    registry.register(testKind())
    expect(engine.cancel('op_nope')).toEqual({ canceled: false, refused: 'not-found' })
    await engine.start('test')
    expect(engine.cancel('op_1')).toEqual({ canceled: false, refused: 'already-finished' })
  })

  it('frees the group once canceled', async () => {
    const { registry, engine } = harness()
    registry.register(testKind({ runners: { first: runner(blocks, true), second: runner(done) } }))
    await engine.start('test')
    engine.cancel('op_1')
    expect(await engine.start('test')).toMatchObject({ started: true })
  })
})

describe('adoption after a restart (P3, §3.4)', () => {
  /** A second engine over the same store IS the successor process. */
  const successor = (store: OperationStore, registry: OperationKindRegistry) =>
    new OperationEngine({ store, registry, clock: fakeClock().clock })

  const midFlight = (over: Partial<PersistedOperation> = {}): PersistedOperation => ({
    id: 'op_1',
    kind: 'test',
    exclusionGroup: 'lifecycle',
    state: 'running',
    createdAt: 10,
    updatedAt: 10,
    steps: [
      { id: 'first', state: 'running', startedAt: 10, lastProgressAt: 10 },
      { id: 'second', state: 'pending' },
    ],
    ...over,
  })

  it('reconciles against reality, then resumes from where reality says it is', async () => {
    const { store, registry } = harness()
    store.insert(midFlight())

    const first = vi.fn(done)
    const reconcile = vi.fn((operation: Operation, reality: unknown) => ({
      ...operation,
      steps: (operation.steps ?? []).map((s) =>
        s.id === 'first' && (reality as { firstIsDone: boolean }).firstIsDone
          ? { ...s, state: 'done' as const }
          : s,
      ),
    }))
    registry.register(
      testKind({ reconcile, runners: { first: runner(first), second: runner(done) } }),
    )

    const engine = successor(store, registry)
    const adopted = await engine.adoptOnBoot(() => ({ firstIsDone: true }))

    expect(reconcile).toHaveBeenCalledOnce()
    // The step reality says is finished is NOT redone.
    expect(first).not.toHaveBeenCalled()
    expect(adopted[0]?.state).toBe('done')
    expect(store.get('op_1')?.state).toBe('done')
  })

  it('re-runs the step reality says is still outstanding', async () => {
    const { store, registry } = harness()
    store.insert(midFlight())
    const first = vi.fn(done)
    registry.register(testKind({ runners: { first: runner(first), second: runner(done) } }))

    await successor(store, registry).adoptOnBoot(() => ({}))
    // ensure() is idempotent by contract, so re-running it is the safe answer.
    expect(first).toHaveBeenCalledOnce()
    expect(store.get('op_1')?.state).toBe('done')
  })

  it('hands the kind the reality and the context the caller assembled', async () => {
    const { store, registry } = harness()
    store.insert(midFlight())
    const seen: unknown[] = []
    registry.register(
      testKind({
        reconcile: (operation, reality) => {
          seen.push(reality)
          return operation
        },
        runners: {
          first: runner(async ({ context }) => {
            seen.push(context)
            return { state: 'done' }
          }),
          second: runner(done),
        },
      }),
    )

    await successor(store, registry).adoptOnBoot(
      () => ({ appVersion: '0.4.3' }),
      () => ({ services: 'live' }),
    )
    expect(seen).toEqual([{ appVersion: '0.4.3' }, { services: 'live' }])
  })

  it('leaves nothing to adopt once everything has an outcome', async () => {
    const { store, registry } = harness()
    store.insert(midFlight({ state: 'done', finishedAt: 20 }))
    registry.register(testKind())
    expect(await successor(store, registry).adoptOnBoot(() => ({}))).toEqual([])
  })

  it('fails an operation of a kind this binary no longer registers, freeing the group', async () => {
    const { store, registry } = harness()
    store.insert(midFlight({ kind: 'from-the-future' }))
    registry.register(testKind())

    const adopted = await successor(store, registry).adoptOnBoot(() => ({}))
    expect(adopted[0]?.state).toBe('failed')
    expect(store.get('op_1')?.operation?.error?.code).toBe(UNKNOWN_KIND_ERROR_CODE)
    expect(store.activeByGroup('lifecycle')).toBeUndefined()
  })

  it('frees the group without rewriting a payload it cannot read', async () => {
    const { store, registry } = harness()
    store.insert(midFlight())
    const opaque = '{"id":"op_1","kind":"test","state":"quiescing"}'
    ;(store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
      .prepare('UPDATE operations SET payload = ? WHERE id = ?')
      .run(opaque, 'op_1')
    registry.register(testKind())

    await successor(store, registry).adoptOnBoot(() => ({}))
    const row = store.get('op_1')
    expect(row?.state).toBe('failed')
    // The successor's own record of what happened survives the downgrade.
    expect(row?.payload).toBe(opaque)
    expect(store.activeByGroup('lifecycle')).toBeUndefined()
  })

  it('keeps a field only a newer server understands across its own writes', async () => {
    const { store, registry } = harness()
    store.insert({ ...midFlight(), aFieldAddedNextYear: 'keep me' } as PersistedOperation)
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))

    const engine = successor(store, registry)
    await engine.adoptOnBoot(() => ({}))
    await engine.recordProgress('op_1', 'first', { progress: { done: 2, total: 3 } })

    const read = store.get('op_1')?.operation as Record<string, unknown>
    expect(read.aFieldAddedNextYear).toBe('keep me')
  })
})

describe('surface-scoped asks hold the operation open only when they must (§3.5)', () => {
  const withAsk = (required: boolean) =>
    testKind({
      plan: () => ({
        steps: [{ id: 'first' }],
        awaiting: [{ id: 'desktop-install', surface: 'desktop', required }],
      }),
      runners: { first: runner(done) },
    })

  it('waits on an ask that gates correctness', async () => {
    const { registry, engine, store } = harness()
    registry.register(withAsk(true))
    await engine.start('test')
    expect(store.get('op_1')?.state).toBe('waiting')
    expect(store.get('op_1')?.finishedAt).toBeNull()
  })

  it('completes despite a voluntary ask — stragglers self-serve', async () => {
    const { registry, engine, store } = harness()
    registry.register(withAsk(false))
    await engine.start('test')
    expect(store.get('op_1')?.state).toBe('done')
  })

  it('finishes once the ask that held it is settled', async () => {
    const { registry, engine, store } = harness()
    registry.register(withAsk(true))
    await engine.start('test')
    await engine.settleAsk('op_1', 'desktop-install')
    expect(store.get('op_1')?.state).toBe('done')
    expect(store.get('op_1')?.operation?.awaiting).toEqual([])
  })

  it('still holds the group while it waits', async () => {
    const { registry, engine } = harness()
    registry.register(withAsk(true))
    await engine.start('test')
    expect(await engine.start('test')).toMatchObject({ alreadyRunning: 'op_1' })
  })
})

describe('the registry', () => {
  it('refuses a second definition for one kind', () => {
    const registry = new OperationKindRegistry()
    registry.register(testKind())
    expect(() => registry.register(testKind())).toThrow(/already registered/)
  })

  it('reports its kinds and their distinct groups', () => {
    const registry = new OperationKindRegistry()
    registry.register(testKind())
    registry.register(testKind({ kind: 'server-move' }))
    registry.register(testKind({ kind: 'reindex', exclusionGroup: 'maintenance' }))
    expect(registry.kinds()).toEqual(['test', 'server-move', 'reindex'])
    expect(registry.groups()).toEqual(['lifecycle', 'maintenance'])
  })
})

describe('observers', () => {
  it('announces every persisted transition, and only after it is persisted', async () => {
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    const store = new OperationStore(db)
    const registry = new OperationKindRegistry()
    registry.register(testKind())
    const seen: string[] = []
    const engine = new OperationEngine({
      store,
      registry,
      clock: fakeClock().clock,
      newId: () => 'op_1',
      onChanged: (row) => {
        // What an observer reads must already be what the database holds.
        expect(row.state).toBe(store.get(row.id)?.state)
        seen.push(row.state)
      },
    })

    await engine.start('test')
    expect(seen[0]).toBe('running')
    expect(seen.at(-1)).toBe('done')
  })
})
