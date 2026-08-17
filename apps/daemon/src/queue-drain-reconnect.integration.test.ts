import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actorAgent, asAgentIdentityId, FIRST_ADMIN_USER_ID, type MachineId } from '@podium/model'
import {
  type ControlMessage,
  type PeerHelloReply,
  parseControlMessage,
  WIRE_VERSION,
} from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RawData } from 'ws'
import { SessionRegistry } from '../../server/src/relay'
import { buildReport } from './build-report'
import { createDaemonConnection, type DaemonConnection } from './connection-state'
import type { DaemonContext } from './control/context'
import { dispatchControlMessage } from './control/registry'
import { createQueueDrainOutbox } from './queue-drain-outbox'
import { daemonRuntimeHost } from './runtime/host'

const roots: string[] = []
const helloOk: PeerHelloReply = {
  type: 'peerHelloOk',
  v: WIRE_VERSION,
  caps: [],
  name: 'test-machine',
}

const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'podium-queue-drain-reconnect-'))
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

describe('queue-drain abandonment across a daemon disconnect', () => {
  it('replays after reconnect until the durable row is terminal and acknowledged', async () => {
    const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    const machineId: MachineId = registry.sessionStore.hostMachineId
    const outbox = createQueueDrainOutbox(temp())
    const sockets = [new FakeSocket(), new FakeSocket()]
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
        queueDrainOutbox: outbox,
        receiveApplicationFrame: (raw) => {
          const message = parseControlMessage(raw.toString())
          if (message.type === 'runtimeQueueDrainAbandonedAck') {
            dispatchControlMessage(
              {
                acknowledgeQueueDrainReport: (reportId) =>
                  connection?.acknowledgeQueueDrainReport(reportId),
              } as DaemonContext,
              message,
            )
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
        agentKind: 'claude-code',
        cwd: '/repo',
      })
      registry.gateway.routeDaemonFrame(machineId, {
        type: 'bind',
        sessionId,
        cmd: 'claude',
        cwd: '/repo',
        agentKind: 'claude-code',
        geometry: { cols: 80, rows: 24 },
      })
      const sent = registry.modules.messages.send(
        {
          kind: 'superagent',
          attribution: {
            actor: actorAgent(asAgentIdentityId('superagent')),
            onBehalfOf: FIRST_ADMIN_USER_ID,
          },
          delegationRef: 'superagent',
        },
        {
          to: { kind: 'session', id: sessionId },
          body: 'lost while the daemon socket is down',
          urgency: 'next-turn',
        },
      )
      expect(sent.message.status).toBe('queued')

      if (serverSend) registry.gateway.detachDaemon(machineId, serverSend)
      sockets[0]?.close()
      daemonRuntimeHost({} as DaemonContext, (message) =>
        connection?.send(message),
      ).onDrainAbandoned?.({
        sessionId,
        turns: [{ id: sent.message.id, text: sent.message.body, origin: 'mail' }],
        reason: 'teardown',
      })
      expect(outbox.pending()).toHaveLength(1)
      expect(registry.sessionStore.messages.getMessage(sent.message.id)?.status).toBe('queued')

      if (!retry) throw new Error('disconnect did not schedule reconnect')
      retry()
      sockets[1]?.emit('open')
      sockets[1]?.message(helloOk)

      expect(registry.sessionStore.messages.getMessage(sent.message.id)).toMatchObject({
        status: 'dead_letter',
        deliveryDeferredReason: 'teardown',
      })
      expect(outbox.pending()).toEqual([])
    } finally {
      if (serverSend) registry.gateway.detachDaemon(machineId, serverSend)
      await connection?.close()
      registry.dispose()
    }
  })
})
