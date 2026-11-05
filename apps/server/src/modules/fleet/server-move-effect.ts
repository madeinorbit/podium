/**
 * A SERVER MOVE AS AN EFFECT RECORD (ADR 12 D5 E3, POD-6358).
 *
 * `server.move` is the intent to move this Podium server onto another paired
 * machine. Its record is created through `sync.submit` (by the old
 * `machines.moveServer` route today); the Operations engine's `server-move`
 * kind is its executor (`operations/effects.ts`). The engine keeps the whole
 * transfer: its steps, the reauthorization at every apply phase, the sealed
 * handoff to the successor. The successor boots with the transferred database,
 * finds the record still `running`, and its boot sweep follows the operation it
 * adopted to its end.
 *
 *  - TARGET: the destination machine. Who may ask is what `machines.moveServer`
 *    requires: an administrator who may `manage` that machine.
 *  - INPUT: the route's input as it is, confirmation included; nothing secret.
 *  - WHO: `authorizedBy` is the record's actor, which the engine reauthorizes
 *    from durable identity at every phase, never from a request.
 */

import { randomUUID } from 'node:crypto'
import { machineMoveServerInput } from '@podium/commands'
import { asMachineId, type UserId, type UserRole } from '@podium/model'
import type { z } from 'zod'
import { checkMachineVerb, ownershipSnapshotFromMachines } from '../../machine-access'
import type { RegistryModules } from '../../relay'
import type { EffectExecutorRegistry } from '../effects/registry'
import { operationEffectExecutor } from '../operations/effects'
import { SERVER_MOVE_EFFECT_KIND } from '../operations/instance-effect-kinds'
import type { OperationEngine } from '../operations/engine'
import { serverMoveAuthorization } from '../server-transfer/authorization'
import {
  SERVER_MOVE_OPERATION_KIND,
  type ServerMoveContext,
  serverMoveFaultHook,
} from '../server-transfer/operation'
import { normalizedPublicUrl, resolvedTransferPort } from '../server-transfer/service'
import { NO_TARGET } from '../sync-write/registry'

export { SERVER_MOVE_EFFECT_KIND } from '../operations/instance-effect-kinds'

export type ServerMoveEffectInput = z.infer<typeof machineMoveServerInput>

export function registerServerMoveEffect(deps: {
  readonly executors: EffectExecutorRegistry
  readonly engine: OperationEngine
  /** The composed modules, read per call (registered before they exist). */
  modules(): RegistryModules
  roleOf(userId: UserId): Promise<UserRole | undefined>
}): void {
  deps.executors.register(
    operationEffectExecutor<ServerMoveEffectInput, ServerMoveContext>(deps.engine, {
      kind: SERVER_MOVE_EFFECT_KIND,
      operationKind: SERVER_MOVE_OPERATION_KIND,
      input: machineMoveServerInput,
      target: async (target, principal) => {
        if (target.kind !== 'machine' || principal.kind === 'system') return undefined
        if (principal.capability.role !== 'admin') return undefined
        const failure = checkMachineVerb(
          principal,
          asMachineId(target.id),
          await ownershipSnapshotFromMachines(deps.modules().machines),
          'manage',
        )
        return failure ? undefined : NO_TARGET
      },
      admit: async (input, target) =>
        input.targetMachineId === target.id ? undefined : { kind: 'invalid', details: ['target'] },
      prepare: async (record, input) => {
        const modules = deps.modules()
        const publicUrl = normalizedPublicUrl(input)
        const port = resolvedTransferPort(input, publicUrl)
        const authorizedBy = record.actor ?? `system:effect:${record.id}`
        const crash = serverMoveFaultHook()
        const retryOf = (await deps.engine.history(SERVER_MOVE_OPERATION_KIND, 1)).find(
          (row) => row.state === 'failed' || row.state === 'canceled',
        )?.id
        return {
          context: {
            service: modules.serverTransfer,
            engine: deps.engine,
            input: { ...input, publicUrl, port },
            authorization: serverMoveAuthorization({
              authorizedBy,
              targetMachineId: input.targetMachineId,
              machines: modules.machines,
              roleOf: deps.roleOf,
            }),
            authorizedBy,
            transferId: randomUUID(),
            sourceMachineId: modules.serverTransfer.sourceMachineId(),
            publicUrl,
            bindHost: input.bindHost,
            port,
            ...(retryOf ? { retryOf } : {}),
            ...(crash ? { crash } : {}),
          },
          createdBy: authorizedBy,
        }
      },
    }),
  )
}
