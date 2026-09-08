import type { Operation } from '@podium/protocol'
import { syncQueriesOver } from '../../store/executor/sync-drizzle'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it, vi } from 'vitest'
import { runDrizzleMigrations } from '../../migrations'
import { DRIZZLE_MIGRATIONS } from '../../migrations/drizzle-manifest.generated'
import { type OperationClock, OperationEngine, type OperationTimerHandle } from './engine'
import {
  type OperationKindDefinition,
  OperationKindRegistry,
  type StepOutcome,
  type StepRunner,
} from './kinds'
import { OperationStore } from './store'

function harness() {
  const db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
  const store = new OperationStore(syncQueriesOver(db))
  const registry = new OperationKindRegistry()
  const pending = new Map<number, () => void>()
  let timerId = 0
  const clock: OperationClock = {
    now: () => 0,
    setTimeout: (fn) => {
      const id = ++timerId
      pending.set(id, fn)
      return id
    },
    clearTimeout: (handle: OperationTimerHandle) => pending.delete(handle as number),
  }
  let minted = 0
  const onChanged = vi.fn()
  const engine = new OperationEngine({
    store,
    registry,
    clock,
    newId: () => `op_${++minted}`,
    onChanged,
  })
  return { store, registry, engine, onChanged, armed: () => pending.size }
}

const done = async (): Promise<StepOutcome> => ({ state: 'done' })
const blocks = async (): Promise<StepOutcome> => ({ state: 'running' })
const runner = (ensure: StepRunner['ensure'], reversible?: boolean): StepRunner => ({
  ensure,
  ...(reversible === undefined ? {} : { reversible }),
})

function kind(
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
  (operation?.steps ?? []).find((candidate) => candidate.id === id)

const drain = async () => {
  for (let index = 0; index < 100; index++) await Promise.resolve()
}

describe('coordinator handoff', () => {
  it('seals running bytes, drops later source writes, disarms timers, and never drives a successor', async () => {
    const { registry, engine, store, armed, onChanged } = harness()
    const successor = vi.fn(done)
    registry.register(
      kind({
        deadlines: { first: { silenceMs: 100 } },
        runners: {
          first: runner(async ({ operation, step: current }) => {
            await engine.sealForHandoff(operation.id, current.id, {
              step: { detail: 'detaching' },
              detailsPatch: { handoff: { target: 'other-machine' } },
            })
            await engine.recordProgress(operation.id, current.id, { detail: 'dropped' })
            return { state: 'handed-off' }
          }),
          second: runner(successor),
        },
      }),
    )

    const started = await engine.start('test')
    expect(started.started).toBe(true)
    await engine.whenSettled('op_1')
    const sealed = store.get('op_1')
    expect((await sealed)?.state).toBe('running')
    expect(step((await sealed)?.operation, 'first')).toMatchObject({
      state: 'running',
      detail: 'detaching',
    })
    expect(step((await sealed)?.operation, 'second')?.state).toBe('pending')
    expect((await sealed)?.operation?.details).toMatchObject({
      _handoff: { stepId: 'first' },
      handoff: { target: 'other-machine' },
    })
    expect(successor).not.toHaveBeenCalled()
    expect(armed()).toBe(0)

    expect(onChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'running' }), 'running')
    const bytes = (await sealed)?.payload
    await engine.recordProgress('op_1', 'first', { state: 'done' })
    await engine.settleAsk('op_1', 'anything')
    expect(await engine.cancel('op_1')).toEqual({ canceled: false, refused: 'handed-off' })
    expect((await store.get('op_1'))?.payload).toBe(bytes)
    await expect(engine.sealForHandoff('op_1', 'first')).rejects.toThrow(/already sealed/)
  })

  it('fails a handed-off outcome that has no durable seal', async () => {
    const { registry, engine, store } = harness()
    registry.register(
      kind({
        runners: {
          first: runner(async () => ({ state: 'handed-off' })),
          second: runner(done),
        },
      }),
    )

    await engine.start('test')
    await engine.whenSettled('op_1')
    expect((await store.get('op_1'))?.state).toBe('failed')
    expect((await store.get('op_1'))?.operation?.error?.code).toBe('handoff-unsealed')
  })

  it('reclaims only inside the sealing runner and frees the exclusion group', async () => {
    const { registry, engine, store, onChanged } = harness()
    registry.register(
      kind({
        runners: {
          first: runner(async ({ operation, step: current }) => {
            await engine.sealForHandoff(operation.id, current.id)
            engine.reclaimHandoff(operation.id)
            expect(() => engine.reclaimHandoff(operation.id)).toThrow(/reclaimable/)
            return { state: 'failed', error: { code: 'pre-promote-failure' } }
          }),
          second: runner(done),
        },
      }),
    )

    await engine.start('test')
    await engine.whenSettled('op_1')
    expect((await store.get('op_1'))?.state).toBe('failed')
    expect((await store.get('op_1'))?.operation?.details).not.toHaveProperty('_handoff')
    expect(onChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'failed' }), 'running')
    expect(await engine.start('test')).toMatchObject({ started: true })
  })

  it('dispatches a projected sealed action outside a blocked runner queue without changing row bytes', async () => {
    const { registry, engine, store } = harness()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let fact = 'uncertain'
    const onAction = vi.fn(async () => {
      fact = 'resolved'
      return { outcome: 'resolved-committed' }
    })
    registry.register(
      kind({
        runners: {
          first: runner(async ({ operation, step: current }) => {
            await engine.sealForHandoff(operation.id, current.id)
            await blocked
            return { state: 'handed-off' }
          }),
          second: runner(done),
        },
        projectSealed: (operation) => ({
          ...operation,
          awaiting: [{ id: 'recover', required: true }],
        }),
        onAction,
      }),
    )

    await engine.start('test')
    await drain()
    expect(engine.isSealed('op_1')).toBe(true)
    const before = (await store.get('op_1'))?.payload
    expect(
      await engine.dispatchAction(
        'op_1',
        'recover',
        { kind: 'system', job: 'test' },
        { settleAsk: true },
      ),
    ).toEqual({ handled: true, result: { outcome: 'resolved-committed' } })
    expect(fact).toBe('resolved')
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ mode: 'sealed' }))
    expect((await store.get('op_1'))?.payload).toBe(before)

    release()
    await engine.whenSettled('op_1')
  })
})

describe('operation cancellation cleanup', () => {
  it('coalesces concurrent cancel calls and records structured cleanup', async () => {
    const { registry, engine, store } = harness()
    const onCancel = vi.fn(async () => ({
      cleanup: 'complete' as const,
      stepPatches: { first: { detail: 'staging removed' } },
      detailsPatch: { targetAborted: true },
    }))
    registry.register(
      kind({
        runners: { first: runner(blocks, true), second: runner(done) },
        onCancel,
      }),
    )
    await engine.start('test')
    await engine.whenSettled('op_1')

    const [first, second] = await Promise.all([engine.cancel('op_1'), engine.cancel('op_1')])
    expect(first).toEqual(second)
    expect(onCancel).toHaveBeenCalledOnce()
    expect((await store.get('op_1'))?.state).toBe('canceled')
    expect(step((await store.get('op_1'))?.operation, 'first')?.detail).toBe('staging removed')
    expect((await store.get('op_1'))?.operation?.details).toMatchObject({
      targetAborted: true,
      cleanup: { status: 'complete' },
    })
  })

  it('keeps cancel terminal on cleanup failure and lets the janitor converge history', async () => {
    const { registry, engine, store, onChanged } = harness()
    const onCancel = vi
      .fn()
      .mockRejectedValueOnce(new Error('target offline'))
      .mockResolvedValueOnce({ cleanup: 'complete' as const })
    registry.register(
      kind({
        runners: { first: runner(blocks, true), second: runner(done) },
        onCancel,
      }),
    )
    await engine.start('test')
    await engine.whenSettled('op_1')

    await engine.cancel('op_1')
    expect((await store.get('op_1'))?.operation?.details).toMatchObject({
      cleanup: {
        status: 'pending',
        error: 'target offline',
        pending: [{ what: 'operation cleanup', retryable: true }],
      },
    })
    expect(await engine.retryPendingCleanup()).toBe(1)
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(onChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'canceled' }), 'canceled')
    expect((await store.get('op_1'))?.operation?.details).toMatchObject({
      cleanup: { status: 'complete' },
    })
  })
})
