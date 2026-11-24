/**
 * CAPABILITY → PRINCIPAL over the durable session rows [POD-6149].
 *
 * Delegation is resolved from durable session ownership on every apply, so the
 * resolver walks `spawnedBy` from the acting session to its root and reads the
 * root's owner. It used to ask `getSession` once per link AND once more for the
 * root, so a root agent paid two reads of the same row on every capability
 * check (research §4, `relay.ts:640/643`). Both members now read through the
 * operation's session loader: a row read for the walk is reused for the owner,
 * and nothing outlives the operation's read scope.
 *
 * The walk itself stays one read per link, because each parent is only known
 * once its child is read. It is bounded by nesting depth (`MAX_CHAIN_DEPTH` in
 * `command-principal.ts`), never by how many sessions exist.
 */

import {
  asSessionId,
  type Capability,
  spawnedByParentSessionId,
  type UserId,
  type WorkspaceId,
} from '@podium/model'
import { type CommandPrincipal, resolvePrincipalAsync } from './command-principal'
import { withReadScope } from './store/executor/read-scope'
import type { SessionsRepository } from './store/sessions'
import type { UsersRepository } from './store/users'

/**
 * Is `user` a member of the workspace whose `users` these are, who can act?
 * Read live at every resolution: it is an authorization input, so a disabled
 * member's next command is refused. The read goes through the per-operation
 * account loader, so a second ask in the same operation is answered from its
 * memo. A relayed command still pays one more `users` read than before
 * (POD-7558, mail-send pins), because its resolution runs in a later
 * operation than the capability's mint; never cache it beyond one operation.
 */
export const memberIn =
  (users: Pick<UsersRepository, 'get'>) =>
  async (user: UserId): Promise<boolean> =>
    (await users.get(user)) !== undefined

export function capabilityPrincipalResolver(
  /** The workspace whose session rows these are. */
  workspaceId: WorkspaceId,
  sessions: Pick<SessionsRepository, 'loadSession'>,
  /** The same workspace's members. */
  users: Pick<UsersRepository, 'get'>,
): (capability: Capability) => Promise<CommandPrincipal> {
  const isMember = memberIn(users)
  return async (capability) =>
    await withReadScope(
      async () =>
        await resolvePrincipalAsync(workspaceId, capability, {
          parentSessionOf: async (candidate) =>
            spawnedByParentSessionId(
              (await sessions.loadSession(asSessionId(candidate)))?.spawnedBy,
            ),
          onBehalfOfFor: async (candidate) =>
            (await sessions.loadSession(asSessionId(candidate)))?.ownerUserId,
          isMember,
        }),
    )
}
