/**
 * AN AGENT CAPABILITY NEEDS ITS SESSION ROW (POD-7558).
 *
 * The principal resolver takes an agent's human from its root session's owner
 * in the store it resolves in, never from the capability's own `onBehalfOf`.
 * A test that hands the dispatcher an agent capability for a session it never
 * created is now refused, as production refuses it. This seeds the rows such a
 * test means: an agent session owned by a member, with no parent, in a
 * directory of its own.
 */

import { asMachineId, asSessionId, firstAdminMemberId, type UserId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import type { SessionStore } from '../store'
import type { SessionRow } from '../store/types'

export async function seedAgentSessions(
  store: SessionStore,
  ids: readonly string[],
  owner: UserId = firstAdminMemberId(),
  /** The machine the sessions run on (default: the store's host machine), and
   *  the session that spawned them, if any. */
  placement: { machineId?: string; spawnedBy?: string } = {},
): Promise<void> {
  const machineId = placement.machineId ?? store.hostMachine?.id
  if (!machineId) throw new Error('seedAgentSessions needs a machine or a store host machine')
  for (const id of ids) {
    const row: SessionRow = {
      id: asSessionId(id),
      ownerUserId: owner,
      agentKind: 'claude-code',
      // Its own directory: no worktree contains it and no two share one.
      cwd: `/agents/${id}`,
      title: id,
      name: null,
      nameSource: null,
      originKind: 'spawn',
      conversationId: null,
      resumeKind: null,
      resumeValue: null,
      status: 'exited',
      exitCode: null,
      spawnFailure: null,
      durableLabel: `label-${id}`,
      createdAt: '2026-11-24T00:00:00.000Z',
      lastActiveAt: '2026-11-24T00:00:00.000Z',
      geometry: { cols: 80, rows: 24 },
      archived: false,
      workState: null,
      machineId: asMachineId(machineId),
      lastOutputAt: null,
      lastInputAt: null,
      lastResumedAt: null,
      spawnedBy: placement.spawnedBy ? `session:${placement.spawnedBy}` : null,
    }
    await store.sessions.upsertSession(fixtureWriteScope(), row)
  }
}
