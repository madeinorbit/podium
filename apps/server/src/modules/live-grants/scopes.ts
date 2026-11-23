/**
 * WHAT A MEMBER MAY WATCH OR USE THROUGH THE ROOM (POD-7311; POD-6954 design 4.5).
 *
 * A screen names the sessions and machines it shows; the grant names only
 * those the member may see, each with the actions the existing rules give:
 *
 * - session `view`: the member owns it (sessions are private, `mayReachPrivate`
 *   in issue-authz.ts, the rule `session` topics and records use).
 * - session `use`: watching its terminal and typing into it, which is the owner
 *   holding machine `use` on the session's host (`mayWatch` / `mayDrive` in
 *   session-control-policy.ts). No session `manage` is granted: the room has no
 *   action that needs it.
 * - machine `view`: the machine RECORD's rule. Every member of the workspace
 *   reads every machine record and its `machine.condition` topic (machines are
 *   `deployment-substrate` in feed-visibility.ts; the topic's visibility is
 *   `'machine'`), so every machine the workspace has is viewable (review F6,
 *   the coordinator's decision: no member loses a reading the room takes over).
 * - machine `use`, `manage`: the verbs `machineVerbsFor` resolves from the
 *   machine's grant edges (machine-access.ts). `machine.use` topics (metrics,
 *   processes, checkouts) and direct asks need `use`.
 * - roots: on a machine the member may `use`, the repository roots registered
 *   there, the allowlist the `files` and `git` families check
 *   (`assertReadableRoot`).
 * - logins: the machines in the member's custody, whose native logins' quota
 *   the member is shown today (`quota.summary`, POD-6300).
 *
 * A BOUNDED NUMBER OF READS, whatever the number of ids (server-data rule 8):
 * one for the named sessions' owners and hosts, one for the machine rows, one
 * for their grant edges and two for the registered roots (`listRepos` reads
 * paths and prefixes). The decisions run in memory over that one snapshot.
 */

import type { LiveGrantAction } from '@podium/live-grants'
import type { MachineId } from '@podium/model'
import type { UserCommandPrincipal } from '../../command-principal'
import { mayReachPrivate } from '../../issue-authz'
import {
  type AsyncMachineRowSource,
  machineCustodian,
  machineVerbsFor,
  ownershipSnapshotFromMachines,
} from '../../machine-access'

/** The reads the grant takes, each one statement for any number of ids. */
export interface ClientGrantSources {
  /** Each named session's owner, host and whether it is closed (`SessionsRepository`). */
  readonly sessions: {
    bindingConfirmations(
      ids: readonly string[],
    ): Promise<Record<string, { owner: string | null; machineId: string | null; closed: boolean }>>
  }
  /** Every machine row and its grant edges (`MachinesService`). */
  readonly machines: AsyncMachineRowSource
  /** The registered repository roots (`ReposRepository`). */
  readonly repos: {
    listRepos(): Promise<readonly { readonly machineId: MachineId; readonly path: string }[]>
  }
}

export interface ClientGrantRequest {
  readonly sessions: readonly string[]
  readonly machines: readonly string[]
}

export interface ClientGrantScopes {
  readonly sessions: Record<string, LiveGrantAction[]>
  readonly machines: Record<string, LiveGrantAction[]>
  readonly roots: Record<string, string[]>
  readonly logins: string[]
}

/** The scopes `principal` holds on the named ids. An id it may not see is left out. */
export async function clientGrantScopes(
  sources: ClientGrantSources,
  principal: UserCommandPrincipal,
  request: ClientGrantRequest,
): Promise<ClientGrantScopes> {
  const human = principal.user
  const sessionIds = [...new Set(request.sessions)]
  const machineIds = [...new Set(request.machines)]
  const facts = sessionIds.length > 0 ? await sources.sessions.bindingConfirmations(sessionIds) : {}
  // One read of the machine rows and one of their edges, shared by every decision below.
  const rows = await sources.machines.ownershipRows()
  const { grantsForMachines, grantsForMachine } = sources.machines
  const ownership = await ownershipSnapshotFromMachines({
    ownershipRows: () => rows,
    ...(grantsForMachines ? { grantsForMachines: grantsForMachines.bind(sources.machines) } : {}),
    ...(grantsForMachine ? { grantsForMachine: grantsForMachine.bind(sources.machines) } : {}),
  })
  const mayUse = (machineId: MachineId) =>
    machineVerbsFor(principal, machineId, ownership).has('use')

  const sessions: Record<string, LiveGrantAction[]> = {}
  for (const id of sessionIds) {
    const fact = facts[id]
    if (!fact || fact.closed || !mayReachPrivate(human, { id, owner: fact.owner })) continue
    sessions[id] =
      fact.machineId !== null && mayUse(fact.machineId as MachineId) ? ['view', 'use'] : ['view']
  }

  const machines: Record<string, LiveGrantAction[]> = {}
  const usable: MachineId[] = []
  for (const id of machineIds) {
    // An id the workspace has no machine for is left out, like a missing session.
    if (ownership.rowFor(id as MachineId) === undefined) continue
    const verbs = machineVerbsFor(principal, id as MachineId, ownership)
    const actions: LiveGrantAction[] = ['view']
    if (verbs.has('use')) actions.push('use')
    if (verbs.has('manage')) actions.push('manage')
    machines[id] = actions
    if (verbs.has('use')) usable.push(id as MachineId)
  }

  const roots: Record<string, string[]> = {}
  if (usable.length > 0) {
    const wanted = new Set<string>(usable)
    for (const repo of await sources.repos.listRepos()) {
      if (!wanted.has(repo.machineId)) continue
      const list = roots[repo.machineId]
      if (list) list.push(repo.path)
      else roots[repo.machineId] = [repo.path]
    }
  }

  // The machines whose native logins are this member's: in their custody and
  // runnable by them, as `PrivateResourceAccess.machineStanding` decides.
  const logins = rows
    .filter((row) => {
      const facts = ownership.rowFor(row.id)
      return facts !== undefined && machineCustodian(facts.grants) === human && mayUse(row.id)
    })
    .map((row) => String(row.id))

  return { sessions, machines, roots, logins }
}
