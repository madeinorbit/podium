import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { type PeerHello, type PeerHelloReply, WIRE_VERSION } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RawData } from 'ws'
import { createDaemonConnection } from './connection-state'
import { loadIdentity } from './identity'
import type { DaemonOptions, ReconnectTimers } from './daemon-options'

const roots: string[] = []
const MACHINE_ID = asMachineId('11111111-1111-4111-8111-111111111111')
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
          machineId: MACHINE_ID,
          deliver: vi.fn(),
          close: vi.fn(),
        }
      },
    },
    ...extra,
  }
}

function connection(options: DaemonOptions, identity: { token?: string; updatePubkey?: string } = {}) {
  return createDaemonConnection({
    options,
    machineId: MACHINE_ID,
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
      { kind: 'machineToken', token: 'machine-token', machineHint: MACHINE_ID },
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
      claims: { machineId: MACHINE_ID },
    })
    expect(state.state).toBe('connected')
    expect(hello?.build?.appVersion).toBe(process.env.PODIUM_APP_VERSION ?? 'dev')
    expect(hello?.build?.wireSchemaDigest).toBeTypeOf('string')
    expect(hello?.build?.installKind).toBeTypeOf('string')
    if (hello?.build?.installKind === 'source') {
      expect(hello.caps).toContain('update.delivery.git')
    } else {
      expect(hello?.caps).toEqual(
        expect.arrayContaining(['update.delivery.feed', 'update.delivery.bundle']),
      )
    }
    await state.close()
  })


  it('pins the server key on first bootstrap and refuses later rotation', async () => {
    const firstOptions = localOptions(() => {}, { bootstrapToken: 'local-secret' })
    const identityDir = firstOptions.identityDir as string
    firstOptions.localLink = {
      attach: () => ({
        established: true,
        reply: { ...ok, updatePubkey: 'server-key-1' },
        machineId: MACHINE_ID,
        deliver: vi.fn(),
        close: vi.fn(),
      }),
    }

    const first = connection(firstOptions)
    await first.start()
    expect(loadIdentity({ dir: identityDir }).updatePubkey).toBe('server-key-1')
    await first.close()

    const secondOptions = localOptions(() => {}, { bootstrapToken: 'local-secret', identityDir })
    secondOptions.localLink = {
      attach: () => ({
        established: true,
        reply: { ...ok, updatePubkey: 'server-key-2' },
        machineId: MACHINE_ID,
        deliver: vi.fn(),
        close: vi.fn(),
      }),
    }
    const second = connection(secondOptions, loadIdentity({ dir: identityDir }))
    await expect(second.start()).rejects.toThrow(/server update key changed/i)
    expect(second.state).toBe('blocked')
    expect(loadIdentity({ dir: identityDir }).updatePubkey).toBe('server-key-1')
  })

  it('pins the key on pairing and leaves it unchanged on reconnect', async () => {
    const firstOptions = localOptions(() => {}, { pairCode: 'PAIR-1' })
    const identityDir = firstOptions.identityDir as string
    firstOptions.localLink = {
      attach: () => ({
        established: true,
        reply: {
          ...ok,
          issuedToken: 'token-1',
          updatePubkey: 'server-key-1',
        },
        machineId: MACHINE_ID,
        deliver: vi.fn(),
        close: vi.fn(),
      }),
    }

    const first = connection(firstOptions)
    await first.start()
    expect(loadIdentity({ dir: identityDir })).toMatchObject({
      token: 'token-1',
      updatePubkey: 'server-key-1',
    })
    await first.close()

    const secondOptions = localOptions(() => {}, { identityDir })
    const second = connection(secondOptions, loadIdentity({ dir: identityDir }))
    await second.start()

    expect(loadIdentity({ dir: identityDir }).updatePubkey).toBe('server-key-1')
    await second.close()
  })

  it('learns the key for a daemon paired before the pin existed', async () => {
    // Upgrade path: the identity file carries a token but no updatePubkey, because
    // it was written before the pin shipped. An absent pin is not a changed key —
    // blocking here would brick every daemon enrolled before the guard.
    const options = localOptions(() => {}, { identityDir: temp() })
    const identityDir = options.identityDir as string
    options.localLink = {
      attach: () => ({
        established: true,
        reply: { ...ok, updatePubkey: 'server-key-1' },
        machineId: MACHINE_ID,
        deliver: vi.fn(),
        close: vi.fn(),
      }),
    }

    const state = connection(options, { token: 'token-from-before-the-guard' })
    await state.start()

    expect(state.state).toBe('connected')
    expect(loadIdentity({ dir: identityDir }).updatePubkey).toBe('server-key-1')
    await state.close()
  })

  it('refuses a changed server key on ordinary reconnect', async () => {
    const firstOptions = localOptions(() => {}, { pairCode: 'PAIR-1' })
    const identityDir = firstOptions.identityDir as string
    firstOptions.localLink = {
      attach: () => ({
        established: true,
        reply: {
          ...ok,
          issuedToken: 'token-1',
          updatePubkey: 'server-key-1',
        },
        machineId: MACHINE_ID,
        deliver: vi.fn(),
        close: vi.fn(),
      }),
    }

    const first = connection(firstOptions)
    await first.start()
    await first.close()

    const secondOptions = localOptions(() => {}, { identityDir })
    secondOptions.localLink = {
      attach: () => ({
        established: true,
        reply: { ...ok, updatePubkey: 'server-key-2' },
        machineId: MACHINE_ID,
        deliver: vi.fn(),
        close: vi.fn(),
      }),
    }

    const second = connection(secondOptions, loadIdentity({ dir: identityDir }))
    await expect(second.start()).rejects.toThrow(/server update key changed/i)
    expect(second.state).toBe('blocked')
    expect(loadIdentity({ dir: identityDir }).updatePubkey).toBe('server-key-1')
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
    machineId: MACHINE_ID,
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

it('retains a host diagnostic until the machine transport authenticates', async () => {
  const socket = new FakeSocket()
  const sendApplicationFrame = vi.fn()
  const state = createDaemonConnection({
    options: { serverUrl: 'ws://server', identityDir: temp() },
    machineId: MACHINE_ID,
    identity: { token: 'token' },
    receiveApplicationFrame: vi.fn(),
    sendApplicationFrame,
    onConnected: vi.fn(),
    onTerminal: vi.fn(),
    openSocket: () => socket,
  })

  const started = state.start()
  state.send({
    type: 'machineDiagnostic',
    code: 'codex-version-unsupported',
    title: 'Codex hooks need review',
    body: 'Codex 0.999 is not recognized; local files were left untouched.',
    observedVersion: 'codex-cli 0.999.0',
  })
  expect(sendApplicationFrame).not.toHaveBeenCalled()

  socket.emit('open')
  socket.message(ok)
  await started

  expect(sendApplicationFrame).toHaveBeenCalledWith(
    socket,
    expect.objectContaining({
      type: 'machineDiagnostic',
      code: 'codex-version-unsupported',
    }),
  )
  await state.close()
})
