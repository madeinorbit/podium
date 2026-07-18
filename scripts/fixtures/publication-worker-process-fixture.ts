import { writeFileSync } from 'node:fs'
import type { ServerMessage, SessionMeta } from '@podium/protocol'
import {
  createViewKey,
  type PublicationView,
} from '../../apps/server/src/modules/sessions/publish-worker-actor'
import { PublishWorkerClient } from '../../apps/server/src/modules/sessions/publish-worker-client'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`missing ${name}`)
  return value
}

const count = Number(process.env.PODIUM_ACCEPTANCE_SESSION_COUNT ?? 20_000)
const sessionIds: string[] = []
const sessions: SessionMeta[] = []
for (let index = 0; index < count; index += 1) {
  const sessionId = `process-worker-${index}`
  sessionIds.push(sessionId)
  sessions.push({
    sessionId,
    agentKind: 'shell',
    cwd: `/process-worker/${index}`,
    title: sessionId,
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
  })
}

const view: PublicationView = {
  key: createViewKey({
    principal: 'process-acceptance',
    scope: 'process-acceptance',
    serverRole: 'standalone',
    protocolVersion: 1,
    capabilities: [],
  }),
  revision: 1,
  allowedSessionIds: sessionIds,
}
const client = new PublishWorkerClient()
client.replaceProjection({ generation: 1, ledgerCursor: 1, sessions })
const publication = client.request({ view, sinceCursor: null })
writeFileSync(required('PODIUM_ACCEPTANCE_DISPATCHED_FILE'), String(process.pid))

if (process.env.PODIUM_ACCEPTANCE_HOLD_AFTER_DISPATCH === '1') {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
}

const result = await publication
const message = JSON.parse(result.bytes) as ServerMessage
if (message.type !== 'sessionsChanged') throw new Error('expected sessionsChanged publication')
writeFileSync(
  required('PODIUM_ACCEPTANCE_RESULT_FILE'),
  JSON.stringify({ sessionCount: message.sessions.length, metrics: client.metrics() }),
)
client.stop()
