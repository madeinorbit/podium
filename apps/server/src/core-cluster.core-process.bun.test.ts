import { expect, test } from 'bun:test'
import { on } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { asMutationId, mintDeviceId } from '@podium/model'
import {
  CAP_METADATA_DELTA,
  CAP_SYNC_HTTP_V1,
  CLIENT_WIRE_VERSION,
  type ServerMessage,
} from '@podium/protocol'
import WebSocket from 'ws'
import { startCoreTestCluster } from './test-support/core-test-cluster'

async function waitForFrame(socket: WebSocket, matches: (frame: ServerMessage) => boolean) {
  for await (const [raw] of on(socket, 'message', { signal: AbortSignal.timeout(5000) })) {
    const frame = JSON.parse(raw.toString()) as ServerMessage
    if (matches(frame)) return frame
  }
}

test.each([
  'sqlite',
  'pg',
] as const)('%s: a committed profile survives the writer process being killed', async (engine) => {
  const cluster = await startCoreTestCluster(engine)
  try {
    const reader = cluster.size - 1
    const writerRoute = cluster.route(0)
    const readerRoute = cluster.route(reader)
    if (reader !== 0) {
      expect(readerRoute.pid).not.toBe(writerRoute.pid)
      expect(readerRoute.httpUrl).not.toBe(writerRoute.httpUrl)
    }
    expect(readerRoute.clientHeaders).toEqual(writerRoute.clientHeaders)

    const daemon = await cluster.enrollDaemon(0)
    const daemonSocket = await cluster.connectDaemon(reader, daemon)
    try {
      expect(daemonSocket.url).toBe(readerRoute.daemonSocketUrl)
      expect(daemonSocket.readyState).toBe(WebSocket.OPEN)
    } finally {
      daemonSocket.terminate()
    }

    const profile = { id: mintDeviceId('agp_'), name: 'core-cluster-fixture' }
    const readProfile = async () =>
      (await cluster.client(reader).agentProfiles.list.query()).find(({ id }) => id === profile.id)
    expect(await readProfile()).toBeUndefined()

    const socket = new WebSocket(writerRoute.clientSocketUrl, {
      headers: writerRoute.clientHeaders,
    })
    try {
      socket.once('open', () => {
        socket.send(
          JSON.stringify({
            type: 'hello',
            clientId: '',
            viewport: { cols: 80, rows: 24, dpr: 1 },
            caps: [CAP_SYNC_HTTP_V1, CAP_METADATA_DELTA],
            wireVersion: CLIENT_WIRE_VERSION,
          }),
        )
      })
      await waitForFrame(socket, (frame) => frame.type === 'feedResume')
      await cluster.setWakeUpsDropped(0, true)
      await Promise.all([
        cluster
          .client(0)
          .sync.submit.mutate({
            mutationId: asMutationId(mintDeviceId('mut_')),
            command: 'records.agentProfile.create',
            version: 1,
            input: {
              id: profile.id,
              fields: {
                name: profile.name,
                candidates: [{ harness: 'claude-code', model: 'auto', effort: 'high' }],
              },
            },
          })
          .then((receipt) => expect(receipt).toMatchObject({ outcome: 'applied' })),
        waitForFrame(
          socket,
          (frame) =>
            frame.type === 'feedDelta' &&
            frame.changes.some(
              ({ entity, entityId }) => entity === 'agentProfile' && entityId === profile.id,
            ),
        ),
      ])
      expect(await cluster.setWakeUpsDropped(0, false)).toBeGreaterThan(0)
    } finally {
      socket.terminate()
    }

    expect(await readProfile()).toMatchObject(profile)
    await cluster.kill(0)
    if (reader === 0) {
      expect((await cluster.start(0)).pid).not.toBe(writerRoute.pid)
    } else {
      expect(cluster.route(reader).pid).toBe(readerRoute.pid)
    }
    expect(cluster.route(reader).clientHeaders).toEqual(writerRoute.clientHeaders)
    expect(await readProfile()).toMatchObject(profile)
  } finally {
    await cluster.close()
  }
}, 150_000)

test('reports an unrequested clean exit with the Core output', async () => {
  const cluster = await startCoreTestCluster('sqlite')
  try {
    process.kill(cluster.route(0).pid, 'SIGTERM')
    const deadline = AbortSignal.timeout(10_000)
    while (true) {
      try {
        cluster.route(0)
      } catch {
        break
      }
      await delay(10, undefined, { signal: deadline })
    }
    await expect(cluster.close()).rejects.toThrow(
      /Core exited unexpectedly \(0\): process 0[^\n]*\n[\s\S]*serving/,
    )
  } finally {
    await cluster.close().catch(() => {})
  }
}, 45_000)
