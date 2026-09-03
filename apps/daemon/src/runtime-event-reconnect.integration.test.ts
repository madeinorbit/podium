import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type MachineId } from '@podium/model'
import { type PeerHelloReply, WIRE_VERSION } from '@podium/protocol'
import { type ControlMessage, parseControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RawData } from 'ws'
import { SessionRegistry } from '../../server/src/relay'
import { buildReport } from './build-report'
import { createDaemonConnection, type DaemonConnection } from './connection-state'
import { createQueueDrainOutbox } from './queue-drain-outbox'
import { createRuntimeEventOutbox } from './runtime-event-outbox'

const roots: string[] = []
const helloOk: PeerHelloReply = {
  type: 'peerHelloOk',
  v: WIRE_VERSION,
  caps: [],
  name: 'test-machine',
}

const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'podium-runtime-event-reconnect-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class FakeSocket extends EventEmitter {
  readyState = 1
  private receiving = false
  private readonly pending: Array<ControlMessage | PeerHelloReply> = []
  send(_data: string): void {}
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close')
  }
  message(value: ControlMessage | PeerHelloReply): void {
    if (this.receiving) {
      this.pending.push(value)
      return
    }
    this.receiving = true
    try {
      this.emit('message', Buffer.from(JSON.stringify(value)) as RawData)
    } finally {
      this.receiving = false
    }
    for (const queued of this.pending.splice(0)) this.message(queued)
  }
}

describe('coarse runtime events across a daemon disconnect', () => {
  it('retains a disconnected coarse event, replays it after reconnect, and retires it on commit ack', async () => {
    const registry = SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    const machineId: MachineId = registry.sessionStore.hostMachineId
    const runtimeOutbox = createRuntimeEventOutbox(temp())
    const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()]
    const receipts: Array<{
      deliveryId: string
      outcome: 'committed' | 'rejected'
      rejectionReason?: string
    }> = []
    let socketIndex = 0
    let activeSocket: FakeSocket | undefined
    let retry: (() => void) | undefined
    let serverSend: ((message: ControlMessage) => void) | undefined
    let connection: DaemonConnection | undefined

    try {
      connection = createDaemonConnection({
        options: {
          serverUrl: 'ws://server',
          identityDir: temp(),
          reconnectTimers: {
            setTimeout: (fn) => {
              retry = fn
              return fn
            },
            clearTimeout: vi.fn(),
          },
        },
        build: buildReport(process.env, undefined),
        machineId,
        identity: { token: 'machine-token' },
        queueDrainOutbox: createQueueDrainOutbox(temp()),
        runtimeEventOutbox: runtimeOutbox,
        receiveApplicationFrame: (raw) => {
          const message = parseControlMessage(raw.toString())
          if (message.type === 'runtimeEventAck') {
            receipts.push({
              deliveryId: message.deliveryId,
              outcome: message.outcome,
              ...(message.rejectionReason ? { rejectionReason: message.rejectionReason } : {}),
            })
            connection?.acknowledgeRuntimeEvent(message.deliveryId)
          }
        },
        sendApplicationFrame: (_socket, message) => {
          registry.gateway.routeDaemonFrame(machineId, message)
          return true
        },
        onConnected: () => {
          const socket = activeSocket
          if (!socket) throw new Error('connected without an active socket')
          serverSend = (message) => socket.message(message)
          registry.gateway.attachDaemon(machineId, serverSend)
        },
        onTerminal: vi.fn(),
        openSocket: () => {
          const socket = sockets[socketIndex++]
          if (!socket) throw new Error('unexpected reconnect')
          activeSocket = socket
          return socket
        },
      })

      const started = connection.start()
      sockets[0]?.emit('open')
      sockets[0]?.message(helloOk)
      await started

      const { sessionId } = registry.modules.sessions.createSession({
        agentKind: 'codex',
        cwd: '/repo',
      })
      registry.gateway.routeDaemonFrame(machineId, {
        type: 'bind',
        sessionId,
        cmd: 'codex app-server',
        cwd: '/repo',
        agentKind: 'codex',
        geometry: { cols: 80, rows: 24 },
        runtimeContract: true,
        driverId: 'codex-app-server',
      })
      const at = new Date(
        Date.parse(registry.modules.sessions.sessionById(sessionId)?.lastActiveAt ?? '') + 1_000,
      ).toISOString()

      connection.send({
        type: 'runtimeEvent',
        deliveryId: 'bootstrap-1',
        sessionId,
        event: {
          t: 'state',
          change: { kind: 'activity' },
          at: registry.modules.sessions.sessionById(sessionId)?.lastActiveAt ?? at,
          provenance: 'bootstrap',
          cursor: { segmentId: 'segment', components: { seq: 1 } },
          observerGeneration: 1,
          turnEpoch: 1,
        },
      })
      expect(runtimeOutbox.pending()).toEqual([])

      if (serverSend) registry.gateway.detachDaemon(machineId, serverSend)
      sockets[0]?.close()
      connection.send({
        type: 'runtimeEvent',
        deliveryId: 'coarse-1',
        sessionId,
        event: {
          t: 'state',
          change: { kind: 'activity' },
          at,
          provenance: 'live',
          cursor: { segmentId: 'segment', components: { seq: 2 } },
          observerGeneration: 1,
          turnEpoch: 1,
        },
      })
      connection.send({
        type: 'runtimeFineEvent',
        sessionId,
        event: {
          t: 'item',
          item: { kind: 'delta', itemId: 'fine-1', textDelta: 'lost-live-token' },
          at,
          provenance: 'live',
          cursor: { segmentId: 'segment', components: { seq: 2 } },
          observerGeneration: 1,
          turnEpoch: 1,
        },
      })
      expect(runtimeOutbox.pending()).toHaveLength(1)
      expect(registry.sessionStore.events.listRuntimeEvents(sessionId)).toHaveLength(1)

      if (!retry) throw new Error('disconnect did not schedule reconnect')
      retry()
      sockets[1]?.emit('open')
      sockets[1]?.message(helloOk)

      expect(registry.sessionStore.events.listRuntimeEvents(sessionId)).toHaveLength(2)
      expect(registry.modules.sessions.sessionById(sessionId)?.lastActiveAt).toBe(at)
      expect(runtimeOutbox.pending()).toEqual([])

      if (serverSend) registry.gateway.detachDaemon(machineId, serverSend)
      sockets[1]?.close()
      connection.send({
        type: 'runtimeEvent',
        deliveryId: 'rejected-generation',
        sessionId,
        event: {
          t: 'state',
          change: { kind: 'activity' },
          at,
          provenance: 'live',
          cursor: { segmentId: 'segment', components: { seq: 3 } },
          observerGeneration: 3,
          turnEpoch: 1,
        },
      })
      // A purged session has no ownership row and is therefore the same poison
      // delivery shape as an unknown session after restart.
      connection.send({
        type: 'runtimeEvent',
        deliveryId: 'rejected-purged-session',
        sessionId: asSessionId('purged-session'),
        event: {
          t: 'state',
          change: { kind: 'activity' },
          at,
          provenance: 'bootstrap',
          cursor: { segmentId: 'purged-segment', components: { seq: 1 } },
          observerGeneration: 1,
          turnEpoch: 1,
        },
      })
      expect(runtimeOutbox.pending()).toHaveLength(2)

      if (!retry) throw new Error('second disconnect did not schedule reconnect')
      retry()
      sockets[2]?.emit('open')
      sockets[2]?.message(helloOk)

      expect(runtimeOutbox.pending()).toEqual([])
      expect(registry.sessionStore.events.listRuntimeEvents(sessionId)).toHaveLength(2)
      expect(receipts.slice(-2)).toEqual([
        {
          deliveryId: 'rejected-generation',
          outcome: 'rejected',
          rejectionReason: 'observer-generation-jump',
        },
        {
          deliveryId: 'rejected-purged-session',
          outcome: 'rejected',
          rejectionReason: 'unknown-session',
        },
      ])
    } finally {
      if (serverSend) registry.gateway.detachDaemon(machineId, serverSend)
      await connection?.close()
      registry.dispose()
    }
  })
})
