import { addSink, type LogRecord, resetLogging, setLogLevel } from '@podium/logger'
import type { Operation } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDrizzleMigrations } from '../../migrations'
import { DRIZZLE_MIGRATIONS } from '../../migrations/drizzle-manifest.generated'
import { syncQueriesOver } from '../../store/executor/sync-drizzle'
import {
  ADOPTION_FAILED_ERROR_CODE,
  DEFAULT_WAITING_GRACE_MS,
  DRIVE_FAILED_ERROR_CODE,
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
  const store = new OperationStore(syncQueriesOver(db))
  const registry = new OperationKindRegistry()
  const clock = fakeClock()
  let minted = 0
  const engine = new OperationEngine({
    store,
    registry,
    clock: clock.clock,
    newId: () => `op_${++minted}`,
  })
  // `db` is returned (POD-3415) for the one test that must write a payload
  // this binary cannot parse: a converted store holds a drizzle instance and
  // no handle, so the test keeps the database it opened rather than digging
  // one out of the object under test. Same database either way.
  return { store, registry, engine, clock, db }
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

/**
 * Start, then let the engine run until it blocks or ends.
 *
 * `start` deliberately does NOT wait for the plan — a click must not be held
 * hostage to a runner — so a test that wants to assert on where the plan got
 * to has to say when it is done waiting. Tests about a runner that never
 * returns use `engine.start` directly, because for them there is nothing to
 * wait for until the clock moves.
 */
const run = async (
  engine: OperationEngine,
  ...args: Parameters<OperationEngine['start']>
): Promise<Awaited<ReturnType<OperationEngine['start']>>> => {
  const result = await engine.start(...args)
  if (result.started) await engine.whenSettled(result.operation.id)
  return result
}

/** Start a plan whose first runner never returns; there is nothing to settle. */
const startOnly = (engine: OperationEngine) => engine.start('test')

/**
 * Let the engine's own continuations run, with no clock involved.
 *
 * `whenSettled` is the wrong tool once a runner is deliberately wedged: the
 * work queue is held by that runner on purpose, so waiting for it to drain is
 * waiting for the thing under test not to happen. Draining the microtask queue
 * a bounded number of times is deterministic — every step between a fired fake
 * timer and the resulting persisted state is a promise, never a real timer.
 */
const drainMicrotasks = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

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

    const result = await run(engine, 'test')
    expect(result).toMatchObject({ started: true })
    expect(order).toEqual(['first', 'second'])
    const row = await store.get('op_1')
    expect(row?.state).toBe('done')
    expect(row?.finishedAt).not.toBeNull()
    expect(row?.operation?.steps?.map((s) => s.state)).toEqual(['done', 'done'])
  })

  it('stops at the first step that hands work outside, and waits there', async () => {
    const { registry, engine, store } = harness()
    const second = vi.fn(done)
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(second) } }))

    await run(engine, 'test')
    expect((await store.get('op_1'))?.state).toBe('running')
    expect(step((await store.get('op_1'))?.operation, 'first')?.state).toBe('running')
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
    await run(engine, 'test')
    expect(step((await store.get('op_1'))?.operation, 'first')?.startedAt).toBe(0)
  })

  it('refuses a kind it does not know, rather than throwing', async () => {
    const { engine } = harness()
    expect(await engine.start('server-move')).toEqual({ started: false, refused: 'unknown-kind' })
  })

  it('records who asked', async () => {
    const { registry, engine, store } = harness()
    registry.register(testKind())
    await run(engine, 'test', undefined, { createdBy: 'user' })
    expect((await store.get('op_1'))?.operation?.createdBy).toBe('user')
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
    await run(engine, 'test', context)
    expect(seen).toEqual([context, context])
  })
})

describe('single-flight (P6)', () => {
  it('tells the second caller who is already holding the group', async () => {
    const { registry, engine } = harness()
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))

    await run(engine, 'test')
    expect(await run(engine, 'test')).toEqual({ started: false, alreadyRunning: 'op_1' })
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
    expect(await store.history('test')).toHaveLength(1)
  })

  it('releases the group the moment the operation reaches an outcome', async () => {
    const { registry, engine } = harness()
    registry.register(testKind())
    await run(engine, 'test')
    expect(await run(engine, 'test')).toMatchObject({ started: true })
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
    await run(engine, 'test')
    expect(await engine.start('reindex')).toMatchObject({ started: true })
  })
})

describe('progress and liveness (P4)', () => {
  it('stamps the heartbeat on every accepted report', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))
    await run(engine, 'test')

    clock.advance(4000)
    await engine.recordProgress('op_1', 'first', { progress: { done: 1, total: 3 } })

    const row = await store.get('op_1')
    expect(step(row?.operation, 'first')?.lastProgressAt).toBe(4000)
    expect(step(row?.operation, 'first')?.progress).toEqual({ done: 1, total: 3 })
    expect(row?.updatedAt).toBe(4000)
  })

  it('carries on with the plan when a report finishes the step', async () => {
    const { registry, engine, store } = harness()
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))
    await run(engine, 'test')

    await engine.recordProgress('op_1', 'first', { state: 'done' })
    expect((await store.get('op_1'))?.state).toBe('done')
  })

  it('ignores a report for a step that has already finished', async () => {
    const { registry, engine, store } = harness()
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(blocks) } }))
    await run(engine, 'test')
    await engine.recordProgress('op_1', 'first', { state: 'done' })

    await engine.recordProgress('op_1', 'first', { detail: 'late' })
    expect(step((await store.get('op_1'))?.operation, 'first')?.detail).toBeUndefined()
  })
})

describe('a failure REPORTED is a failure (POD-2136 review)', () => {
  it('fails the operation, rather than stepping over the failed step', async () => {
    const { registry, engine, store } = harness()
    const second = vi.fn(done)
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(second) } }))
    await run(engine, 'test')

    await engine.recordProgress('op_1', 'first', {
      state: 'failed',
      error: { code: 'machine-unreachable', places: ['vmi'] },
    })

    const row = await store.get('op_1')
    expect(row?.state).toBe('failed')
    expect(row?.operation?.error).toMatchObject({ code: 'machine-unreachable' })
    // The plan must not walk past it: `isStepFinished` counts a failed step as
    // finished, so a naive drive would reach `done` with a failed step in view.
    expect(second).not.toHaveBeenCalled()
    expect(step(row?.operation, 'second')?.state).toBe('pending')
  })

  it('still finishes the plan when the report merely completes the step', async () => {
    const { registry, engine, store } = harness()
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))
    await run(engine, 'test')
    await engine.recordProgress('op_1', 'first', { state: 'done' })
    expect((await store.get('op_1'))?.state).toBe('done')
  })

  it('frees the exclusion group when a report fails the operation', async () => {
    const { registry, engine } = harness()
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))
    await run(engine, 'test')
    await engine.recordProgress('op_1', 'first', { state: 'failed' })
    expect(await run(engine, 'test')).toMatchObject({ started: true })
  })
})

describe('a runner that never returns is still bound by its budget (POD-2136 review)', () => {
  /** An `ensure()` that hangs forever — a wedged ssh, a dead socket. */
  const hangs = () => new Promise<StepOutcome>(() => {})

  const hanging = (over: Partial<OperationKindDefinition> = {}) =>
    testKind({
      plan: () => ({ steps: [{ id: 'first' }, { id: 'second' }] }),
      runners: { first: runner(hangs), second: runner(done) },
      deadlines: { first: { silenceMs: 1000 } },
      ...over,
    })

  it('stalls it, retries once, then fails — without the runner ever answering', async () => {
    const { registry, engine, store, clock } = harness()
    const ensure = vi.fn(hangs)
    registry.register(hanging({ runners: { first: runner(ensure), second: runner(done) } }))

    // `start` returns while the runner is still pending: the engine is not
    // allowed to be hostage to it.
    await startOnly(engine)
    expect(ensure).toHaveBeenCalledTimes(1)
    expect((await store.get('op_1'))?.state).toBe('running')

    clock.advance(1000)
    await drainMicrotasks()
    expect(step((await store.get('op_1'))?.operation, 'first')?.stalls).toBe(1)
    expect(ensure).toHaveBeenCalledTimes(2)

    clock.advance(1000)
    await drainMicrotasks()
    const row = await store.get('op_1')
    expect(row?.state).toBe('failed')
    expect(row?.operation?.error?.code).toBe(STALLED_ERROR_CODE)
  })

  it('fails outright on a total budget, with no retry', async () => {
    const { registry, engine, store, clock } = harness()
    const ensure = vi.fn(hangs)
    registry.register(
      hanging({
        runners: { first: runner(ensure), second: runner(done) },
        deadlines: { first: { totalMs: 400 } },
      }),
    )
    await startOnly(engine)

    clock.advance(400)
    await drainMicrotasks()
    expect((await store.get('op_1'))?.state).toBe('failed')
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  it('leaves a hanging runner alone when its kind declared no budget', async () => {
    // Nothing to enforce, so nothing is invented — the operation stays running.
    const { registry, engine, store, clock } = harness()
    registry.register(hanging({ deadlines: {} }))
    await startOnly(engine)
    clock.advance(10_000)
    await drainMicrotasks()
    expect((await store.get('op_1'))?.state).toBe('running')
  })

  it('accepts the answer of a runner that returns inside its budget', async () => {
    const { registry, engine, store, clock } = harness()
    let release: (o: StepOutcome) => void = () => {}
    registry.register(
      hanging({
        runners: {
          first: runner(
            () =>
              new Promise<StepOutcome>((r) => {
                release = r
              }),
          ),
          second: runner(done),
        },
      }),
    )
    await engine.start('test')
    clock.advance(500)
    release({ state: 'done' })
    await engine.whenSettled('op_1')
    expect((await store.get('op_1'))?.state).toBe('done')
  })
})

describe('stopping the engine (POD-2136 review)', () => {
  it('disarms every deadline, so nothing wakes into a closed store', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(
      testKind({
        plan: () => ({ steps: [{ id: 'first' }] }),
        runners: { first: runner(blocks) },
        deadlines: { first: { silenceMs: 1000 } },
      }),
    )
    await run(engine, 'test')
    expect(clock.armed()).toBe(1)

    engine.stop()
    expect(clock.armed()).toBe(0)

    clock.advance(10_000)
    await engine.whenSettled('op_1')
    // Untouched: the successor adopts it and re-derives from reality instead.
    expect((await store.get('op_1'))?.state).toBe('running')
    expect(step((await store.get('op_1'))?.operation, 'first')?.stalls).toBeUndefined()
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
    await run(engine, 'test')
    expect(ensure).toHaveBeenCalledTimes(1)

    clock.advance(1000)
    await engine.whenSettled('op_1')
    const retried = step((await store.get('op_1'))?.operation, 'first')
    expect(retried?.stalls).toBe(1)
    expect(retried?.attempts).toBe(2)
    expect(ensure).toHaveBeenCalledTimes(2)
    expect((await store.get('op_1'))?.state).toBe('running')

    clock.advance(1000)
    await engine.whenSettled('op_1')
    const row = await store.get('op_1')
    expect(row?.state).toBe('failed')
    expect(row?.operation?.error?.code).toBe(STALLED_ERROR_CODE)
    expect(step(row?.operation, 'first')?.state).toBe('failed')
    expect(ensure).toHaveBeenCalledTimes(2)
  })

  it('lets progress push the deadline out', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(stalling())
    await run(engine, 'test')

    clock.advance(600)
    await engine.recordProgress('op_1', 'first', { detail: 'still going' })
    clock.advance(600)
    await engine.whenSettled('op_1')
    expect(step((await store.get('op_1'))?.operation, 'first')?.state).toBe('running')

    clock.advance(500)
    await engine.whenSettled('op_1')
    expect(step((await store.get('op_1'))?.operation, 'first')?.stalls).toBe(1)
  })

  it('records a stall that recovered instead of erasing it', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(stalling())
    await run(engine, 'test')

    clock.advance(1000)
    await engine.whenSettled('op_1')
    await engine.recordProgress('op_1', 'first', { state: 'done' })

    const finished = step((await store.get('op_1'))?.operation, 'first')
    expect(finished?.state).toBe('done')
    expect(finished?.stalls).toBe(1)
    expect((await store.get('op_1'))?.state).toBe('done')
  })

  it('fails a step that overruns its total budget, with no retry', async () => {
    const { registry, engine, store, clock } = harness()
    const ensure = vi.fn(blocks)
    registry.register(
      stalling({ runners: { first: runner(ensure) }, deadlines: { first: { totalMs: 500 } } }),
    )
    await run(engine, 'test')

    clock.advance(500)
    await engine.whenSettled('op_1')
    expect((await store.get('op_1'))?.state).toBe('failed')
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(step((await store.get('op_1'))?.operation, 'first')?.stalls).toBeUndefined()
  })

  it('arms nothing for a step whose kind declares no budget', async () => {
    const { registry, engine, clock } = harness()
    registry.register(stalling({ deadlines: {} }))
    await run(engine, 'test')
    expect(clock.armed()).toBe(0)
  })

  it('drops the timer when the operation ends', async () => {
    const { registry, engine, clock } = harness()
    registry.register(stalling())
    await run(engine, 'test')
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
    await run(engine, 'test')
    const row = await store.get('op_1')
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
    await run(engine, 'test')
    const row = await store.get('op_1')
    expect(row?.state).toBe('failed')
    expect(row?.operation?.error?.code).toBe('step-threw')
    expect(row?.operation?.error?.detail).toContain('connection refused')
  })

  it('fails an operation whose plan names a step with no runner', async () => {
    const { registry, engine, store } = harness()
    registry.register(testKind({ plan: () => ({ steps: [{ id: 'ghost' }] }) }))
    await run(engine, 'test')
    expect((await store.get('op_1'))?.operation?.error?.code).toBe('no-runner')
  })
})

describe('cancel is gated on reversibility (§3.2)', () => {
  it('cancels while the step in flight says it is safe', async () => {
    const { registry, engine, store } = harness()
    registry.register(testKind({ runners: { first: runner(blocks, true), second: runner(done) } }))
    await run(engine, 'test')

    expect(engine.cancel('op_1')).toMatchObject({ canceled: true })
    expect((await store.get('op_1'))?.state).toBe('canceled')
    expect((await store.get('op_1'))?.finishedAt).not.toBeNull()
  })

  it('refuses once an irreversible step is in flight, and names it', async () => {
    const { registry, engine, store } = harness()
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))
    await run(engine, 'test')

    expect(engine.cancel('op_1')).toEqual({
      canceled: false,
      refused: 'irreversible',
      step: 'first',
    })
    expect((await store.get('op_1'))?.state).toBe('running')
  })

  it('treats an unmarked runner as irreversible', async () => {
    // The dangerous steps are the ones nobody remembers to mark.
    const { registry, engine } = harness()
    registry.register(
      testKind({ runners: { first: runner(blocks, undefined), second: runner(done) } }),
    )
    await run(engine, 'test')
    expect(engine.cancel('op_1')).toMatchObject({ refused: 'irreversible' })
  })

  it('refuses an operation that never existed, or already ended', async () => {
    const { registry, engine } = harness()
    registry.register(testKind())
    expect(engine.cancel('op_nope')).toEqual({ canceled: false, refused: 'not-found' })
    await run(engine, 'test')
    expect(engine.cancel('op_1')).toEqual({ canceled: false, refused: 'already-finished' })
  })

  it('frees the group once canceled', async () => {
    const { registry, engine } = harness()
    registry.register(testKind({ runners: { first: runner(blocks, true), second: runner(done) } }))
    await run(engine, 'test')
    engine.cancel('op_1')
    expect(await run(engine, 'test')).toMatchObject({ started: true })
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
    await store.insert(midFlight())

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
    expect((await store.get('op_1'))?.state).toBe('done')
  })

  it('re-runs the step reality says is still outstanding', async () => {
    const { store, registry } = harness()
    await store.insert(midFlight())
    const first = vi.fn(done)
    registry.register(testKind({ runners: { first: runner(first), second: runner(done) } }))

    await successor(store, registry).adoptOnBoot(() => ({}))
    // ensure() is idempotent by contract, so re-running it is the safe answer.
    expect(first).toHaveBeenCalledOnce()
    expect((await store.get('op_1'))?.state).toBe('done')
  })

  it('hands the kind the reality and the context the caller assembled', async () => {
    const { store, registry } = harness()
    await store.insert(midFlight())
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
    await store.insert(midFlight({ state: 'done', finishedAt: 20 }))
    registry.register(testKind())
    expect(await successor(store, registry).adoptOnBoot(() => ({}))).toEqual([])
  })

  it('fails an operation of a kind this binary no longer registers, freeing the group', async () => {
    const { store, registry } = harness()
    await store.insert(midFlight({ kind: 'from-the-future' }))
    registry.register(testKind())

    const adopted = await successor(store, registry).adoptOnBoot(() => ({}))
    expect(adopted[0]?.state).toBe('failed')
    expect((await store.get('op_1'))?.operation?.error?.code).toBe(UNKNOWN_KIND_ERROR_CODE)
    expect(await store.activeByGroup('lifecycle')).toBeUndefined()
  })

  it('frees the group without rewriting a payload it cannot read', async () => {
    const { store, registry, db } = harness()
    await store.insert(midFlight())
    const opaque = '{"id":"op_1","kind":"test","state":"quiescing"}'
    db.prepare('UPDATE operations SET payload = ? WHERE id = ?').run(opaque, 'op_1')
    registry.register(testKind())

    await successor(store, registry).adoptOnBoot(() => ({}))
    const row = await store.get('op_1')
    expect(row?.state).toBe('failed')
    // The successor's own record of what happened survives the downgrade.
    expect(row?.payload).toBe(opaque)
    expect(await store.activeByGroup('lifecycle')).toBeUndefined()
  })

  it('keeps a field only a newer server understands across its own writes', async () => {
    const { store, registry } = harness()
    await store.insert({ ...midFlight(), aFieldAddedNextYear: 'keep me' } as PersistedOperation)
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))

    const engine = successor(store, registry)
    await engine.adoptOnBoot(() => ({}))
    await engine.recordProgress('op_1', 'first', { progress: { done: 2, total: 3 } })

    const read = (await store.get('op_1'))?.operation as Record<string, unknown>
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
    await run(engine, 'test')
    expect((await store.get('op_1'))?.state).toBe('waiting')
    expect((await store.get('op_1'))?.finishedAt).toBeNull()
  })

  it('completes despite a voluntary ask — stragglers self-serve', async () => {
    const { registry, engine, store } = harness()
    registry.register(withAsk(false))
    await run(engine, 'test')
    expect((await store.get('op_1'))?.state).toBe('done')
  })

  it('finishes once the ask that held it is settled', async () => {
    const { registry, engine, store } = harness()
    registry.register(withAsk(true))
    await run(engine, 'test')
    await engine.settleAsk('op_1', 'desktop-install')
    expect((await store.get('op_1'))?.state).toBe('done')
    expect((await store.get('op_1'))?.operation?.awaiting).toEqual([])
  })

  it('still holds the group while it waits', async () => {
    const { registry, engine } = harness()
    registry.register(withAsk(true))
    await run(engine, 'test')
    expect(await run(engine, 'test')).toMatchObject({ alreadyRunning: 'op_1' })
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

/**
 * WHAT A RESTART DOES TO A STALLED STEP (POD-2145).
 *
 * `driveLocked` leaves a stalled step alone because it is waiting on its own
 * retry — true inside one process, false across a restart, where that retry
 * belonged to the dead one. The `update` kind restarts this server mid-step by
 * design, so the window between "persisted stalled" and "retry issued" is a
 * normal event here, not an exotic one.
 */
describe('a step left stalled by a dead process (POD-2145)', () => {
  const stalledMidFlight = (over: Partial<PersistedOperation> = {}): PersistedOperation => ({
    id: 'op_1',
    kind: 'test',
    exclusionGroup: 'lifecycle',
    state: 'running',
    createdAt: 10,
    updatedAt: 10,
    steps: [
      { id: 'first', state: 'stalled', startedAt: 10, lastProgressAt: 10, stalls: 1, attempts: 2 },
      { id: 'second', state: 'pending' },
    ],
    ...over,
  })

  /** A successor whose clock the test can drive. */
  const boot = (store: OperationStore, registry: OperationKindRegistry) => {
    const clock = fakeClock()
    return { clock, engine: new OperationEngine({ store, registry, clock: clock.clock }) }
  }

  it('is resumed by adoption, rather than holding its group forever', async () => {
    const { store, registry } = harness()
    await store.insert(stalledMidFlight())
    const first = vi.fn(done)
    registry.register(testKind({ runners: { first: runner(first), second: runner(done) } }))

    await boot(store, registry).engine.adoptOnBoot(() => ({}))

    // ensure() is idempotent by contract, so re-running it is the safe answer —
    // and the only one, since nothing else will ever touch this step again.
    expect(first).toHaveBeenCalledOnce()
    expect((await store.get('op_1'))?.state).toBe('done')
    expect(await store.activeByGroup('lifecycle')).toBeUndefined()
  })

  it('keeps the stall the dead process recorded, and counts the new attempt', async () => {
    const { store, registry } = harness()
    await store.insert(stalledMidFlight())
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))

    await boot(store, registry).engine.adoptOnBoot(() => ({}))

    const resumed = step((await store.get('op_1'))?.operation, 'first')
    expect(resumed?.state).toBe('running')
    // "It hung and then recovered" is a fact about the update the user lived
    // through: the restart does not buy the step a fresh stall budget.
    expect(resumed?.stalls).toBe(1)
    expect(resumed?.attempts).toBe(3)
  })

  it('arms the deadline the dead process never left behind', async () => {
    const { store, registry } = harness()
    await store.insert(stalledMidFlight())
    registry.register(
      testKind({
        runners: { first: runner(blocks), second: runner(done) },
        deadlines: { first: { silenceMs: 1000 } },
      }),
    )

    const { engine, clock } = boot(store, registry)
    await engine.adoptOnBoot(() => ({}))
    expect(clock.armed()).toBe(1)

    // It has already used its one stall, so the next silence is fatal. The
    // wedge is closed in both directions: the step resumes, and it is still
    // answerable to a budget.
    clock.advance(1000)
    await engine.whenSettled('op_1')
    expect((await store.get('op_1'))?.state).toBe('failed')
    expect((await store.get('op_1'))?.operation?.error?.code).toBe(STALLED_ERROR_CODE)
  })

  it('is failed, not parked, when this binary has no runner for it', async () => {
    const { store, registry } = harness()
    await store.insert(stalledMidFlight())
    registry.register(testKind({ runners: { second: runner(done) } }))

    await boot(store, registry).engine.adoptOnBoot(() => ({}))
    expect((await store.get('op_1'))?.operation?.error?.code).toBe('no-runner')
    expect(await store.activeByGroup('lifecycle')).toBeUndefined()
  })

  it('does not resume a step the kind reconciled to finished', async () => {
    const { store, registry } = harness()
    await store.insert(stalledMidFlight())
    const first = vi.fn(done)
    registry.register(
      testKind({
        // Reality wins over the dead process's memory of a stall (P3).
        reconcile: (operation) => ({
          ...operation,
          steps: (operation.steps ?? []).map((s) =>
            s.id === 'first' ? { ...s, state: 'done' as const } : s,
          ),
        }),
        runners: { first: runner(first), second: runner(done) },
      }),
    )

    await boot(store, registry).engine.adoptOnBoot(() => ({}))
    expect(first).not.toHaveBeenCalled()
    expect((await store.get('op_1'))?.state).toBe('done')
  })

  it('fails a stalled step whose runner went away, rather than leaving it stalled', async () => {
    // `onDeadline` and `driveLocked` must agree about what an unrunnable step
    // means: one failed it and the other returned, leaving the step stalled
    // with no timer — the same wedge by a second route.
    const { registry, engine, store, clock } = harness()
    const def = testKind({
      plan: () => ({ steps: [{ id: 'first' }] }),
      runners: { first: runner(blocks) },
      deadlines: { first: { silenceMs: 1000 } },
    })
    registry.register(def)
    await run(engine, 'test')

    delete (def.runners as Record<string, unknown>).first
    clock.advance(1000)
    await engine.whenSettled('op_1')

    expect((await store.get('op_1'))?.state).toBe('failed')
    expect((await store.get('op_1'))?.operation?.error?.code).toBe('no-runner')
  })
})

/**
 * ADOPTION MUST NOT BE ABLE TO STOP THE SERVER BOOTING (POD-2147).
 *
 * `startServer` awaits `adoptOnBoot` before it binds. A kind whose `reconcile`
 * or reality lookup throws would therefore reject startup — on the server whose
 * job is to apply the update that fixes it.
 */
describe('adoption contains what the kind throws (POD-2147)', () => {
  const midFlight = (over: Partial<PersistedOperation> = {}): PersistedOperation => ({
    id: 'op_1',
    kind: 'test',
    exclusionGroup: 'lifecycle',
    state: 'running',
    createdAt: 10,
    updatedAt: 10,
    steps: [{ id: 'first', state: 'running', startedAt: 10, lastProgressAt: 10 }],
    ...over,
  })

  const boot = (store: OperationStore, registry: OperationKindRegistry) =>
    new OperationEngine({ store, registry, clock: fakeClock().clock })

  it('resolves, and abandons the operation, when the reality lookup throws', async () => {
    const { store, registry } = harness()
    await store.insert(midFlight())
    registry.register(testKind({ plan: () => ({ steps: [{ id: 'first' }] }) }))

    const adopted = await boot(store, registry).adoptOnBoot(() => {
      throw new Error('reality lookup exploded')
    })

    expect(adopted[0]?.state).toBe('failed')
    const row = await store.get('op_1')
    expect(row?.state).toBe('failed')
    expect(row?.operation?.error?.code).toBe(ADOPTION_FAILED_ERROR_CODE)
    // The whole point: the group is released rather than wedged behind an
    // operation this binary has just proved it cannot drive.
    expect(await store.activeByGroup('lifecycle')).toBeUndefined()
  })

  it('resolves, and abandons the operation, when reconcile throws', async () => {
    const { store, registry } = harness()
    await store.insert(midFlight())
    registry.register(
      testKind({
        plan: () => ({ steps: [{ id: 'first' }] }),
        reconcile: () => {
          throw new Error('cannot read version of undefined')
        },
      }),
    )

    await boot(store, registry).adoptOnBoot(() => ({}))
    expect((await store.get('op_1'))?.operation?.error?.code).toBe(ADOPTION_FAILED_ERROR_CODE)
  })

  it('adopts the operations behind the one that threw', async () => {
    const { store, registry } = harness()
    await store.insert(midFlight({ id: 'op_a', createdAt: 10, updatedAt: 10 }))
    await store.insert(
      midFlight({
        id: 'op_b',
        kind: 'reindex',
        exclusionGroup: 'maintenance',
        createdAt: 20,
        updatedAt: 20,
      }),
    )
    registry.register(
      testKind({ plan: () => ({ steps: [{ id: 'first' }] }), runners: { first: runner(done) } }),
    )
    registry.register(
      testKind({
        kind: 'reindex',
        exclusionGroup: 'maintenance',
        plan: () => ({ steps: [{ id: 'first' }] }),
        reconcile: () => {
          throw new Error('reindex reconcile exploded')
        },
      }),
    )

    // `active()` is newest first, so the thrower is reached before op_a.
    await boot(store, registry).adoptOnBoot(() => ({}))
    expect((await store.get('op_b'))?.state).toBe('failed')
    expect((await store.get('op_a'))?.state).toBe('done')
  })

  it('resolves even when the store cannot list its live rows', async () => {
    const { store, registry } = harness()
    registry.register(testKind())
    vi.spyOn(store, 'active').mockImplementation(() => {
      throw new Error('database is locked')
    })

    // The sweep is inside the guarantee too: `startServer` awaits this before
    // it binds, so the one thing that must not happen is a rejection.
    await expect(boot(store, registry).adoptOnBoot(() => ({}))).resolves.toEqual([])
  })

  it('does not throw when retention sweeps the adopted row away', async () => {
    const { store, registry } = harness()
    // Twenty newer finished operations, so this one falls outside its kind's
    // retention the moment its own completion sweeps.
    for (let i = 0; i < 20; i++) {
      await store.insert({
        ...midFlight({ id: `op_old_${i}`, state: 'done' }),
        createdAt: 100 + i,
        updatedAt: 100 + i,
        finishedAt: 100 + i,
      })
    }
    await store.insert(midFlight())
    registry.register(
      testKind({ plan: () => ({ steps: [{ id: 'first' }] }), runners: { first: runner(done) } }),
    )

    const adopted = await boot(store, registry).adoptOnBoot(() => ({}))
    expect(adopted.map((o) => o.id)).toContain('op_1')
    expect(await store.get('op_1')).toBeUndefined()
  })
})

/**
 * STOP MEANS STOP (POD-2148). The shutdown fix that landed cleared the deadline
 * map, which is not the only timer the engine arms, and one of the two close
 * paths never called it at all.
 */
describe('stopping the engine is a fence, not a timer sweep (POD-2148)', () => {
  const hangs = () => new Promise<StepOutcome>(() => {})

  it('clears the budget timer racing a runner that has not returned', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(
      testKind({
        plan: () => ({ steps: [{ id: 'first' }] }),
        runners: { first: runner(hangs) },
        deadlines: { first: { silenceMs: 1000 } },
      }),
    )
    await startOnly(engine)
    // `invokeWithin`'s timer is armed on the clock but was never in the
    // per-operation map that `stop()` clears.
    expect(clock.armed()).toBe(1)

    engine.stop()
    expect(clock.armed()).toBe(0)

    // Nothing left to resolve OVERDUE into `onDeadline` and on into a store
    // the shutdown path has already closed.
    clock.advance(10_000)
    await drainMicrotasks()
    expect((await store.get('op_1'))?.state).toBe('running')
    expect(step((await store.get('op_1'))?.operation, 'first')?.stalls).toBeUndefined()
  })

  it('writes nothing once stopped, even when the runner finally answers', async () => {
    const { registry, engine, store, clock } = harness()
    let release: (o: StepOutcome) => void = () => {}
    registry.register(
      testKind({
        plan: () => ({ steps: [{ id: 'first' }, { id: 'second' }] }),
        runners: {
          first: runner(
            () =>
              new Promise<StepOutcome>((r) => {
                release = r
              }),
          ),
          second: runner(done),
        },
      }),
    )
    await engine.start('test')
    const before = (await store.get('op_1'))?.updatedAt

    engine.stop()
    clock.advance(500)
    release({ state: 'done' })
    await drainMicrotasks()

    // A write here lands in a database the shutdown path has already closed.
    const row = await store.get('op_1')
    expect(row?.state).toBe('running')
    expect(row?.updatedAt).toBe(before)
  })

  it('accepts no new work once stopped', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))
    await run(engine, 'test')
    const before = (await store.get('op_1'))?.updatedAt

    engine.stop()
    clock.advance(500)
    await engine.recordProgress('op_1', 'first', { progress: { done: 1, total: 3 } })
    expect((await store.get('op_1'))?.updatedAt).toBe(before)
  })
})

/**
 * WAITING IS A STATE, NOT A PARKING SPACE (POD-2149, spec §3.2 and §3.5).
 *
 * The spec's diagram names `expired` as an exit from `waiting` and §3.5 says an
 * operation there "completes after a short grace". Neither existed: a required
 * ask nothing could answer held the exclusion group for as long as the machine
 * stayed asleep.
 */
describe('waiting expires after a grace (POD-2149)', () => {
  const withRequiredAsk = (over: Partial<OperationKindDefinition> = {}) =>
    testKind({
      plan: () => ({
        steps: [{ id: 'first' }],
        awaiting: [{ id: 'desktop-install', surface: 'desktop', required: true }],
      }),
      runners: { first: runner(done) },
      ...over,
    })

  it('completes once the grace passes with the ask still outstanding', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(withRequiredAsk())
    await run(engine, 'test')
    expect((await store.get('op_1'))?.state).toBe('waiting')

    clock.advance(DEFAULT_WAITING_GRACE_MS)
    await engine.whenSettled('op_1')
    expect((await store.get('op_1'))?.state).toBe('done')
    expect((await store.get('op_1'))?.finishedAt).not.toBeNull()
  })

  it('holds the operation open for the whole grace', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(withRequiredAsk())
    await run(engine, 'test')

    clock.advance(DEFAULT_WAITING_GRACE_MS - 1)
    await engine.whenSettled('op_1')
    expect((await store.get('op_1'))?.state).toBe('waiting')
  })

  it('honours the grace the kind names', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(withRequiredAsk({ waitingGraceMs: 5000 }))
    await run(engine, 'test')

    clock.advance(5000)
    await engine.whenSettled('op_1')
    expect((await store.get('op_1'))?.state).toBe('done')
  })

  it('leaves the unanswered ask in the record', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(withRequiredAsk())
    await run(engine, 'test')
    clock.advance(DEFAULT_WAITING_GRACE_MS)
    await engine.whenSettled('op_1')

    // Completing is not the same as pretending it was answered.
    expect((await store.get('op_1'))?.operation?.awaiting).toEqual([
      { id: 'desktop-install', surface: 'desktop', required: true },
    ])
  })

  /**
   * THE KIND GETS THE LAST WORD ON THE OUTCOME (POD-2186).
   *
   * `expireWaiting` justifies completing with "the shared steps all succeeded",
   * which is a claim about the PLAN — true here, and vacuous for a plan with no
   * steps at all. The framework keeps the grace unconditional (ending the wait
   * is what POD-2149 was for) and hands the kind the question of whether
   * completing is honest.
   */
  it('fails with the error the kind names, when the kind says completing would be a lie', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(
      withRequiredAsk({
        plan: () => ({
          steps: [],
          awaiting: [{ id: 'desktop-install', surface: 'desktop', required: true }],
        }),
        runners: {},
        describeWaitingExpiry: () => ({ code: 'nobody-did-it', message: 'Nobody did it.' }),
      }),
    )
    await run(engine, 'test')
    expect((await store.get('op_1'))?.state).toBe('waiting')

    clock.advance(DEFAULT_WAITING_GRACE_MS)
    await engine.whenSettled('op_1')

    const row = await store.get('op_1')
    expect(row?.state).toBe('failed')
    expect(row?.operation?.error).toEqual({ code: 'nobody-did-it', message: 'Nobody did it.' })
    // Still ended, and still let go of the group: a wedge is not fixed by a
    // wrong outcome, and it is not re-opened by a right one either.
    expect(row?.finishedAt).not.toBeNull()
    expect(await store.activeByGroup('lifecycle')).toBeUndefined()
  })

  /** A kind that returns nothing keeps the framework's answer, which is what
   *  every kind but the all-in-one update plan wants. */
  it('still completes when the kind declines to name an error', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(withRequiredAsk({ describeWaitingExpiry: () => undefined }))
    await run(engine, 'test')

    clock.advance(DEFAULT_WAITING_GRACE_MS)
    await engine.whenSettled('op_1')
    expect((await store.get('op_1'))?.state).toBe('done')
  })

  it('frees the exclusion group when the grace runs out', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(withRequiredAsk())
    await run(engine, 'test')
    expect(await store.activeByGroup('lifecycle')).toBeDefined()

    clock.advance(DEFAULT_WAITING_GRACE_MS)
    await engine.whenSettled('op_1')
    expect(await store.activeByGroup('lifecycle')).toBeUndefined()
  })

  it('still settles the moment the ask is answered', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(withRequiredAsk())
    await run(engine, 'test')
    await engine.settleAsk('op_1', 'desktop-install')
    expect((await store.get('op_1'))?.state).toBe('done')
    // …and the grace timer went with it.
    expect(clock.armed()).toBe(0)
  })

  it('re-arms the grace when a successor adopts a waiting operation', async () => {
    const { store, registry } = harness()
    await store.insert({
      id: 'op_1',
      kind: 'test',
      exclusionGroup: 'lifecycle',
      state: 'waiting',
      createdAt: 10,
      updatedAt: 10,
      steps: [{ id: 'first', state: 'done', startedAt: 10, finishedAt: 20 }],
      awaiting: [{ id: 'desktop-install', surface: 'desktop', required: true }],
    })
    registry.register(withRequiredAsk())

    const clock = fakeClock()
    const engine = new OperationEngine({ store, registry, clock: clock.clock })
    await engine.adoptOnBoot(() => ({}))
    expect((await store.get('op_1'))?.state).toBe('waiting')

    clock.advance(DEFAULT_WAITING_GRACE_MS)
    await engine.whenSettled('op_1')
    expect((await store.get('op_1'))?.state).toBe('done')
  })
})

/**
 * NOBODY IS AWAITING THE DRIVE (POD-2151). `start()` deliberately does not — a
 * click must not be held hostage to a runner — and the deadline timer never
 * did. So containment has to live at those two sites, or a throw disappears
 * into the chain's blanket catch and leaves the operation `running` forever.
 */
describe('a background drive that throws is contained (POD-2151)', () => {
  it('fails the operation the drive could not advance, and frees the group', async () => {
    const { registry, engine, store } = harness()
    registry.register(testKind())
    vi.spyOn(store, 'update').mockImplementationOnce(() => {
      throw new Error('database is locked')
    })

    // The caller is told the operation started, and it did.
    expect(await engine.start('test')).toMatchObject({ started: true })
    await drainMicrotasks()

    const row = await store.get('op_1')
    expect(row?.state).toBe('failed')
    expect(row?.operation?.error?.code).toBe(DRIVE_FAILED_ERROR_CODE)
    expect(row?.operation?.error?.detail).toContain('database is locked')
    expect(await store.activeByGroup('lifecycle')).toBeUndefined()
  })

  it('fails the operation when a deadline wakes into a broken store', async () => {
    const { registry, engine, store, clock } = harness()
    registry.register(
      testKind({
        plan: () => ({ steps: [{ id: 'first' }] }),
        runners: { first: runner(blocks) },
        deadlines: { first: { silenceMs: 1000 } },
      }),
    )
    await run(engine, 'test')

    vi.spyOn(store, 'get').mockImplementationOnce(() => {
      throw new Error('database is locked')
    })
    clock.advance(1000)
    await drainMicrotasks()

    expect((await store.get('op_1'))?.state).toBe('failed')
    expect((await store.get('op_1'))?.operation?.error?.code).toBe(DRIVE_FAILED_ERROR_CODE)
  })

  it('raises nothing further when the store itself is the broken thing', async () => {
    const { registry, engine, store } = harness()
    registry.register(testKind())
    vi.spyOn(store, 'update').mockImplementation(() => {
      throw new Error('database is closed')
    })

    const unhandled: unknown[] = []
    const capture = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', capture)
    try {
      expect(await engine.start('test')).toMatchObject({ started: true })
      await drainMicrotasks()
      // One turn of the event loop — Node decides a rejection is unhandled at
      // the end of a microtask checkpoint, so this is a checkpoint rather than
      // a sleep: nothing here waits for a duration.
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', capture)
    }

    // The recovery path writes through the same store that just failed, so it
    // cannot record anything — and must not turn a contained failure into an
    // uncontained one on the way out.
    expect(unhandled).toEqual([])
    expect((await store.get('op_1'))?.state).toBe('running')
  })
})

/**
 * THE ONE WRITE THIS ENGINE MAKES TO A FINISHED OPERATION (POD-3040).
 *
 * `deferred` is not a record of what happened; it is a promise about what is
 * still going to. An operation reaching `done` is exactly what does NOT settle
 * it — §3.6's whole point is that the operation finishes without those places —
 * so the promise can go stale long after the row is terminal, and something has
 * to be able to correct it. What must not happen is the correction reanimating
 * the operation.
 */
describe('restating a deferred promise (POD-3040)', () => {
  const kindWithDeferred = () =>
    testKind({
      plan: () => ({
        steps: [{ id: 'first' }],
        deferred: [{ id: 'laptop', name: 'laptop', reason: 'offline' }],
      }),
      runners: { first: runner(done) },
    })

  it('rewrites the note on a finished operation without touching its outcome', async () => {
    const h = harness()
    h.registry.register(kindWithDeferred())
    const started = await run(h.engine, 'test')
    if (!started.started) throw new Error('expected the operation to start')
    const id = started.operation.id

    const finished = (await h.store.get(id))?.operation
    expect(finished?.state).toBe('done')
    expect(finished?.deferred).toEqual([{ id: 'laptop', name: 'laptop', reason: 'offline' }])

    h.clock.advance(5_000)
    await h.engine.recordDeferred(id, [{ id: 'laptop', name: 'laptop', reason: 'target-superseded' }])

    const after = (await h.store.get(id))?.operation
    expect(after?.deferred).toEqual([
      { id: 'laptop', name: 'laptop', reason: 'target-superseded' },
    ])
    // The outcome is history and stays exactly as it was.
    expect(after?.state).toBe('done')
    expect(after?.finishedAt).toBe(finished?.finishedAt)
    expect(after?.steps).toEqual(finished?.steps)
    expect(after?.error).toEqual(finished?.error)
  })

  it('does not reopen the exclusion group it already released', async () => {
    const h = harness()
    h.registry.register(kindWithDeferred())
    const started = await run(h.engine, 'test')
    if (!started.started) throw new Error('expected the operation to start')

    await h.engine.recordDeferred(started.operation.id, [
      { id: 'laptop', reason: 'target-unavailable' },
    ])

    expect(h.engine.active('lifecycle')).toBeUndefined()
    // …and the group is genuinely free: a second operation may still start.
    const next = await run(h.engine, 'test')
    expect(next.started).toBe(true)
  })

  it('is silent about an operation that is not there', async () => {
    const h = harness()
    await expect(h.engine.recordDeferred('op_missing', [])).resolves.toBeUndefined()
  })
})

describe('observers', () => {
  it('announces every persisted transition, and only after it is persisted', async () => {
    const db = openDatabase(':memory:')
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    const store = new OperationStore(syncQueriesOver(db))
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

    await run(engine, 'test')
    expect(seen[0]).toBe('running')
    expect(seen.at(-1)).toBe('done')
  })
})

/**
 * THE ENGINE'S NARRATION (POD-3224).
 *
 * The durable row says where an operation ended up. These pin the part it
 * cannot say: when each step was entered, whether a step was ENTERED or merely
 * re-entered, which deadline fired, and — for a successor — what it inherited
 * and what it concluded. Reconstructing an update's timeline previously meant
 * diffing successive payload rows, and the row is swept after twenty.
 */
describe('what the engine writes down', () => {
  let logged: LogRecord[]

  const capture = (): void => {
    resetLogging()
    logged = []
    setLogLevel('debug')
    addSink({ name: 'capture', write: (record) => logged.push(record) })
  }
  const messages = (): string[] => logged.map((record) => record.msg)
  const field = (msg: string, key: string): unknown =>
    (logged.find((record) => record.msg === msg) as Record<string, unknown> | undefined)?.[key]

  afterEach(() => {
    resetLogging()
  })

  it('records the plan at the moment it was made, deferred reasons included', async () => {
    const { engine, registry } = harness()
    registry.register(
      testKind({
        plan: () => ({
          steps: [{ id: 'first', places: [{ id: 'm1' }] }, { id: 'second' }],
          awaiting: [{ id: 'reload', surface: 'web', title: 'Reload', required: false }],
          deferred: [{ id: 'm2', reason: 'offline' }],
        }),
      }),
    )
    capture()
    await run(engine, 'test', undefined, { createdBy: 'a-test' })

    expect(field('operation created', 'steps')).toBe('first,second')
    expect(field('operation created', 'deferred')).toEqual(['m2:offline'])
    expect(field('operation created', 'awaiting')).toEqual(['reload@web'])
    expect(field('operation created', 'createdBy')).toBe('a-test')
  })

  it('tells an entry apart from a re-entry, which is how a nudged wave reads', async () => {
    const { engine, registry } = harness()
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))
    capture()
    const started = await engine.start('test')
    if (!started.started) throw new Error('expected a start')
    await engine.whenSettled(started.operation.id)

    // Something outside the operation says "try again now" — the path that
    // exists so a stuck wave can be pushed along.
    await engine.reensure(started.operation.id, 'first')

    expect(messages().filter((msg) => msg === 'operation step entered')).toHaveLength(1)
    expect(messages()).toContain('operation step re-entered')
  })

  it('names the outcome with the attempts and stalls that produced it', async () => {
    const { engine, registry, clock } = harness()
    registry.register(
      testKind({
        runners: { first: runner(blocks), second: runner(done) },
        deadlines: { first: { silenceMs: 1_000 } },
      }),
    )
    capture()
    const started = await engine.start('test')
    if (!started.started) throw new Error('expected a start')
    await engine.whenSettled(started.operation.id)

    clock.advance(1_001)
    await drainMicrotasks()
    expect(messages()).toContain('operation step stalled; retrying once')

    clock.advance(1_001)
    await drainMicrotasks()
    expect(messages()).toContain('operation step failed')
    expect(field('operation finished', 'state')).toBe('failed')
    expect(field('operation finished', 'code')).toBe(STALLED_ERROR_CODE)
    expect(String(field('operation finished', 'steps'))).toContain('+1stall')
  })

  it('says an operation was already running rather than reporting a refusal', async () => {
    const { engine, registry } = harness()
    registry.register(testKind({ runners: { first: runner(blocks), second: runner(done) } }))
    const first = await engine.start('test')
    if (!first.started) throw new Error('expected a start')
    await engine.whenSettled(first.operation.id)
    capture()

    const second = await engine.start('test')
    expect(second).toMatchObject({ started: false, alreadyRunning: first.operation.id })
    expect(messages()).toContain('an operation of this group is already running')
  })

  it('records both sides of an adoption — what it inherited and what it concluded', async () => {
    const { store, registry } = harness()
    // A row the dead process left mid-flight, exactly as `adoption` builds one.
    await store.insert({
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
    })
    // The successor's kind consults reality and concludes `first` is finished.
    registry.register(
      testKind({
        reconcile: (operation: Operation) => ({
          ...operation,
          steps: (operation.steps ?? []).map((step) =>
            step.id === 'first' ? { ...step, state: 'done' as const } : step,
          ),
        }),
        runners: { first: runner(blocks), second: runner(done) },
      }),
    )
    capture()
    const successor = new OperationEngine({ store, registry, clock: fakeClock().clock })
    await successor.adoptOnBoot(() => undefined)

    expect(field('operation adopted on boot', 'wasSteps')).toBe('first=running second=pending')
    expect(String(field('operation adopted on boot', 'nowSteps'))).toContain('first=done')
    expect((await store.get('op_1'))?.state).toBe('done')
  })
})
