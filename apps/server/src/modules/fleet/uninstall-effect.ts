/**
 * UNINSTALL PODIUM FROM ONE MACHINE AS AN EFFECT RECORD (managed installs §12
 * item 14).
 *
 * `machines.uninstall` is the machine menu's "Uninstall Podium". It asks the
 * machine's daemon to run `podium uninstall` (a message to its daemon, outside
 * the database), so the request creates a `machine.uninstall` record on the
 * machine and the work runs from the record. The daemon undoes Podium's edits
 * in the person's harness folders, answers with each edit's outcome, and then
 * removes Podium's services and files on its own; this server removes the
 * machine once the daemon has answered.
 *
 * Refused, with the reason as the record's error: the machine that hosts this
 * server (uninstalling it would take the server with it), a machine whose
 * daemon is not connected, and a daemon too old to offer machine.uninstall.v1.
 * The person then runs `podium uninstall` on the machine itself.
 *
 * PERMISSION: the `machines.uninstall` contract's gate (`authz.ts`), as for
 * `machines.revoke`: `manage` on the machine; and the hub role, as the route's 404.
 *
 * RECOVERY after a server stop: the request may have reached the daemon, so
 * the record is `unknown`; the machine's row shows whether it is still there.
 */

import {
  asMachineId,
  type EffectTarget,
  type MachineId,
  type UserId,
  type UserRole,
} from '@podium/model'
import { CAP_MACHINE_UNINSTALL, type UninstallEditOutcome } from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import { trpcErrorRefusal } from '../sync-write/family'
import { NO_TARGET, refuseTarget, type SyncWriteTarget } from '../sync-write/registry'
import { fleetAuthzDepsFor, fleetAuthzFailure } from './authz'

export const MACHINE_UNINSTALL_KIND = 'machine.uninstall'

/** A request that could not start within this is stale: ask again. */
export const MACHINE_UNINSTALL_DEADLINE_MS = 60_000

/** How long the route waits: the daemon undoes every recorded edit first. */
export const MACHINE_UNINSTALL_WAIT_MS = 90_000

export const MachineUninstallInput = z
  .object({
    /** Remove Podium's files even when an edit could not be undone. */
    force: z.boolean().optional(),
  })
  .strict()
export type MachineUninstallInput = z.infer<typeof MachineUninstallInput>

/** What the route answers once the daemon has: each edit's outcome. */
export interface MachineUninstallResult {
  outcomes: UninstallEditOutcome[]
  /** False when Podium's files stay on the machine because an edit was not undone. */
  removesState: boolean
}

export interface MachineUninstallEffectDeps {
  modules(): RegistryModules
  roleOf(user: UserId): Promise<UserRole | undefined>
  servesHub(): boolean
  /** The machine this server runs on, which is never uninstalled from here. */
  hostMachineId(): MachineId | undefined
}

/** The gate for `principal` on machine `id`, as the target's answer. */
export async function machineUninstallTarget(
  deps: MachineUninstallEffectDeps,
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
  const refusal = await fleetAuthzFailure('machines.uninstall', { id: t.id }, authz)
  return refusal === undefined ? NO_TARGET : refuse(refusal)
}

const failed = (code: string, message: string) =>
  ({ status: 'failed', error: { code, message } }) as const

export function registerMachineUninstallEffect(deps: MachineUninstallEffectDeps): void {
  const effects = deps.modules().effects
  if (effects === undefined) throw new Error('machine uninstall effect: no effects module')
  effects.executors.register<MachineUninstallInput>({
    kind: MACHINE_UNINSTALL_KIND,
    input: MachineUninstallInput,
    target: async (t, principal) => await machineUninstallTarget(deps, t, principal),
    deadlineMs: MACHINE_UNINSTALL_DEADLINE_MS,
    run: async (ctx) => {
      const { machines, rpc } = deps.modules()
      const machineId = asMachineId(ctx.record.target.id)
      const machine = (await machines.listMachines()).find(
        (candidate) => candidate.id === machineId,
      )
      if (!machine || machine.revokedAt) return failed('not-found', 'machine not found')
      if (machineId === deps.hostMachineId())
        return failed(
          'hosts-server',
          'This machine runs the server. Run podium uninstall on it instead.',
        )
      // False as well when no daemon is connected: both leave it to the machine.
      if (!machines.daemonSupports(machineId, CAP_MACHINE_UNINSTALL))
        return failed(
          'unavailable',
          'The machine is offline, or its Podium is too old to uninstall from here. Run podium uninstall on it.',
        )
      await ctx.stage('undoing')
      const reply = await rpc.machineUninstall(machineId, ctx.input.force ? { force: true } : {})
      if (!reply.ok)
        return failed('refused', reply.error ?? 'The machine refused to uninstall Podium.')
      await ctx.stage('removing')
      // The daemon has started removing Podium on its own; the machine leaves now.
      await machines.revokeMachine(machineId, {
        attribution: {
          actorKind: 'user',
          actorId: ctx.record.actor ?? ctx.record.createdBy ?? 'unknown',
          onBehalfOf: ctx.record.createdBy,
        },
      })
      const result: MachineUninstallResult = {
        outcomes: reply.outcomes ?? [],
        removesState: reply.removesState ?? false,
      }
      return { status: 'succeeded', result }
    },
    recover: async () => ({
      status: 'unknown',
      error: {
        code: 'lost-track',
        message:
          'The server stopped while uninstalling Podium; the machine list shows whether it is gone.',
      },
    }),
  })
}
