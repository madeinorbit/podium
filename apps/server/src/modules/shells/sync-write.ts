/**
 * THE DOCK SHELL'S WRITE ON THE SYNC WRITE ENTRY POINT (POD-6419).
 *
 * `shells.forWorktree` answers "which shell is my dock's for this worktree",
 * creating one when there is none. CLASSIFIED SYNCED (ADR 12 D1): it can start a
 * session, and a session is a synced record every device lists. The mapping row
 * itself (`user_dock_shell`) is the caller's own per-user state.
 *
 * NOTHING OUTSIDE THE DATABASE RUNS IN THE WRITE. The old route spawned the
 * shell inside the request. Now the write claims (or replaces) the mapping row
 * and creates the shell's start as a `session.launch` effect record, minted
 * under the session id the mapping names; the runner spawns it after the commit,
 * and the session row is born under that id when it succeeds (every device sees
 * the start pending meanwhile). A mapped shell whose start is still pending or
 * running is live, so a second device attaches to it instead of replacing it.
 *
 * TARGET: the caller's own mapping row, for a person whose account is a member
 * or an admin now (the old route's rule, read live). A named machine must be one
 * the caller can see, and may use: an unknown one is not found, a denied one is
 * refused, with the old route's words.
 *
 * THE OLD ROUTE stays as a thin adapter (`trpc.ts`): the desktop app bundles its
 * own web, which calls it.
 */

import { type CommandDef, defineCommands } from '@podium/commands'
import { MachineIdField, type SessionId, type UserId, type UserRole } from '@podium/model'
import { z } from 'zod'
import { attributionOf, onBehalfOfUser } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import { visibleMachinesFor } from '../sessions/command-ctx'
import { refuseTarget, type SyncWriteRegistry, type SyncWriteTarget } from '../sync-write/registry'

export const forWorktreeInput = z.object({
  /** The worktree path the dock is open on (raw cwd spelling; normalized server-side). */
  worktreePath: z.string().min(1).max(1024),
  /** Spawn target when the worktree lives on a non-default machine. */
  machineId: MachineIdField.optional(),
})
export type ForWorktreeInput = z.input<typeof forWorktreeInput>

export interface ForWorktreeOutput {
  readonly sessionId: SessionId
  /** True when this call asked for the shell; false when it attached to an existing one. */
  readonly created: boolean
}

export const shellCommands = defineCommands('shells', {
  forWorktree: {
    input: forWorktreeInput,
    action: 'write',
    exposure: ['trpc'],
    conflict: 'single-writer',
    visibility: 'per-user-state',
    cli: { summary: "Return or create the caller's dock shell for a worktree." },
  },
} satisfies Record<'forWorktree', CommandDef>)

export const SHELL_SYNC_COMMANDS = ['shells.forWorktree'] as const

export interface ShellSyncDeps {
  modules(): RegistryModules
  roleOf(user: UserId): Promise<UserRole | undefined>
}

export function registerShellCommands(registry: SyncWriteRegistry, deps: ShellSyncDeps): void {
  registry.register({
    name: 'shells.forWorktree',
    def: shellCommands.defs.forWorktree,
    target: async (input, { principal }): Promise<SyncWriteTarget> => {
      const human = onBehalfOfUser(principal)
      if (human === null || principal.kind === 'system') return undefined
      const role = await deps.roleOf(human)
      if (role !== 'member' && role !== 'admin') return undefined
      if (input.machineId !== undefined) {
        const machines = await visibleMachinesFor(deps.modules(), principal.capability)
        const target = machines.find((machine) => machine.id === input.machineId)
        if (target === undefined) {
          return refuseTarget({ kind: 'target-not-found', message: 'unknown machine' })
        }
        if ((target as { use?: string }).use === 'denied') {
          return refuseTarget({ kind: 'unauthorized', message: 'machine use denied' })
        }
      }
      return { kind: 'per-user-row', userId: human }
    },
    handle: async (ctx, input): Promise<ForWorktreeOutput> => {
      const human = onBehalfOfUser(ctx.principal)
      if (human === null) throw new Error('shells.forWorktree reached its handler without a human')
      const result = await deps.modules().dockShells.forWorktree(human, input.worktreePath, {
        ...(input.machineId ? { machineId: input.machineId } : {}),
        actor: attributionOf(ctx.principal).actor,
      })
      return { sessionId: result.sessionId, created: result.created }
    },
  })
}
