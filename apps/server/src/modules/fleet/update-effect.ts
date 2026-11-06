/**
 * APPLY AN UPDATE TO ONE MACHINE AS AN EFFECT RECORD (ADR 12 D5 E2, POD-6417).
 *
 * `machines.applyUpdate` asks the release feed for the machine's channel (the
 * network) and then grants the machine its update (a message to its daemon):
 * both outside the database, so the request creates a `machine.update` record
 * on the machine and the work runs from the record. Its result is the outcome
 * the machine's row will say (`MachineApplyOutcome`: granted, already current,
 * offline, refused…), which the route answers as it always did.
 *
 * PERMISSION: the `machines.applyUpdate` contract's gate (`authz.ts`): its role
 * floor against the account's role now, then `manage` on the machine, at
 * create, cancel and dismiss; and the hub role, as the route's 404.
 *
 * RECOVERY after a server stop: a grant may have reached the daemon, so the
 * record is `unknown`; the machine's row shows what it did, and Apply again is
 * safe (a machine already on the target answers `already-current`).
 *
 * Not the server's own update (`server.update`, the Operations engine,
 * POD-6358): that one replaces the server under its own feet.
 */

import {
  asMachineId,
  type EffectTarget,
  resolveMachineChannel,
  type UserId,
  type UserRole,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import { trpcErrorRefusal } from '../sync-write/family'
import { NO_TARGET, refuseTarget, type SyncWriteTarget } from '../sync-write/registry'
import { fleetAuthzDepsFor, fleetAuthzFailure } from './authz'

export const MACHINE_UPDATE_KIND = 'machine.update'

/** A grant that could not start within this is stale: Apply again. */
export const MACHINE_UPDATE_DEADLINE_MS = 60_000

/** How long the route waits: one release-feed read and one grant. */
export const MACHINE_UPDATE_WAIT_MS = 60_000

/** Nothing beyond the machine, which is the record's target. */
export const MachineUpdateInput = z.object({}).strict()
export type MachineUpdateInput = z.infer<typeof MachineUpdateInput>

export interface MachineUpdateEffectDeps {
  modules(): RegistryModules
  roleOf(user: UserId): Promise<UserRole | undefined>
  servesHub(): boolean
}

/** The apply gate for `principal` on machine `id`, as the target's answer. */
export async function machineUpdateTarget(
  deps: MachineUpdateEffectDeps,
  t: EffectTarget,
  principal: CommandPrincipal,
): Promise<SyncWriteTarget> {
  if (t.kind !== 'machine' || principal.kind === 'system') return undefined
  const refuse = (error: TRPCError) =>
    refuseTarget(trpcErrorRefusal(error) ?? { kind: 'unauthorized' })
  if (!deps.servesHub()) {
    return refuse(
      new TRPCError({
        code: 'NOT_FOUND',
        message: 'not available: this server does not run the hub role',
      }),
    )
  }
  const user = onBehalfOfUser(principal)
  const authz = await fleetAuthzDepsFor(
    deps.modules().machines,
    principal,
    user === null ? undefined : await deps.roleOf(user),
  )
  const refusal = await fleetAuthzFailure('machines.applyUpdate', { id: t.id }, authz)
  return refusal === undefined ? NO_TARGET : refuse(refusal)
}

export function registerMachineUpdateEffect(deps: MachineUpdateEffectDeps): void {
  const effects = deps.modules().effects
  if (effects === undefined) throw new Error('machine update effect: no effects module')
  effects.executors.register<MachineUpdateInput>({
    kind: MACHINE_UPDATE_KIND,
    input: MachineUpdateInput,
    target: async (t, principal) => await machineUpdateTarget(deps, t, principal),
    deadlineMs: MACHINE_UPDATE_DEADLINE_MS,
    run: async (ctx) => {
      const { machines, updates } = deps.modules()
      const machineId = asMachineId(ctx.record.target.id)
      const machine = (await machines.listMachines()).find(
        (candidate) => candidate.id === machineId,
      )
      if (!machine)
        return { status: 'failed', error: { code: 'not-found', message: 'machine not found' } }
      await ctx.stage('resolving')
      await updates.refreshTarget(
        resolveMachineChannel(machine.updateChannel, updates.fleetDefaultChannel()),
      )
      await ctx.stage('granting')
      // The outcome is what this machine's row will say. Callers must not infer
      // success from a granted-id list: an empty list has five different meanings.
      const outcome = await updates.authorizeMachine(machineId, {
        initiator: { kind: 'operator-apply' },
        eligibility: 'a person pressed Apply on this fleet row',
      })
      return { status: 'succeeded', result: outcome }
    },
    recover: async () => ({
      status: 'unknown',
      error: {
        code: 'lost-track',
        message: 'The server stopped while granting the update; the machine shows what it did.',
      },
    }),
  })
}
