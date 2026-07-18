import type { SessionMeta } from '@podium/protocol'
import { createViewKey } from '../apps/server/src/modules/sessions/publish-worker-actor.js'
import { PublishWorkerClient } from '../apps/server/src/modules/sessions/publish-worker-client.js'

const session: SessionMeta = {
  sessionId: 'smoke-session',
  agentKind: 'shell',
  cwd: '/smoke',
  title: 'smoke',
  machineId: 'local',
  machineName: 'Local',
  status: 'live',
  geometry: { cols: 80, rows: 24 },
  epoch: 0,
  clientCount: 0,
  controllerId: null,
  createdAt: '2026-07-18T00:00:00.000Z',
  lastActiveAt: '2026-07-18T00:00:00.000Z',
  origin: { kind: 'spawn' },
  archived: false,
  readAt: null,
  unread: false,
}

const client = new PublishWorkerClient({ timeoutMs: 10_000 })
try {
  client.replaceProjection({ generation: 1, ledgerCursor: 1, sessions: [session] })
  const publication = await client.request({
    view: {
      key: createViewKey({
        principal: 'smoke',
        scope: 'all',
        serverRole: 'standalone',
        protocolVersion: 1,
        capabilities: [],
      }),
      revision: 1,
      allowedSessionIds: [session.sessionId],
    },
    sinceCursor: null,
  })
  if (!publication.bytes.includes(session.sessionId))
    throw new Error('worker omitted smoke session')
  console.log('PUBLISH_WORKER_SMOKE_OK')
} finally {
  client.stop()
}
