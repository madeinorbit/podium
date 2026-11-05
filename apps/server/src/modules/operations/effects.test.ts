/**
 * AN OPERATION STARTED FROM AN EFFECT RECORD (ADR 12 D5 E3, POD-6358).
 *
 * Driven through the REAL composed server (`makeOracle`): the record is created
 * through `sync.submit`, the runner is the one the server starts, the engine is
 * the server's own. The operation kind is a test kind whose first step hands its
 * work out (`running`) until the test reports progress, so each assertion can
 * look at the record while its operation is mid-flight.
 *
 * A RESTART is the composed runner and engine stopped, and a successor engine
 * and runner built over the same database, the way a new process builds them:
 * the engine adopts the operation, the runner's boot sweep recovers the record.
 */

import { mintDeviceId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { EffectsModule } from '../../relay'
import { EffectExecutorRegistry } from '../effects/registry'
import { EffectsRunner } from '../effects/runner'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { appliedReply, changeRows, envelope, submit } from '../sync-write/outbox-test-support'
import { NO_TARGET } from '../sync-write/registry'
import { type OperationStartPlan, operationEffectExecutor, operationIdForEffect } from './effects'
import { OperationEngine, systemOperationClock } from './engine'
import type { OperationKindDefinition, StepOutcome } from './kinds'

afterEach(() => disposeOracles())

const EFFECT_KIND = 'test.operation'
const OPERATION_KIND = 'test-op'
const Input = z.object({ label: z.string() })
type Input = z.infer<typeof Input>

interface Harness {
  readonly o: Oracle
  readonly effects: EffectsModule
  readonly engine: OperationEngine
  /** How many operations the kind planned: one per operation that exists. */
  plans: number
  /** What `prepare` answers next. */
  prepare: (input: Input) => OperationStartPlan<{ label: string }>
  /** What the first step answers (default: hands its work out). */
  first: () => Promise<StepOutcome>
  firstReversible: boolean
}

function operationKind(h: Pick<Harness, 'first' | 'firstReversible'> & { plans: number }) {
  return {
    kind: OPERATION_KIND,
    exclusionGroup: 'test-lifecycle',
    plan: () => {
      h.plans += 1
      return { steps: [{ id: 'fetch' }, { id: 'apply' }] }
    },
    reconcile: (operation) => operation,
    runners: {
      fetch: {
        ensure: async () => await h.first(),
        get reversible() {
          return h.firstReversible
        },
      },
      apply: { ensure: async () => ({ state: 'done' }) },
    },
  } satisfies OperationKindDefinition<unknown, unknown>
}

function executorOver(engine: OperationEngine, h: Pick<Harness, 'prepare'>) {
  return operationEffectExecutor<Input, { label: string }>(engine, {
    kind: EFFECT_KIND,
    operationKind: OPERATION_KIND,
    input: Input,
    target: async () => NO_TARGET,
    prepare: async (_record, input) => h.prepare(input),
  })
}

async function harness(): Promise<Harness> {
  const o = await makeOracle()
  const effects = o.reg.modules.effects
  if (effects === undefined) throw new Error('the composed server has no effects module')
  const engine = o.reg.modules.operations.engine
  const h = {
    o,
    effects,
    engine,
    plans: 0,
    prepare: (input: Input) => ({ context: { label: input.label }, createdBy: 'user' }),
    first: async (): Promise<StepOutcome> => ({ state: 'running' }),
    firstReversible: false,
  } as Harness
  o.reg.modules.operations.kinds.register(operationKind(h))
  effects.executors.register(executorOver(engine, h))
  return h
}

const create = (id: string) =>
  envelope(
    'effects.create',
    { id, kind: EFFECT_KIND, target: { kind: 'machine', id: 'mach_x' }, input: { label: 'go' } },
    `m-${crypto.randomUUID()}`,
  )

const newId = () => mintDeviceId('eff_')

async function record(h: Harness, id: string) {
  return await h.o.store.effects.get(id)
}

/** Resolves once the record satisfies `check`, read after each of its commits. */
async function until(
  h: Harness,
  id: string,
  check: (row: NonNullable<Awaited<ReturnType<typeof record>>>) => boolean,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const row = await record(h, id)
    if (row !== undefined && check(row)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`effect ${id} never got there: ${JSON.stringify(await record(h, id))}`)
}

/** The record as every device reads it: its rows on the change log, in order. */
async function feedOf(h: Harness, id: string) {
  return (await changeRows(h.o))
    .filter((row) => row.entity === 'effect' && row.entityId === id)
    .map(
      (row) =>
        JSON.parse(row.payload ?? 'null') as {
          effect: { status: string; stage?: string }
          result?: unknown
        },
    )
}

describe('an operation started from an effect record', () => {
  it('runs as the record: pending, running at each step with its operation, then succeeded', async () => {
    const h = await harness()
    const id = newId()
    const opId = operationIdForEffect(id)
    appliedReply(await submit(h.o, create(id)))
    await until(h, id, (row) => row.stage === 'fetch')

    const running = await record(h, id)
    expect(running?.status).toBe('running')
    expect(running?.result).toEqual({ operationId: opId })
    expect((await h.engine.get(opId))?.state).toBe('running')

    await h.engine.recordProgress(opId, 'fetch', { state: 'done' })
    await h.effects.runner.idle()
    const row = await record(h, id)
    expect(row?.status).toBe('succeeded')
    expect(row?.result).toEqual({ operationId: opId })
    expect(h.plans).toBe(1)

    // Every device reads the standard status group off the feed.
    const feed = await feedOf(h, id)
    expect(feed[0]?.effect.status).toBe('pending')
    expect(feed.some((r) => r.effect.status === 'running' && r.effect.stage === 'fetch')).toBe(true)
    expect(feed.find((r) => r.effect.stage === 'fetch')?.result).toEqual({ operationId: opId })
    expect(feed.at(-1)?.effect.status).toBe('succeeded')
  })

  it('a failed operation fails the record with the operation’s own error', async () => {
    const h = await harness()
    h.first = async () => ({ state: 'failed', error: { code: 'download', message: 'No bundle.' } })
    const id = newId()
    appliedReply(await submit(h.o, create(id)))
    await until(h, id, (row) => row.status === 'failed')
    const row = await record(h, id)
    expect(row?.error).toEqual({ code: 'download', message: 'No bundle.' })
    expect(row?.result).toEqual({ operationId: operationIdForEffect(id) })
  })

  it('an operation cancelled by its own control ends the record cancelled', async () => {
    const h = await harness()
    h.firstReversible = true
    const id = newId()
    appliedReply(await submit(h.o, create(id)))
    await until(h, id, (row) => row.stage === 'fetch')
    const cancel = await h.engine.cancel(operationIdForEffect(id))
    expect(cancel.canceled).toBe(true)
    await until(h, id, (row) => row.status === 'cancelled')
  })

  it('a start the kind refuses fails the record with the reason, and no operation exists', async () => {
    const h = await harness()
    h.prepare = () => ({
      refused: { code: 'precondition', message: 'Nothing has been published yet.' },
    })
    const id = newId()
    appliedReply(await submit(h.o, create(id)))
    await until(h, id, (row) => row.status === 'failed')
    expect((await record(h, id))?.error).toEqual({
      code: 'precondition',
      message: 'Nothing has been published yet.',
    })
    expect(await h.engine.get(operationIdForEffect(id))).toBeUndefined()
    expect(h.plans).toBe(0)
  })

  it('a second record while the group is held follows the running operation to its end', async () => {
    const h = await harness()
    const first = newId()
    const second = newId()
    const opId = operationIdForEffect(first)
    appliedReply(await submit(h.o, create(first)))
    await until(h, first, (row) => row.stage === 'fetch')
    appliedReply(await submit(h.o, create(second)))
    await until(h, second, (row) => row.stage === 'fetch')
    expect((await record(h, second))?.result).toEqual({ operationId: opId })
    expect(h.plans).toBe(1)

    await h.engine.recordProgress(opId, 'fetch', { state: 'done' })
    await h.effects.runner.idle()
    expect((await record(h, first))?.status).toBe('succeeded')
    expect((await record(h, second))?.status).toBe('succeeded')
  })
})

describe('cancelling the record', () => {
  it('asks the engine to cancel; a reversible step ends it cancelled', async () => {
    const h = await harness()
    h.firstReversible = true
    const id = newId()
    appliedReply(await submit(h.o, create(id)))
    await until(h, id, (row) => row.stage === 'fetch')
    appliedReply(await submit(h.o, envelope('effects.cancel', { id }, 'c-1')))
    await until(h, id, (row) => row.status === 'cancelled')
    expect((await h.engine.get(operationIdForEffect(id)))?.state).toBe('canceled')
    // It still names the operation it was for.
    expect((await record(h, id))?.result).toEqual({ operationId: operationIdForEffect(id) })
  })

  it('an irreversible step refuses: the record keeps following, to the operation’s real end', async () => {
    const h = await harness()
    const id = newId()
    const opId = operationIdForEffect(id)
    appliedReply(await submit(h.o, create(id)))
    await until(h, id, (row) => row.stage === 'fetch')
    appliedReply(await submit(h.o, envelope('effects.cancel', { id }, 'c-2')))
    await until(h, id, (row) => row.cancelRequested)
    // The engine was asked and said no: the operation is still running.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await h.engine.get(opId))?.state).toBe('running')
    expect((await record(h, id))?.status).toBe('running')

    await h.engine.recordProgress(opId, 'fetch', { state: 'done' })
    await until(h, id, (row) => row.status === 'succeeded')
  })
})

describe('a server restart', () => {
  /** The composed engine and runner stopped; a successor pair over the same database. */
  async function restart(h: Harness) {
    await h.effects.runner.stop()
    h.engine.stop()
    const kinds = h.o.reg.modules.operations.kinds
    const engine = new OperationEngine({
      store: h.o.store.operations,
      registry: kinds,
      clock: systemOperationClock,
    })
    const executors = new EffectExecutorRegistry()
    executors.register(executorOver(engine, h))
    const runner = new EffectsRunner({
      repo: h.o.store.effects,
      registry: executors,
      now: () => Date.now(),
      every: () => () => undefined,
    })
    return { engine, runner }
  }

  it('leaves the record running, and the successor follows the adopted operation to its end', async () => {
    const h = await harness()
    const id = newId()
    const opId = operationIdForEffect(id)
    appliedReply(await submit(h.o, create(id)))
    await until(h, id, (row) => row.stage === 'fetch')

    const next = await restart(h)
    // Stopping is not cancelling: nothing was settled, nothing was cancelled.
    const left = await record(h, id)
    expect(left?.status).toBe('running')
    expect(left?.cancelRequested).toBe(false)
    expect((await next.engine.get(opId))?.state).toBe('running')

    await next.engine.adoptOnBoot(() => undefined)
    await next.runner.sweep()
    await next.engine.recordProgress(opId, 'fetch', { state: 'done' })
    await until(h, id, (row) => row.status === 'succeeded')
    await next.runner.stop()
    next.engine.stop()
    // Recovery found the record's own operation; it never planned a second one.
    expect(h.plans).toBe(1)
  })

  it('a record whose operation never began is failed as interrupted on recovery', async () => {
    const h = await harness()
    const next = await restart(h)
    const id = newId()
    appliedReply(await submit(h.o, create(id)))
    // Claimed, then the process stopped before the operation was created.
    await h.o.store.effects.claim(id, Date.now())
    await next.runner.sweep()
    await next.runner.idle()
    const row = await record(h, id)
    expect(row?.status).toBe('failed')
    expect(row?.error?.code).toBe('interrupted')
    expect(h.plans).toBe(0)
    await next.runner.stop()
    next.engine.stop()
  })
})
