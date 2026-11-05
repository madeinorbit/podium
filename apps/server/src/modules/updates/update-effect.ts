/**
 * A SOFTWARE UPDATE AS AN EFFECT RECORD (ADR 12 D5 E3, POD-6358).
 *
 * `server.update` is the intent to update Podium. Its record is created through
 * `sync.submit` (by the old `updates.start` route today, by any client
 * tomorrow); the Operations engine's `update` kind is its executor
 * (`operations/effects.ts`), and the record carries the standard status: pending,
 * running at the current step, then how the update ended.
 *
 *  - TARGET: the server's own machine. The update is the instance's, and the
 *    record's audience is the target's (today: its creator).
 *  - WHO: a person. `updates.start` was open to every signed-in person and to
 *    no agent; the record keeps exactly that.
 *  - PORTS: an update needs the server's process ports (the publisher, the
 *    restart request, the served stamps). The old route hands its own request's
 *    ports to the one record it creates, which is what that route always ran
 *    with; any other record runs with the ports the server bound at boot.
 *    Until one of the two is there, the record is not ready and stays pending.
 */

import type { MachineId } from '@podium/model'
import { z } from 'zod'
import type { EffectExecutorRegistry } from '../effects/registry'
import type { EffectsRunner } from '../effects/runner'
import { operationEffectExecutor } from '../operations/effects'
import { UPDATE_EFFECT_KIND } from '../operations/instance-effect-kinds'
import type { OperationEngine } from '../operations/engine'
import { NO_TARGET } from '../sync-write/registry'
import { UPDATE_OPERATION_KIND, type UpdateOperationContext, type UpdateSurface } from './operation'
import { logWaveDecision, type UpdateStartPorts, updateStartPlan } from './trpc'

export { UPDATE_EFFECT_KIND } from '../operations/instance-effect-kinds'

/** An update's record targets the server's own machine. */
export const updateEffectTarget = (hostMachineId: MachineId) =>
  ({ kind: 'machine', id: hostMachineId }) as const

export const UpdateEffectInput = z
  .object({
    /** The surface that asked (`desktop`, `web`, …), for the asks it raises. */
    surface: z.string().min(1).optional(),
    /** A retry's remainder: only these machines. */
    onlyMachines: z.array(z.string().min(1)).optional(),
    /** The operation this retries the remainder of. */
    retryOf: z.string().min(1).optional(),
  })
  .strict()
export type UpdateEffectInput = z.infer<typeof UpdateEffectInput>

export interface UpdateEffects {
  /** The server's own ports, once boot has assembled them. */
  bindPorts(ports: UpdateStartPorts): void
  /**
   * An old route's own request ports, for the one record it is about to
   * create. Returns the hand-back the route calls when it has its answer.
   */
  handPorts(recordId: string, ports: UpdateStartPorts): () => void
}

export function registerUpdateEffect(deps: {
  readonly executors: EffectExecutorRegistry
  readonly runner: Pick<EffectsRunner, 'poke'>
  readonly engine: OperationEngine
  readonly hostMachineId: MachineId
}): UpdateEffects {
  let bound: UpdateStartPorts | undefined
  /** In-flight route calls' ports, by the record each one created. */
  const handed = new Map<string, UpdateStartPorts>()
  const portsFor = (recordId: string) => handed.get(recordId) ?? bound

  deps.executors.register(
    operationEffectExecutor<UpdateEffectInput, UpdateOperationContext>(deps.engine, {
      kind: UPDATE_EFFECT_KIND,
      operationKind: UPDATE_OPERATION_KIND,
      input: UpdateEffectInput,
      target: async (target, principal) =>
        principal.kind === 'user' && target.kind === 'machine' ? NO_TARGET : undefined,
      admit: async (_input, target) =>
        target.id === deps.hostMachineId ? undefined : { kind: 'invalid', details: ['target'] },
      ready: (record) => portsFor(record.id) !== undefined,
      prepare: async (record, input) => {
        const ports = portsFor(record.id)
        handed.delete(record.id)
        if (ports === undefined) {
          return {
            refused: { code: 'not-ready', message: 'This server is not ready to update yet.' },
          }
        }
        return await updateStartPlan(ports, {
          ...(input.surface ? { surface: input.surface as UpdateSurface } : {}),
          ...(input.onlyMachines ? { onlyMachines: input.onlyMachines } : {}),
          ...(input.retryOf ? { retryOf: input.retryOf } : {}),
        })
      },
      started: (operation, context) => logWaveDecision(context.updates, context.channel, operation),
    }),
  )

  return {
    bindPorts: (ports) => {
      bound = ports
      // A record that waited for the ports runs now, not at the next sweep.
      void deps.runner.poke(UPDATE_EFFECT_KIND)
    },
    handPorts: (recordId, ports) => {
      handed.set(recordId, ports)
      return () => {
        handed.delete(recordId)
      }
    },
  }
}
