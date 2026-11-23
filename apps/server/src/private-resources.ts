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
import { mayReachPrivate } from './issue-authz'
import {
  type AsyncMachineRowSource,
  checkMachineUse,
  ownershipSnapshotFromMachines,
} from './machine-access'

/** The private-class rule itself: the owner, and only the owner. ONE rule
 *  for sessions everywhere (POD-6283): this is `mayReachPrivate`, which the
 *  session commands, drive gates, relay and mail paths call too, and which the
 *  model's `authorize()` decides as its `private` target class. */
export function isPrivateOwner(
  human: UserId | null | undefined,
  owner: UserId | null | undefined,
): boolean {
  return mayReachPrivate(human, { id: 'session', owner })
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
  /**
   * The caller's standing on each machine it may run on (POD-6300): `custody`
   * where it looks after the machine (its native logins are the caller's),
   * `use` where it only holds a `use` grant on someone else's. Machines it may
   * not run on are absent. The admin role's `manage`/`see` adds nothing here.
   */
  machineStanding(): Promise<ReadonlyMap<MachineId, 'custody' | 'use'>>
}

const NOBODY: PrivateResourceAccess = {
  ownsSession: async () => false,
  mayReadMachineFiles: async () => false,
  machineStanding: async () => new Map(),
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
    machineStanding: async () => {
      const ownership = await ownershipSnapshotFromMachines(deps.machines)
      const standing = new Map<MachineId, 'custody' | 'use'>()
      for (const row of await deps.machines.ownershipRows()) {
        if (checkMachineUse(principal, row.id, ownership) !== undefined) continue
        standing.set(
          row.id,
          human !== null && ownership.rowFor(row.id)?.owner === human ? 'custody' : 'use',
        )
      }
      return standing
    },
  }
}
