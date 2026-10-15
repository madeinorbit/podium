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

import { asSessionId, type Capability, spawnedByParentSessionId } from '@podium/model'
import { type CommandPrincipal, resolvePrincipalAsync } from './command-principal'
import type { SessionsRepository } from './store/sessions'
import { withReadScope } from './store/executor/read-scope'

export function capabilityPrincipalResolver(
  sessions: Pick<SessionsRepository, 'loadSession'>,
): (capability: Capability) => Promise<CommandPrincipal> {
  return async (capability) =>
    await withReadScope(
      async () =>
        await resolvePrincipalAsync(capability, {
          parentSessionOf: async (candidate) =>
            spawnedByParentSessionId((await sessions.loadSession(asSessionId(candidate)))?.spawnedBy),
          onBehalfOfFor: async (candidate) =>
            (await sessions.loadSession(asSessionId(candidate)))?.ownerUserId,
        }),
    )
}
