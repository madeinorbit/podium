/**
 * THE WRITER OF AN EFFECT RECORD, AS THEY ARE NOW (ADR 12 D5 E2).
 *
 * A record runs after its create, sometimes much later, so its run asks again
 * who wrote it: the account must still be active, at its current role, and an
 * agent writer (`actor: session:<id>`) must still exist, with its current
 * capability. `undefined` means the writer may no longer act; the run refuses.
 */

import { asUserId, type SessionId, spawnedByParentSessionId } from '@podium/model'
import {
  type CommandPrincipal,
  resolvePrincipalAsync,
  userCommandPrincipal,
} from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { EffectRow } from '../../store/effects'
import type { UsersRepository } from '../../store/users'

/** The refusal a run answers when its writer may no longer act. */
export const WRITER_NO_LONGER_ALLOWED = 'The writer may no longer do this.'

/** The writing agent, when an agent wrote it (`session:<id>`). */
export const writingAgentOf = (record: EffectRow): SessionId | undefined =>
  record.actor?.startsWith('session:')
    ? (record.actor.slice('session:'.length) as SessionId)
    : undefined

export async function writerPrincipalNow(
  modules: RegistryModules,
  users: Pick<UsersRepository, 'get'>,
  record: EffectRow,
): Promise<CommandPrincipal | undefined> {
  if (record.createdBy === null) return undefined
  const user = await users.get(record.createdBy)
  if (!user || user.disabledAt) return undefined
  const agent = writingAgentOf(record)
  if (agent === undefined) return userCommandPrincipal(asUserId(user.id), user.role)
  return await agentCommandPrincipal(modules, agent)
}

/** An agent session's principal as it is now; undefined when it is gone. */
export async function agentCommandPrincipal(
  modules: RegistryModules,
  agent: SessionId,
): Promise<CommandPrincipal | undefined> {
  const sessions = modules.sessions
  if (!(await sessions.sessionRowExists(agent))) return undefined
  const principal = await resolvePrincipalAsync(await sessions.capabilityForSession(agent), {
    parentSessionOf: async (sessionId) =>
      spawnedByParentSessionId((await sessions.sessionById(sessionId))?.spawnedBy),
  })
  return principal.kind === 'system' ? undefined : principal
}
