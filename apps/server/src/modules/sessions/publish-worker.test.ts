import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { createPublishWorkerHandler } from './publish-worker.js'
import { createViewKey } from './publish-worker-actor.js'
import { PublishWorkerClient } from './publish-worker-client.js'
import type { PublishWorkerResult } from './publish-worker-protocol.js'

function session(sessionId: string): SessionMeta {
  return {
    sessionId,
    agentKind: 'codex',
    cwd: `/work/${sessionId}`,
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
  }
}

const publicationView = {
  key: createViewKey({
    principal: 'operator',
    scope: 'all',
    serverRole: 'standalone',
    protocolVersion: 1,
    capabilities: [],
  }),
  revision: 1,
  allowedSessionIds: ['s1'],
}

describe('publish worker entrypoint', () => {
  it('keeps projection state across reset, patch, and prepare messages', () => {
    const results: PublishWorkerResult[] = []
    const handle = createPublishWorkerHandler((result) => results.push(result))
    handle({ type: 'reset', state: { generation: 0, ledgerCursor: 0, sessions: [] } })
    handle({
      type: 'patch',
      event: {
        generation: 1,
        ledgerCursor: 1,
        changes: [{ seq: 1, entity: 'session', id: 's1', op: 'upsert', value: session('s1') }],
      },
    })
    handle({
      type: 'prepare',
      id: 'job-1',
      input: { view: publicationView, sinceCursor: null },
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: 'job-1',
      ok: true,
      publication: {
        generation: 1,
        ledgerCursor: 1,
      },
    })
    const result = results[0]
    if (!result?.ok) throw new Error('expected successful publication')
    expect(JSON.parse(result.publication.bytes)).toMatchObject({
      type: 'sessionsChanged',
      sessions: [{ sessionId: 's1' }],
    })
  })

  it('runs the actor in a real Worker thread from source', async () => {
    const client = new PublishWorkerClient({ timeoutMs: 5_000 })
    client.replaceProjection({ generation: 1, ledgerCursor: 1, sessions: [session('s1')] })
    await expect(
      client.request({ view: publicationView, sinceCursor: null }),
    ).resolves.toMatchObject({
      generation: 1,
      ledgerCursor: 1,
    })
    client.stop()
  })
})
