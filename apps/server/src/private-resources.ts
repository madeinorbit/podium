/**
 * THE PRIVATE CLASS (docs/design/multi-user-instance.md §2.3, §4.1; POD-6284).
 *
 * A session, its transcript, its files and its approvals belong to the person
 * who owns the session, and to nobody else: not to other members, not to the
 * task's assignee, not to anyone holding a grant on the task or on the session,
 * and not to admins. A checkout on a machine is read only by a person who may
 * run on that machine (`use`, POD-3955); the admin role's `manage`/`see` on
 * every machine never covers its files.
 *
 * ONE PREDICATE for every surface that serves private bytes (the `/files/asset`
 * route, the `files` and `git` families, the session reads, memory search, the
 * superagent tools, approvals), so they cannot drift into separate rules.
 *
 * THE OWNER IS THE SESSION ROW'S `owner_user_id`, read from the database on each
 * check. Never the task's owner: deriving a session's reader from its task is
 * what would expose every session on a task once tasks become member-readable
 * (POD-6288).
 */

import type { MachineId, SessionId, UserId } from '@podium/model'
import { type CommandPrincipal, onBehalfOfUser } from './command-principal'
import {
  type AsyncMachineRowSource,
  checkMachineUse,
  ownershipSnapshotFromMachines,
} from './machine-access'

/** The private-class rule itself: the owner, and only the owner. */
export function isPrivateOwner(
  human: UserId | null | undefined,
  owner: UserId | null | undefined,
): boolean {
  return (
    human !== null &&
    human !== undefined &&
    owner !== null &&
    owner !== undefined &&
    human === owner
  )
}

export interface PrivateResourceDeps {
  /** The session row's own owner, or undefined when there is no such session. */
  sessionOwnerUserId(sessionId: SessionId): Promise<UserId | undefined>
  machines: AsyncMachineRowSource & { defaultMachine(): Promise<MachineId> }
}

/** Private-resource decisions bound to ONE caller. */
export interface PrivateResourceAccess {
  /** The caller is the session's owner. A missing session answers false, the
   *  same as somebody else's, so a refusal reads as absence. */
  ownsSession(sessionId: SessionId): Promise<boolean>
  /** The caller may read checkouts on this machine (the default machine when
   *  none is named): it holds `use` there. */
  mayReadMachineFiles(machineId?: MachineId): Promise<boolean>
}

const NOBODY: PrivateResourceAccess = {
  ownsSession: async () => false,
  mayReadMachineFiles: async () => false,
}

export function privateResourceAccess(
  deps: PrivateResourceDeps,
  principal: CommandPrincipal | undefined,
): PrivateResourceAccess {
  if (!principal || principal.kind === 'system') return NOBODY
  const human = onBehalfOfUser(principal)
  return {
    ownsSession: async (sessionId) =>
      isPrivateOwner(human, await deps.sessionOwnerUserId(sessionId)),
    mayReadMachineFiles: async (machineId) => {
      const target = machineId ?? (await deps.machines.defaultMachine())
      const ownership = await ownershipSnapshotFromMachines(deps.machines)
      return checkMachineUse(principal, target, ownership) === undefined
    },
  }
}
