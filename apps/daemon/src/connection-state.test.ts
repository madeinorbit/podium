import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { type PeerHello, type PeerHelloReply, WIRE_VERSION } from '@podium/protocol'
import { readConnectivity, writeConnectivity } from '@podium/runtime/connectivity'
import { developmentSourceVersion } from '@podium/runtime/source-version'
import {
  readOrCreateUpdateSigningKey,
  rotateUpdateSigningKey,
} from '@podium/runtime/update-signing-key'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RawData } from 'ws'
import { buildReport } from './build-report'
import { createDaemonConnection } from './connection-state'
import type { DaemonOptions, ReconnectTimers } from './daemon-options'
import { loadIdentity } from './identity'

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

function connection(
  options: DaemonOptions,
  identity: { token?: string; updatePubkey?: string } = {},
) {
  return createDaemonConnection({
    options,
    build: buildReport(process.env, undefined),
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
    expect(hello?.build?.appVersion).toBe(buildReport(process.env, undefined).appVersion)
    expect(hello?.build?.wireSchemaDigest).toBeTypeOf('string')
    expect(hello?.build?.installKind).toBeTypeOf('string')
    if (hello?.build?.installKind === 'source') {
      // A source daemon offers NO delivery: it has no install directory, so a
      // verified bundle is bytes it would have nowhere to put (spec §1).
      expect(hello.caps).not.toContain('update.delivery.feed')
      expect(hello.caps).toContain('shipping.train.v2')
    } else {
      expect(hello?.caps).toEqual(expect.arrayContaining(['update.delivery.feed']))
    }
    await state.close()
  })

  it('is session-only when the sibling server owns the parent update participant', async () => {
    let hello: PeerHello | undefined
    const build = {
      ...buildReport(process.env, undefined),
      installKind: 'installed' as const,
    }
    const state = createDaemonConnection({
      options: localOptions((value) => (hello = value), { bootstrapToken: 'local-secret' }),
      build,
      reportUpdateIdentity: false,
      machineId: MACHINE_ID,
      identity: {},
      receiveApplicationFrame: vi.fn(),
      sendApplicationFrame: vi.fn(),
      onConnected: vi.fn(),
      onTerminal: vi.fn(),
    })

    await state.start()

    expect(hello?.build).toBeUndefined()
    expect(hello?.caps).not.toContain('update.delivery.feed')
    expect(hello?.caps).toContain('shipping.train.v2')
    await state.close()
  })

  it('persists the live process and boot convergence proof after authentication', async () => {
    const options = localOptions(() => {})
    const build = { ...buildReport(process.env, undefined), appVersion: '2.0.0' }
    const state = createDaemonConnection({
      options,
      build,
      machineId: MACHINE_ID,
      identity: { token: 'token' },
      receiveApplicationFrame: vi.fn(),
      sendApplicationFrame: vi.fn(),
      onConnected: () => ({ convergedVersion: '2.0.0' }),
      onTerminal: vi.fn(),
    })

    await state.start()
    expect(readConnectivity(options.identityDir as string)).toMatchObject({
      state: 'connected',
      processId: process.pid,
      appVersion: '2.0.0',
      convergedVersion: '2.0.0',
    })
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
    await expect(second.start()).rejects.toThrow(/publisher update key was replaced/i)
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

  it('accepts a changed key only through a valid old-key-signed rotation', async () => {
    const signingDir = temp()
    const original = readOrCreateUpdateSigningKey(signingDir)
    const firstOptions = localOptions(() => {}, { pairCode: 'PAIR-1' })
    const identityDir = firstOptions.identityDir as string
    firstOptions.localLink = {
      attach: () => ({
        established: true,
        reply: { ...ok, issuedToken: 'token-1', updatePubkey: original.publicKey },
        machineId: MACHINE_ID,
        deliver: vi.fn(),
        close: vi.fn(),
      }),
    }

    const first = connection(firstOptions)
    await first.start()
    await first.close()

    const rotated = rotateUpdateSigningKey(signingDir)
    const secondOptions = localOptions(() => {}, { identityDir })
    secondOptions.localLink = {
      attach: () => ({
        established: true,
        reply: {
          ...ok,
          updatePubkey: rotated.publicKey,
          updateKeyRotations: rotated.rotations,
        },
        machineId: MACHINE_ID,
        deliver: vi.fn(),
        close: vi.fn(),
      }),
    }

    const second = connection(secondOptions, loadIdentity({ dir: identityDir }))
    await second.start()
    expect(second.state).toBe('connected')
    expect(loadIdentity({ dir: identityDir }).updatePubkey).toBe(rotated.publicKey)
    await second.close()
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
    await expect(second.start()).rejects.toThrow(/publisher update key was replaced/i)
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
  closeCalls = 0
  terminateCalls = 0
  constructor(private readonly closeEmitsClose = true) {
    super()
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closeCalls += 1
    this.readyState = 2
    if (!this.closeEmitsClose) return
    this.readyState = 3
    this.emit('close')
  }
  terminate(): void {
    this.terminateCalls += 1
    this.readyState = 3
    this.emit('close')
  }
  message(value: PeerHelloReply): void {
    this.emit('message', Buffer.from(JSON.stringify(value)) as RawData)
  }
}

interface ScheduledTimer {
  readonly fn: () => void
  readonly ms: number
  cleared: boolean
}

function timerHarness() {
  const scheduled: ScheduledTimer[] = []
  const timers: ReconnectTimers = {
    setTimeout: vi.fn((fn: () => void, ms: number) => {
      const timer = { fn, ms, cleared: false }
      scheduled.push(timer)
      return timer
    }),
    clearTimeout: vi.fn((handle: unknown) => {
      ;(handle as ScheduledTimer).cleared = true
    }),
  }
  const next = (ms: number): ScheduledTimer | undefined =>
    scheduled.find((timer) => timer.ms === ms && !timer.cleared)
  const runNext = (ms: number): void => {
    const timer = next(ms)
    if (!timer) throw new Error(`no pending ${ms}ms timer`)
    timer.cleared = true
    timer.fn()
  }
  return { timers, next, runNext }
}

function remoteConnection(
  sockets: FakeSocket[],
  timers: ReconnectTimers,
  identityDir = temp(),
) {
  let socketIndex = 0
  const onConnected = vi.fn()
  const onTerminal = vi.fn()
  const state = createDaemonConnection({
    options: { serverUrl: 'ws://server', identityDir, reconnectTimers: timers },
    build: buildReport(process.env, undefined),
    machineId: MACHINE_ID,
    identity: { token: 'token' },
    receiveApplicationFrame: vi.fn(),
    sendApplicationFrame: vi.fn(),
    onConnected,
    onTerminal,
    openSocket: () => {
      const active = sockets[socketIndex++]
      if (!active) throw new Error('test exhausted its fake sockets')
      return active
    },
  })
  return { state, onConnected, onTerminal }
}

it('closes an open-stalled socket and enters reconnect backoff', async () => {
  const socket = new FakeSocket()
  const harness = timerHarness()
  const identityDir = temp()
  writeConnectivity(
    { state: 'disconnected', serverUrl: 'ws://server', retryBackoffMs: 5_000 },
    identityDir,
  )
  const { state } = remoteConnection([socket], harness.timers, identityDir)

  void state.start()

  expect(state.state).toBe('connecting')
  expect(readConnectivity(identityDir)).toMatchObject({ state: 'connecting' })
  expect(readConnectivity(identityDir)?.retryBackoffMs).toBeUndefined()

  harness.runNext(10_000)

  expect(socket.terminateCalls).toBe(1)
  expect(socket.closeCalls).toBe(0)
  expect(state.state).toBe('backoff')
  expect(readConnectivity(identityDir)).toMatchObject({
    state: 'disconnected',
    retryBackoffMs: 500,
    lastError: 'WebSocket open timed out after 10000ms',
  })
  await state.close()
})

it('forcefully terminates an acknowledgement stall when graceful close emits nothing', async () => {
  const socket = new FakeSocket(false)
  const harness = timerHarness()
  const identityDir = temp()
  const { state } = remoteConnection([socket], harness.timers, identityDir)

  void state.start()
  socket.emit('open')

  expect(socket.sent).toHaveLength(1)
  expect(state.state).toBe('awaiting-ack')
  expect(readConnectivity(identityDir)).toMatchObject({ state: 'awaiting-ack' })
  expect(readConnectivity(identityDir)?.retryBackoffMs).toBeUndefined()

  socket.close()
  expect(socket.closeCalls).toBe(1)
  expect(state.state).toBe('awaiting-ack')

  harness.runNext(10_000)

  expect(socket.terminateCalls).toBe(1)
  expect(state.state).toBe('backoff')
  expect(readConnectivity(identityDir)?.lastError).toBe(
    'peerHello acknowledgement timed out after 10000ms',
  )
  await state.close()
})

it('ignores late events from a superseded socket generation', async () => {
  const sockets = [new FakeSocket(), new FakeSocket()]
  const harness = timerHarness()
  const { state, onTerminal } = remoteConnection(sockets, harness.timers)

  const started = state.start()
  harness.runNext(10_000)
  harness.runNext(500)

  sockets[0]?.emit('open')
  sockets[0]?.message({
    type: 'peerHelloRejected',
    reason: 'auth-failed',
    message: 'late denial',
  })
  sockets[0]?.emit('error', new Error('late error'))
  sockets[0]?.emit('close')

  expect(state.state).toBe('connecting')
  expect(sockets[0]?.sent).toHaveLength(0)
  expect(harness.next(500)).toBeUndefined()
  expect(onTerminal).not.toHaveBeenCalled()

  sockets[1]?.emit('open')
  sockets[1]?.message(ok)
  await started

  sockets[0]?.message({
    type: 'peerHelloRejected',
    reason: 'auth-failed',
    message: 'later denial',
  })
  sockets[0]?.emit('error', new Error('later error'))
  sockets[0]?.emit('close')

  expect(state.state).toBe('connected')
  expect(onTerminal).not.toHaveBeenCalled()
  await state.close()
})

it('clears handshake deadlines after progress and shutdown', async () => {
  const connectedSocket = new FakeSocket()
  const connectedHarness = timerHarness()
  const { state: connected } = remoteConnection([connectedSocket], connectedHarness.timers)

  const started = connected.start()
  const openDeadline = connectedHarness.next(10_000)
  connectedSocket.emit('open')
  expect(openDeadline?.cleared).toBe(true)

  const acknowledgementDeadline = connectedHarness.next(10_000)
  connectedSocket.message(ok)
  await started
  expect(acknowledgementDeadline?.cleared).toBe(true)
  expect(connectedHarness.next(10_000)).toBeUndefined()
  await connected.close()

  const openingSocket = new FakeSocket()
  const openingHarness = timerHarness()
  const { state: opening } = remoteConnection([openingSocket], openingHarness.timers)
  void opening.start()
  const shutdownDeadline = openingHarness.next(10_000)

  await opening.close()

  expect(shutdownDeadline?.cleared).toBe(true)
  expect(openingHarness.next(10_000)).toBeUndefined()
})

it('normally reconnects and resets truthful connectivity state', async () => {
  const sockets = [new FakeSocket(), new FakeSocket()]
  const harness = timerHarness()
  const identityDir = temp()
  const { state, onConnected } = remoteConnection(sockets, harness.timers, identityDir)

  const started = state.start()
  sockets[0]?.emit('open')
  sockets[0]?.message(ok)
  await started
  sockets[0]?.emit('close')

  expect(state.state).toBe('backoff')
  expect(readConnectivity(identityDir)).toMatchObject({
    state: 'disconnected',
    retryBackoffMs: 500,
  })

  harness.runNext(500)

  expect(state.state).toBe('connecting')
  expect(readConnectivity(identityDir)).toMatchObject({ state: 'connecting' })
  expect(readConnectivity(identityDir)?.retryBackoffMs).toBeUndefined()

  sockets[1]?.emit('open')
  expect(readConnectivity(identityDir)).toMatchObject({ state: 'awaiting-ack' })
  sockets[1]?.message(ok)

  expect(state.state).toBe('connected')
  expect(onConnected).toHaveBeenCalledTimes(2)
  expect(harness.next(10_000)).toBeUndefined()
  await state.close()
})

it('keeps the daemon boot identity when the live source changes before reconnect', async () => {
  const sockets = [new FakeSocket(), new FakeSocket()]
  let socketIndex = 0
  let retry: (() => void) | undefined
  let head = 'AAAAAAAA1234567\n'
  const sourceVersion = () => developmentSourceVersion('/source', () => head)
  const build = buildReport({}, undefined, sourceVersion())

  const state = createDaemonConnection({
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
    build,
    machineId: MACHINE_ID,
    identity: { token: 'token' },
    receiveApplicationFrame: vi.fn(),
    sendApplicationFrame: vi.fn(),
    onConnected: vi.fn(),
    onTerminal: vi.fn(),
    openSocket: () => sockets[socketIndex++] as FakeSocket,
  })

  try {
    const started = state.start()
    sockets[0]?.emit('open')
    sockets[0]?.message(ok)
    await started

    head = 'BBBBBBB1234567\n'
    expect(sourceVersion()).toBe('dev+bbbbbbb')
    sockets[0]?.emit('close')
    retry?.()
    sockets[1]?.emit('open')

    const firstHello = JSON.parse(sockets[0]?.sent[0] ?? '{}') as PeerHello
    const secondHello = JSON.parse(sockets[1]?.sent[0] ?? '{}') as PeerHello
    expect(firstHello.build?.appVersion).toBe('dev+aaaaaaa')
    expect(secondHello.build?.appVersion).toBe('dev+aaaaaaa')
  } finally {
    await state.close()
  }
})

it('retains a host diagnostic until the machine transport authenticates', async () => {
  const socket = new FakeSocket()
  const sendApplicationFrame = vi.fn()
  const state = createDaemonConnection({
    options: { serverUrl: 'ws://server', identityDir: temp() },
    build: buildReport(process.env, undefined),
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
