/** One live delegation resolution for session commands and launch preflight. */
import { type Capability, spawnedByParentSessionId } from '@podium/model'
import { resolvePrincipalAsync } from '../../command-principal'
import type { RegistryModules } from '../../relay'

export async function sessionPrincipal(modules: RegistryModules, capability: Capability) {
  return await resolvePrincipalAsync(modules.workspaceId, capability, {
    // The ONE reader of the `session:<id>` tag, in `@podium/model` alongside
    // the one writer (POD-1133). It brands what it extracts, so `parentSessionOf`
    // hands back a `SessionId` with no cast here.
    parentSessionOf: async (sessionId) =>
      // POD-1646: the narrow read. Authorization runs on essentially every
      // request, so the full reader-scoped pass this used to build was pure
      // waste — `sessionSpawnedBy` reads the one field under the same check.
      spawnedByParentSessionId(await modules.sessions.sessionSpawnedBy(sessionId)),
    onBehalfOfFor: async (sessionId) =>
      (await modules.sessions.sessionOwner(sessionId))?.owner ?? undefined,
  })
}
