/**
 * THE OPERATIONS ENGINE AS AN EFFECT EXECUTOR (ADR 12 D5 E3, POD-6358).
 *
 * Software update and server move are long, multi-step jobs: steps, deadlines,
 * re-adoption after a restart, an exclusion group, operator actions mid-run, a
 * sealed handoff. The engine keeps all of that. What changes is outward only:
 * the intent to run is an effect record created through `sync.submit`, the
 * engine is that kind's executor, and the record carries the standard `effect`
 * status group on the feed, so the UI has one way to show anything in progress.
 *
 * THE RECORD FOLLOWS ITS OPERATION.
 *  - `run` starts the operation, named after the record
 *    ({@link operationIdForEffect}), so a second dispatch or a recovery finds it
 *    and never starts another. If the exclusion group is already held, the
 *    record follows the operation that holds it: two people pressing Update see
 *    the same update, as before.
 *  - Before anything else it publishes `result: { operationId }`, the durable
 *    link that recovery and the old routes read, and that lets a client open
 *    the operation's step detail from the record.
 *  - Then it mirrors every persisted transition (the engine's `onChanged`):
 *    `running`/`waiting` → `running`, with the current step as the stage;
 *    `done` → `succeeded`; `failed` → `failed` with the operation's error;
 *    `canceled` → `cancelled`.
 *
 * CANCEL IS THE EFFECT EDIT. A committed `cancelRequested` asks the engine to
 * cancel; a step that cannot be undone refuses, and the record keeps following
 * to the operation's real end.
 *
 * STOPPING IS NOT CANCELLING. An update restarts the server that runs it. When
 * the runner stops, the run answers `running`: nothing is written, and the
 * successor's boot sweep hands the record to `recover`, which follows the
 * operation the successor's engine adopted. A record whose operation was never
 * created ends `failed` (`interrupted`): nothing ran.
 */

import type { EffectTarget } from '@podium/model'
import type { Operation } from '@podium/protocol'
import type { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import type { EffectRow } from '../../store/effects'
import type { EffectExecutor, EffectOutcome, EffectRunContext } from '../effects/registry'
import type { SyncWriteTarget } from '../sync-write/registry'
import type { OperationEngine } from './engine'
import type { OperationRow } from './store'

/** How long a request to run may wait to start before it expires unrun. */
export const OPERATION_EFFECT_DEADLINE_MS = 10 * 60 * 1000

/** The operation an effect record starts is named after the record. */
export const operationIdForEffect = (recordId: string): string => `op_${recordId}`

/** What the record's `result` holds, from the moment its operation is known. */
export interface OperationEffectResult {
  readonly operationId: string
}

/** The operation's id, read off a record's result. */
export function linkedOperationId(row: Pick<EffectRow, 'result'>): string | undefined {
  const result = row.result as Partial<OperationEffectResult> | undefined
  return typeof result?.operationId === 'string' ? result.operationId : undefined
}

/**
 * What a kind answers before its operation exists: the context to start it
 * with, or why it cannot start (the sentences that used to be thrown before an
 * operation was created, such as "Nothing has been published on this channel").
 */
export type OperationStartPlan<Ctx> =
  | { readonly context: Ctx; readonly createdBy?: string }
  | { readonly refused: { readonly code: string; readonly message: string } }

export interface OperationEffectKind<In, Ctx> {
  /** The effect kind (`server.update`). */
  readonly kind: string
  /** The engine kind it starts (`update`). */
  readonly operationKind: string
  readonly input: z.ZodType<In, z.ZodTypeDef, unknown>
  readonly deadlineMs?: number
  target(target: EffectTarget, principal: CommandPrincipal): Promise<SyncWriteTarget>
  admit?: EffectExecutor<In>['admit']
  publish?(input: In): unknown
  /** Whether the kind can start this record now (its server ports are known). */
  ready?(record: EffectRow): boolean
  prepare(record: EffectRow, input: In): Promise<OperationStartPlan<Ctx>>
  /** Told once, when this record's own operation has been created. */
  started?(operation: Operation, context: Ctx): void
}

export function operationEffectExecutor<In, Ctx>(
  engine: OperationEngine,
  def: OperationEffectKind<In, Ctx>,
): EffectExecutor<In> {
  return {
    kind: def.kind,
    input: def.input,
    target: async (target, principal) => await def.target(target, principal),
    ...(def.admit ? { admit: def.admit } : {}),
    deadlineMs: def.deadlineMs ?? OPERATION_EFFECT_DEADLINE_MS,
    ...(def.publish ? { publish: def.publish } : {}),
    ...(def.ready ? { ready: (record: EffectRow) => def.ready?.(record) ?? true } : {}),
    run: async (ctx) => {
      const own = operationIdForEffect(ctx.record.id)
      if ((await engine.get(own)) !== undefined) return await follow(engine, ctx, own)
      const plan = await def.prepare(ctx.record, ctx.input)
      if ('refused' in plan) return { status: 'failed', error: plan.refused }
      const started = await engine.start(def.operationKind, plan.context, {
        id: own,
        ...(plan.createdBy === undefined ? {} : { createdBy: plan.createdBy }),
      })
      if (started.started) {
        def.started?.(started.operation, plan.context)
        return await follow(engine, ctx, own)
      }
      if ('alreadyRunning' in started) return await follow(engine, ctx, started.alreadyRunning)
      return {
        status: 'failed',
        error: {
          code: 'no-operation-kind',
          message: `This server cannot run ${def.operationKind} operations.`,
        },
      }
    },
    recover: async (ctx) => {
      const operationId = linkedOperationId(ctx.record) ?? operationIdForEffect(ctx.record.id)
      if ((await engine.get(operationId)) === undefined) return INTERRUPTED
      return await follow(engine, ctx, operationId)
    },
  }
}

const INTERRUPTED: EffectOutcome = {
  status: 'failed',
  error: {
    code: 'interrupted',
    message: 'The server stopped before this began; nothing ran.',
  },
}

/** The step the operation is on: the one running, else the next one to run. */
export function operationStage(row: OperationRow): string {
  if (row.state === 'waiting') return 'waiting'
  const steps = row.operation?.steps ?? []
  const current =
    steps.find((step) => step.state === 'running' || step.state === 'stalled') ??
    steps.find((step) => step.state === 'pending')
  return current?.id ?? row.state
}

/** How the record ends for an operation that has ended; `undefined` while it runs. */
export function operationOutcome(row: OperationRow): EffectOutcome | undefined {
  const result: OperationEffectResult = { operationId: row.id }
  switch (row.state) {
    case 'done':
      return { status: 'succeeded', result }
    case 'failed': {
      const error = row.operation?.error
      return {
        status: 'failed',
        error: {
          code: error?.code ?? 'operation-failed',
          message: error?.message ?? 'The operation failed.',
        },
        result,
      }
    }
    case 'canceled':
      return { status: 'cancelled' }
    default:
      return undefined
  }
}

/**
 * Mirror one operation onto the record until it ends, the process stops, or it
 * vanishes. SUBSCRIBE BEFORE READING: each pass re-arms the wake before it
 * reads, so a transition between the read and the wait is never missed.
 */
async function follow<In>(
  engine: OperationEngine,
  ctx: EffectRunContext<In>,
  operationId: string,
): Promise<EffectOutcome> {
  let wake: () => void = () => undefined
  const arm = () =>
    new Promise<void>((resolve) => {
      wake = resolve
    })
  let changed = arm()
  const off = engine.onChanged((row) => {
    if (row.id === operationId) wake()
  })
  const onAbort = () => wake()
  ctx.signal.addEventListener('abort', onAbort)
  ctx.stopped.addEventListener('abort', onAbort)
  let linked = linkedOperationId(ctx.record) === operationId
  let stage = linked ? ctx.record.stage : undefined
  let cancelAsked = false
  try {
    for (;;) {
      changed = arm()
      if (ctx.stopped.aborted) return { status: 'running' }
      const row = await engine.get(operationId)
      if (row === undefined) {
        return {
          status: 'unknown',
          error: {
            code: 'lost-track',
            message: `Operation ${operationId} is no longer on record.`,
          },
        }
      }
      // The link is the first thing the record says, even of an operation that
      // has already ended: the old routes and recovery read it.
      const now = operationStage(row)
      if (!linked) {
        const link: OperationEffectResult = { operationId }
        await ctx.stage(now, link)
        linked = true
        stage = now
      }
      const ended = operationOutcome(row)
      if (ended !== undefined) return ended
      if (now !== stage) {
        await ctx.stage(now)
        stage = now
      }
      if (ctx.signal.aborted && !cancelAsked && (await ctx.cancelRequested())) {
        cancelAsked = true
        // A refusal (an irreversible step) leaves the operation running; the
        // record keeps following it to its real end.
        await engine.cancel(operationId)
        continue
      }
      await changed
    }
  } finally {
    off()
    ctx.signal.removeEventListener('abort', onAbort)
    ctx.stopped.removeEventListener('abort', onAbort)
  }
}
