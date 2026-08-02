import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type PeerHello, type PeerHelloReply, WIRE_VERSION } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RawData } from 'ws'
import { createDaemonConnection } from './connection-state'
import type { DaemonOptions, ReconnectTimers } from './daemon-options'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'podium-connection-state-'))
  roots.push(root)
  return root
}

const ok: PeerHelloReply = { type: 'peerHelloOk', v: WIRE_VERSION, caps: [], name: 'box' }

function localOptions(
  capture: (hello: PeerHello) => void,
  extra: Partial<DaemonOptions> = {},
): DaemonOptions {
  return {
    serverUrl: 'ws://unused',
    identityDir: temp(),
    localLink: {
      attach: ({ hello }) => {
        capture(hello)
        return {
          established: true,
          reply: ok,
          machineId: 'machine-a',
          deliver: vi.fn(),
          close: vi.fn(),
        }
      },
    },
    ...extra,
  }
}

function connection(options: DaemonOptions, identity: { token?: string } = {}) {
  return createDaemonConnection({
    options,
    instanceId: 'blue',
    machineId: 'machine-a',
    identity,
    receiveApplicationFrame: vi.fn(),
    sendApplicationFrame: vi.fn(),
    onConnected: vi.fn(),
    onTerminal: vi.fn(),
  })
}

describe('daemon connection credential state machine', () => {
  it.each([
    [
      'daemon secret',
      { bootstrapToken: 'local-secret' },
      {},
      { kind: 'daemonSecret', secret: 'local-secret' },
    ],
    ['pair code', { pairCode: 'PAIR-1' }, {}, { kind: 'pairCode', code: 'PAIR-1' }],
    [
      'machine token',
      {},
      { token: 'machine-token' },
      { kind: 'machineToken', token: 'machine-token', machineHint: 'machine-a' },
    ],
  ] as const)('uses the shared handshake for the %s credential', async (_name, opts, identity, expected) => {
    let hello: PeerHello | undefined
    const state = connection(
      localOptions((value) => (hello = value), opts),
      { ...identity },
    )
    await state.start()
    expect(hello).toMatchObject({
      type: 'peerHello',
      peerRole: 'machine',
      credential: expected,
      claims: { machineId: 'machine-a' },
      instanceId: 'blue',
    })
    expect(state.state).toBe('connected')
    await state.close()
  })

  it('classifies authorization denial as terminal and never enters reconnect backoff', async () => {
    const setTimeout = vi.fn()
    const timers: ReconnectTimers = { setTimeout, clearTimeout: vi.fn() }
    const options = localOptions(() => {}, { pairCode: 'bad', reconnectTimers: timers })
    options.localLink = {
      attach: () => ({
        established: false,
        reply: { type: 'peerHelloRejected', reason: 'auth-failed', message: 'denied' },
      }),
    }
    const state = connection(options)
    await expect(state.start()).rejects.toThrow(/denied/)
    expect(state.state).toBe('unauthorized')
    expect(setTimeout).not.toHaveBeenCalled()
  })
})

class FakeSocket extends EventEmitter {
  readyState = 1
  sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
    this.emit('close')
  }
  message(value: PeerHelloReply): void {
    this.emit('message', Buffer.from(JSON.stringify(value)) as RawData)
  }
}

it('reports transport loss as backoff and schedules a retry', async () => {
  const socket = new FakeSocket()
  const setTimeout = vi.fn((_fn: () => void, ms: number) => ({ ms }))
  const state = createDaemonConnection({
    options: {
      serverUrl: 'ws://server',
      identityDir: temp(),
      reconnectTimers: { setTimeout, clearTimeout: vi.fn() },
    },
    instanceId: 'blue',
    machineId: 'machine-a',
    identity: { token: 'token' },
    receiveApplicationFrame: vi.fn(),
    sendApplicationFrame: vi.fn(),
    onConnected: vi.fn(),
    onTerminal: vi.fn(),
    openSocket: () => socket,
  })

  const started = state.start()
  socket.emit('open')
  socket.message(ok)
  await started
  socket.emit('close')

  expect(state.state).toBe('backoff')
  expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 500)
  await state.close()
})
