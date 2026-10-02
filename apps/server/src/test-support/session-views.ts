/** Test reader for assertions about what a client sees after S6. Raw session
 * assertions still call the server directly; this joins the actual feed homes. */
import { firstAdminMemberId, type SessionMeta } from '@podium/model'
import { asCapabilityRef, asDeviceId } from '@podium/protocol'
import { sessionViews } from '../../../../packages/client-core/src/session-values'
import type { SessionRegistry } from '../relay'

export async function clientSessionViews(registry: SessionRegistry, rows?: SessionMeta[]) {
  const userId = await firstAdminMemberId(registry.sessionStore)
  const snapshot = await registry.modules.sessions.syncChangesSince(null, {
    kind: 'user',
    user: userId,
    device: asDeviceId('test-session-view'),
    capability: asCapabilityRef('test-session-view'),
  })
  if (snapshot.kind !== 'snapshot') throw new Error('expected a client snapshot')
  return sessionViews(rows ?? (await registry.modules.sessions.listSessions(undefined, 'rpc')), {
    userId,
    userStates: snapshot.sessionUserStates ?? [],
    machines: snapshot.machines ?? [],
    repos: snapshot.repos ?? [],
  })
}
