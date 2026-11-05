/**
 * EFFECT RECORDS, THE TRIGGER AND THE SWEEP (ADR 12 D5 E2, POD-6357).
 *
 * Driven through the REAL composed server (`makeOracle`): the commands are
 * registered where `relay.ts` registers them, the runner is the one the server
 * starts, and every assertion reads back what the table and the change log hold.
 * A test that needs to control WHEN the trigger and the sweep run stops the
 * server's runner and drives its own over the same repository.
 */

import { type EffectStatus, mintDeviceId } from '@podium/model'
import type { SyncSubmitReply } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { EffectsModule } from '../../relay'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { appliedReply, changeRows, envelope, submit } from '../sync-write/outbox-test-support'
import { NO_TARGET } from '../sync-write/registry'
import type { EffectExecutor, EffectOutcome, EffectRunContext } from './registry'
import { EFFECT_RETENTION_MS, EffectsRunner } from './runner'

afterEach(() => disposeOracles())

const KIND = 'test.echo'
const Input = z.object({ text: z.string() })
type Input = z.infer<typeof Input>

interface Harness {
  readonly o: Oracle
  readonly effects: EffectsModule
  readonly runs: string[]
  readonly recovers: string[]
  clock: number
  /** Replaces what the next run answers. */
  outcome: (ctx: EffectRunContext<Input>) => Promise<EffectOutcome>
  recover: ((ctx: EffectRunContext<Input>) => Promise<EffectOutcome>) | undefined
}

async function harness(): Promise<Harness> {
  const h = {
    runs: [] as string[],
    recovers: [] as string[],
    clock: Date.parse('2026-11-04T10:00:00.000Z'),
    outcome: async (): Promise<EffectOutcome> => ({ status: 'succeeded', result: { ok: 1 } }),
    recover: undefined as Harness['recover'],
  } as Partial<Harness> & Pick<Harness, 'runs' | 'recovers' | 'clock' | 'outcome' | 'recover'>
  const o = await makeOracle({ now: () => h.clock })
  const effects = o.reg.modules.effects
  if (effects === undefined) throw new Error('the composed server has no effects module')
  const executor: EffectExecutor<Input> = {
    kind: KIND,
    input: Input,
    target: async () => NO_TARGET,
    deadlineMs: 60_000,
    publish: (input) => ({ length: input.text.length }),
    run: async (ctx) => {
      h.runs.push(ctx.record.id)
      return await h.outcome(ctx)
    },
    recover: async (ctx) => {
      h.recovers.push(ctx.record.id)
      if (h.recover === undefined) return { status: 'unknown' }
      return await h.recover(ctx)
    },
  }
  effects.executors.register(executor)
  return Object.assign(h, { o, effects }) as Harness
}

/** The server's own runner stopped, and a fresh one the test drives. */
async function manualRunner(h: Harness): Promise<EffectsRunner> {
  await h.effects.runner.stop()
  return new EffectsRunner({
    repo: h.o.store.effects,
    registry: h.effects.executors,
    now: () => h.clock,
    every: () => () => undefined,
  })
}

const createEnv = (id: string, extra: Record<string, unknown> = {}, mutationId?: string) =>
  envelope(
    'effects.create',
    { id, kind: KIND, target: { kind: 'issue', id: 'iss_x' }, input: { text: 'hello' }, ...extra },
    mutationId ?? `m-${crypto.randomUUID()}`,
  )

const newId = () => mintDeviceId('eff_')

function refusal(reply: SyncSubmitReply) {
  if (reply.outcome !== 'rejected') throw new Error(`expected a refusal: ${JSON.stringify(reply)}`)
  return reply.refusal
}

async function statusOf(h: Harness, id: string): Promise<EffectStatus | undefined> {
  return (await h.o.store.effects.get(id))?.status
}

async function effectRows(h: Harness, id: string) {
  return (await changeRows(h.o)).filter((row) => row.entity === 'effect' && row.entityId === id)
}

describe('creating an effect record', () => {
  it('commits it pending, runs it once after the commit, and settles it as status', async () => {
    const h = await harness()
    const id = newId()
    const env = createEnv(id)
    const reply = appliedReply(await submit(h.o, env))
    expect(reply.result).toEqual({ id, status: 'pending', cancelRequested: false })
    await h.effects.runner.idle()

    expect(h.runs).toEqual([id])
    const row = await h.o.store.effects.get(id)
    expect(row?.status).toBe('succeeded')
    expect(row?.result).toEqual({ ok: 1 })
    expect(row?.attempts).toBe(1)

    // The create's row carries the command; the status rows carry the record as
    // their cause and no mutationId, so the create's receipt covers only the create.
    const rows = await effectRows(h, id)
    expect(rows[0]?.mutationId).toBe(env.mutationId)
    expect(rows[0]?.causationId).toBe(env.mutationId)
    const statusRows = rows.slice(1)
    expect(statusRows.length).toBeGreaterThan(0)
    for (const r of statusRows) {
      expect(r.causationId).toBe(id)
      expect(r.mutationId ?? undefined).toBeUndefined()
    }
    // The feed carries what the kind publishes of its input, never the input.
    const last = JSON.parse(rows[rows.length - 1]?.payload ?? 'null')
    expect(last.input).toEqual({ length: 5 })
    expect(last.effect.status).toBe('succeeded')
    expect(JSON.stringify(rows.map((r) => r.payload))).not.toContain('hello')
  })

  it('a replay of the same envelope is the same record, run once', async () => {
    const h = await harness()
    const id = newId()
    const env = createEnv(id)
    appliedReply(await submit(h.o, env))
    expect(appliedReply(await submit(h.o, env)).replayed).toBe(true)
    await h.effects.runner.idle()
    expect(h.runs).toEqual([id])
  })

  it('refuses an existing id under a new command, an unserved kind, a bad input and a bad id', async () => {
    const h = await harness()
    const id = newId()
    appliedReply(await submit(h.o, createEnv(id)))
    expect(refusal(await submit(h.o, createEnv(id)))).toEqual({ kind: 'conflict' })
    expect(refusal(await submit(h.o, createEnv(newId(), { kind: 'test.nobody' })))).toEqual({
      kind: 'unauthorized',
    })
    expect(refusal(await submit(h.o, createEnv(newId(), { input: { text: 3 } })))).toEqual({
      kind: 'invalid',
      details: ['input.text'],
    })
    expect(refusal(await submit(h.o, createEnv('POD-6241'))).kind).toBe('invalid')
  })

  it('a write that rolls back dispatches nothing', async () => {
    const h = await harness()
    const seen: string[] = []
    h.o.store.effects.onCommitted((rows) => {
      for (const row of rows) seen.push(row.id)
    })
    const id = newId()
    await expect(
      h.o.store.transact(async () => {
        await h.o.store.effects.insert(
          {
            id,
            kind: KIND,
            target: { kind: 'issue', id: 'iss_x' },
            input: { text: 'x' },
            deadlineAt: undefined,
            createdBy: null,
          },
          h.clock,
        )
        throw new Error('roll back')
      }),
    ).rejects.toThrow('roll back')
    await h.effects.runner.idle()
    expect(seen).toEqual([])
    expect(h.runs).toEqual([])
    expect(await h.o.store.effects.get(id)).toBeUndefined()
    // The control: the same write, committed, is announced and run.
    const committed = newId()
    appliedReply(await submit(h.o, createEnv(committed)))
    await h.effects.runner.idle()
    expect(seen).toContain(committed)
    expect(h.runs).toEqual([committed])
  })
})

describe('the trigger runs a record exactly once', () => {
  it('two triggers racing for one pending record run the executor once', async () => {
    const h = await harness()
    const a = await manualRunner(h)
    const b = new EffectsRunner({
      repo: h.o.store.effects,
      registry: h.effects.executors,
      now: () => h.clock,
      every: () => () => undefined,
    })
    const id = newId()
    appliedReply(await submit(h.o, createEnv(id)))
    expect(await statusOf(h, id)).toBe('pending')
    await Promise.all([a.sweep(), b.sweep(), a.sweep()])
    await Promise.all([a.idle(), b.idle()])
    expect(h.runs).toEqual([id])
    expect(await statusOf(h, id)).toBe('succeeded')
  })
})

describe('the recovery sweep', () => {
  it('re-dispatches a pending record whose trigger was lost', async () => {
    const h = await harness()
    const runner = await manualRunner(h)
    const id = newId()
    appliedReply(await submit(h.o, createEnv(id)))
    expect(h.runs).toEqual([])
    await runner.sweep()
    await runner.idle()
    expect(h.runs).toEqual([id])
  })

  it('a record left running by a crash is checked, not run again: done is succeeded', async () => {
    const h = await harness()
    const runner = await manualRunner(h)
    const id = newId()
    appliedReply(await submit(h.o, createEnv(id)))
    // The server claimed it and stopped before it could say how it ended.
    expect((await h.o.store.effects.claim(id, h.clock))?.status).toBe('running')
    h.recover = async () => ({ status: 'succeeded', result: { found: true } })
    await runner.sweep()
    await runner.idle()
    expect(h.runs).toEqual([])
    expect(h.recovers).toEqual([id])
    expect((await h.o.store.effects.get(id))?.result).toEqual({ found: true })
    expect(await statusOf(h, id)).toBe('succeeded')
  })

  it('a record left running that the executor cannot check ends unknown', async () => {
    const h = await harness()
    const runner = await manualRunner(h)
    const id = newId()
    appliedReply(await submit(h.o, createEnv(id)))
    await h.o.store.effects.claim(id, h.clock)
    await runner.sweep()
    await runner.idle()
    expect(h.runs).toEqual([])
    const row = await h.o.store.effects.get(id)
    expect(row?.status).toBe('unknown')
    expect(row?.error?.code).toBe('lost-track')
  })

  it('a record past its deadline expires and never runs', async () => {
    const h = await harness()
    const runner = await manualRunner(h)
    const id = newId()
    appliedReply(await submit(h.o, createEnv(id, { deadlineMs: 1_000 })))
    h.clock += 1_001
    await runner.sweep()
    await runner.idle()
    expect(h.runs).toEqual([])
    const row = await h.o.store.effects.get(id)
    expect(row?.status).toBe('expired')
    expect(row?.error?.code).toBe('deadline')
  })

  it('prunes ended records after the retention window, but keeps failed and unknown', async () => {
    const h = await harness()
    const runner = await manualRunner(h)
    const ok = newId()
    const bad = newId()
    appliedReply(await submit(h.o, createEnv(ok)))
    await runner.sweep()
    await runner.idle()
    h.outcome = async () => ({ status: 'failed', error: { code: 'nope', message: 'no' } })
    appliedReply(await submit(h.o, createEnv(bad)))
    await runner.sweep()
    await runner.idle()
    h.clock += EFFECT_RETENTION_MS + 1
    await runner.sweep()
    expect((await h.o.store.effects.get(ok))?.deletedAt).toBeDefined()
    expect((await h.o.store.effects.get(bad))?.deletedAt).toBeUndefined()
    expect((await effectRows(h, ok)).at(-1)?.op).toBe('remove')
    // The tombstone is deleted once it has been off the feed for the window.
    h.clock += EFFECT_RETENTION_MS + 1
    await runner.sweep()
    expect(await h.o.store.effects.get(ok)).toBeUndefined()
  })
})

describe('cancel and dismiss', () => {
  it('cancel before the start ends it cancelled; it never runs', async () => {
    const h = await harness()
    const runner = await manualRunner(h)
    const id = newId()
    appliedReply(await submit(h.o, createEnv(id)))
    const reply = appliedReply(await submit(h.o, envelope('effects.cancel', { id }, 'c-1')))
    expect(reply.result).toEqual({ id, status: 'cancelled', cancelRequested: true })
    await runner.sweep()
    await runner.idle()
    expect(h.runs).toEqual([])
  })

  it('cancel while running reaches the executor, which ends it cancelled', async () => {
    const h = await harness()
    let started: () => void = () => undefined
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    h.outcome = async (ctx) => {
      started()
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()))
      expect(await ctx.cancelRequested()).toBe(true)
      return { status: 'cancelled' }
    }
    const id = newId()
    appliedReply(await submit(h.o, createEnv(id)))
    await running
    appliedReply(await submit(h.o, envelope('effects.cancel', { id }, 'c-2')))
    await h.effects.runner.idle()
    expect(await statusOf(h, id)).toBe('cancelled')
  })

  it('dismiss takes an ended record off the feed, and refuses one still pending', async () => {
    const h = await harness()
    const runner = await manualRunner(h)
    const id = newId()
    appliedReply(await submit(h.o, createEnv(id)))
    expect(refusal(await submit(h.o, envelope('effects.dismiss', { id }, 'd-1')))).toEqual({
      kind: 'conflict',
    })
    await runner.sweep()
    await runner.idle()
    appliedReply(await submit(h.o, envelope('effects.dismiss', { id }, 'd-2')))
    expect((await effectRows(h, id)).at(-1)?.op).toBe('remove')
  })
})

describe('an executor that throws', () => {
  it('ends unknown, never retried silently', async () => {
    const h = await harness()
    h.outcome = async () => {
      throw new Error('socket closed mid-merge')
    }
    const id = newId()
    appliedReply(await submit(h.o, createEnv(id)))
    await h.effects.runner.idle()
    const row = await h.o.store.effects.get(id)
    expect(row?.status).toBe('unknown')
    expect(row?.error?.code).toBe('executor-error')
    await h.effects.runner.sweep()
    await h.effects.runner.idle()
    expect(h.runs).toEqual([id])
  })
})

describe('an executor that is not ready yet (POD-6398)', () => {
  const READY_KIND = 'test.ready'

  async function readyHarness() {
    const h = await harness()
    const state = { ready: false, runs: [] as string[] }
    h.effects.executors.register<Input>({
      kind: READY_KIND,
      input: Input,
      target: async () => NO_TARGET,
      deadlineMs: 60_000,
      ready: () => state.ready,
      run: async (ctx) => {
        state.runs.push(ctx.record.id)
        return { status: 'succeeded' }
      },
    })
    const runner = await manualRunner(h)
    const create = (id: string) =>
      envelope(
        'effects.create',
        { id, kind: READY_KIND, target: { kind: 'issue', id: 'iss_x' }, input: { text: 'hi' } },
        `m-${crypto.randomUUID()}`,
      )
    return { h, state, runner, create }
  }

  it('stays pending, unclaimed, until it is ready; then a poke runs it once', async () => {
    const { h, state, runner, create } = await readyHarness()
    const id = newId()
    appliedReply(await submit(h.o, create(id)))
    await runner.sweep()
    await runner.idle()
    expect(state.runs).toEqual([])
    expect(await h.o.store.effects.get(id)).toMatchObject({ status: 'pending', attempts: 0 })

    state.ready = true
    await runner.poke(READY_KIND)
    await runner.poke(READY_KIND)
    await runner.idle()
    expect(state.runs).toEqual([id])
    expect(await statusOf(h, id)).toBe('succeeded')
  })

  it('a record that is never ready expires at its deadline and never runs', async () => {
    const { h, state, runner, create } = await readyHarness()
    const id = newId()
    appliedReply(await submit(h.o, create(id)))
    await runner.poke(READY_KIND)
    h.clock += 60_001
    await runner.sweep()
    await runner.idle()
    expect(state.runs).toEqual([])
    expect(await h.o.store.effects.get(id)).toMatchObject({
      status: 'expired',
      error: { code: 'deadline' },
    })
  })
})

describe('an executor whose work outlives its run (POD-6358)', () => {
  it('publishes a result while running, beside its stage', async () => {
    const h = await harness()
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let staged: () => void = () => undefined
    const stagedOnce = new Promise<void>((resolve) => {
      staged = resolve
    })
    h.outcome = async (ctx) => {
      await ctx.stage('first', { operationId: 'op_1' })
      staged()
      await held
      await ctx.stage('second')
      return { status: 'succeeded', result: { operationId: 'op_1', done: true } }
    }
    const id = newId()
    appliedReply(await submit(h.o, createEnv(id)))
    await stagedOnce
    const running = await h.o.store.effects.get(id)
    expect(running?.status).toBe('running')
    expect(running?.stage).toBe('first')
    expect(running?.result).toEqual({ operationId: 'op_1' })
    const onFeed = JSON.parse((await effectRows(h, id)).at(-1)?.payload ?? 'null')
    expect(onFeed.effect).toMatchObject({ status: 'running', stage: 'first' })
    expect(onFeed.result).toEqual({ operationId: 'op_1' })
    release()
    await h.effects.runner.idle()
    const row = await h.o.store.effects.get(id)
    // A stage without a result keeps the result it had.
    expect(row?.result).toEqual({ operationId: 'op_1', done: true })
    expect(row?.status).toBe('succeeded')
  })

  it('a run that answers running leaves the record running, and the next boot recovers it', async () => {
    const h = await harness()
    let started: () => void = () => undefined
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    h.outcome = async (ctx) => {
      await ctx.stage('waiting', { operationId: 'op_9' })
      started()
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()))
      // Not a cancel: this process is stopping, and the work carries on without it.
      expect(await ctx.cancelRequested()).toBe(false)
      return { status: 'running' }
    }
    const id = newId()
    appliedReply(await submit(h.o, createEnv(id)))
    await running
    await h.effects.runner.stop()
    const left = await h.o.store.effects.get(id)
    expect(left?.status).toBe('running')
    expect(left?.finishedAt).toBeUndefined()
    expect(left?.result).toEqual({ operationId: 'op_9' })

    // The successor's sweep hands it to the kind's recovery, which finds it done.
    h.recover = async (ctx) => ({
      status: 'succeeded',
      result: { ...(ctx.record.result as object), found: true },
    })
    const successor = new EffectsRunner({
      repo: h.o.store.effects,
      registry: h.effects.executors,
      now: () => h.clock,
      every: () => () => undefined,
    })
    await successor.sweep()
    await successor.idle()
    expect(h.recovers).toEqual([id])
    expect(h.runs).toEqual([id])
    const row = await h.o.store.effects.get(id)
    expect(row?.status).toBe('succeeded')
    expect(row?.result).toEqual({ operationId: 'op_9', found: true })
  })
})
