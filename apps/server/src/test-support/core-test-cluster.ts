import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { on, once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asMachineId, type MachineId } from '@podium/model'
import {
  CAP_SYNC_HTTP_V1,
  createHandshakeDialer,
  type DialerDeps,
  MachineChallenge,
  machineHelloTranscript,
} from '@podium/protocol'
import { machinePublicKeyWire, signWithMachine } from '@podium/runtime/machine-credential'
import { mintSigningKeyPair, type SigningKeyPair } from '@podium/runtime/signing'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import WebSocket from 'ws'
import type { AppRouter } from '../router'
import type { TestStoreEngine } from './pg-test-database'

export type CoreTestCommand = { type: 'setWakeUpsDropped'; id: number; dropped: boolean }
export type CoreTestReply =
  | { type: 'ready'; port: number; cookie?: string }
  | { type: 'wakeUpsDropped'; id: number; count: number }

export interface CoreTestRoute {
  readonly pid: number
  readonly httpUrl: string
  readonly clientSocketUrl: string
  readonly daemonSocketUrl: string
  /** A signed-in browser arriving through the fixture's trusted proxy hop. */
  readonly clientHeaders: Readonly<Record<string, string>>
}

export interface CoreTestDaemon {
  readonly machineId: MachineId
  readonly key: SigningKeyPair
}

const proxyHeaders = { 'x-forwarded-proto': 'https' }

async function openDaemonSocket(route: CoreTestRoute, options: DialerDeps, key?: SigningKeyPair) {
  const dialer = createHandshakeDialer({ ...options, peerRole: 'machine' })
  const hello = dialer.hello()
  const socket = new WebSocket(route.daemonSocketUrl, { headers: proxyHeaders })
  socket.once('open', () => socket.send(JSON.stringify(hello)))
  try {
    const frames = on(socket, 'message', { signal: AbortSignal.timeout(5000), close: ['close'] })
    for await (const [raw] of frames) {
      const frame = raw.toString()
      const challenge = MachineChallenge.safeParse(JSON.parse(frame))
      if (challenge.success) {
        const { nonce, installationId, connectionId, machineId } = challenge.data
        if (
          !key ||
          hello.credential.kind !== 'machineKey' ||
          machineId !== hello.credential.machineHint
        ) {
          throw new Error('Unexpected daemon key challenge')
        }
        socket.send(
          JSON.stringify({
            ...hello,
            credential: {
              ...hello.credential,
              proof: {
                nonce,
                installationId,
                connectionId,
                signature: signWithMachine(key, machineHelloTranscript(challenge.data)),
              },
            },
          }),
        )
        continue
      }
      const reply = dialer.receive(frame)
      if (reply.action === 'established') return { socket, reply }
      throw new Error(`Daemon handshake ${JSON.stringify(reply)}`)
    }
    throw new Error('Daemon socket closed during handshake')
  } catch (cause) {
    if (socket.readyState === WebSocket.CONNECTING) socket.once('error', () => {})
    socket.terminate()
    throw new Error(`Could not connect daemon to Core ${route.daemonSocketUrl}`, { cause })
  }
}

function waitForReply<Reply extends CoreTestReply>(
  child: ChildProcess,
  matches: (reply: CoreTestReply) => reply is Reply,
  describe: () => string,
  timeoutMs: number,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('close', onClose)
    }
    const fail = (reason: string) => {
      finish()
      reject(new Error(`${reason}: ${describe()}`))
    }
    const onMessage = (message: unknown) => {
      const reply = message as CoreTestReply
      if (!matches(reply)) return
      finish()
      resolve(reply)
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
      fail(`Core exited (${signal ?? code})`)
    const timer = setTimeout(() => fail('Timed out waiting for Core'), timeoutMs)
    child.on('message', onMessage)
    child.once('close', onClose)
  })
}

function spawnCore(
  index: number,
  root: string,
  databaseUrl: string | undefined,
  signIn: { cookie?: string },
) {
  const stateDir = join(root, String(index))
  // Keep the test runtime's live-state guard and replace the deployment settings.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('PODIUM_')),
  )
  const child = spawn(
    process.execPath,
    [
      '--no-env-file',
      '--conditions=@podium/source',
      fileURLToPath(new URL('./core-test-process.ts', import.meta.url)),
    ],
    {
      env: {
        ...env,
        PODIUM_TEST_RUNTIME: process.env.PODIUM_TEST_RUNTIME,
        PODIUM_LIVE_STATE_DIR: process.env.PODIUM_LIVE_STATE_DIR,
        PODIUM_STATE_DIR: stateDir,
        PODIUM_VAULT_KEY_FILE: join(root, 'vault.key'),
        PODIUM_DATABASE_URL: databaseUrl,
        PODIUM_CORE_TEST_SIGN_IN: signIn.cookie === undefined ? '1' : '0',
        PODIUM_MODE: 'all-in-one',
        PODIUM_HOST: '127.0.0.1',
        PODIUM_NO_RELAY: '1',
        PODIUM_CONNECT: 'off',
        PODIUM_TELEMETRY: 'off',
        PODIUM_UPDATE_FEED_POLLING: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  )
  let output = ''
  const capture = (data: Buffer | Error) => {
    output = (output + data.toString()).slice(-8000)
  }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  child.on('error', capture)
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const describe = (waitingFor: string) => `process ${index}, ${waitingFor}\n${output}`
  let requestedExit: 'SIGKILL' | 'SIGTERM' | undefined
  const isRunning = () => child.exitCode === null && child.signalCode === null && !requestedExit
  const requestExit = (signal: 'SIGKILL' | 'SIGTERM') => {
    if (isRunning() && child.kill(signal)) requestedExit = signal
  }
  const checkExit = async () => {
    const { code, signal } = await exited
    if (!requestedExit) {
      throw new Error(`Core exited unexpectedly (${signal ?? code}): ${describe('checking exit')}`)
    }
    const expected =
      requestedExit === 'SIGTERM' ? code === 0 && signal === null : signal === 'SIGKILL'
    if (!expected) {
      throw new Error(`Core shutdown failed (${signal ?? code}): ${describe('closing')}`)
    }
  }

  let route: CoreTestRoute | undefined
  const ready = waitForReply(
    child,
    (reply) => reply.type === 'ready',
    () => describe('starting the server and workers'),
    30_000,
  ).then(({ port, cookie }) => {
    if (child.pid === undefined) throw new Error('Core reported ready without a process ID')
    signIn.cookie ??= cookie
    if (!signIn.cookie) throw new Error('Core fixture did not establish its browser sign-in')
    const address = `127.0.0.1:${port}`
    route = {
      pid: child.pid,
      httpUrl: `http://${address}`,
      clientSocketUrl: `ws://${address}/client?cap=${CAP_SYNC_HTTP_V1}`,
      daemonSocketUrl: `ws://${address}/daemon`,
      clientHeaders: { ...proxyHeaders, cookie: signIn.cookie },
    }
    return route
  })

  let requestId = 0
  return {
    ready,
    isRunning,
    route: () => (isRunning() ? route : undefined),
    async kill() {
      requestExit('SIGKILL')
      await checkExit()
    },
    async close() {
      requestExit('SIGTERM')
      const timeout =
        requestedExit === 'SIGTERM' ? setTimeout(() => child.kill('SIGKILL'), 5000) : undefined
      try {
        await checkExit()
      } finally {
        clearTimeout(timeout)
      }
    },
    async setWakeUpsDropped(dropped: boolean) {
      const id = ++requestId
      const reply = waitForReply(
        child,
        (reply): reply is Extract<CoreTestReply, { type: 'wakeUpsDropped' }> =>
          reply.type === 'wakeUpsDropped' && reply.id === id,
        () => describe('setting wake-up delivery'),
        5000,
      )
      child.send({ type: 'setWakeUpsDropped', id, dropped } satisfies CoreTestCommand)
      return (await reply).count
    },
  }
}

/** Boot independent Core processes on one database. SQLite uses one disk-backed process. */
export async function startCoreTestCluster(
  engine: TestStoreEngine,
  { postgresProcesses = 2 }: { postgresProcesses?: number } = {},
) {
  const size = engine === 'pg' ? postgresProcesses : 1
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('Invalid Core process count')

  const root = await mkdtemp(join(tmpdir(), 'podium-core-'))
  let database: { url: string; drop(): Promise<void> } | undefined
  const cores = new Map<number, ReturnType<typeof spawnCore>>()
  const signIn: { cookie?: string } = {}
  let closing: Promise<void> | undefined

  function checkIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= size) {
      throw new Error(`No Core process at index ${index}`)
    }
  }

  function route(index: number): CoreTestRoute {
    checkIndex(index)
    const endpoint = cores.get(index)?.route()
    if (!endpoint) throw new Error(`Core process ${index} is not running`)
    return endpoint
  }

  async function kill(index: number): Promise<void> {
    checkIndex(index)
    const core = cores.get(index)
    if (!core) return
    await core.kill()
    if (cores.get(index) === core) cores.delete(index)
  }

  async function start(index: number): Promise<CoreTestRoute> {
    checkIndex(index)
    const previous = cores.get(index)
    if (previous && !previous.isRunning()) await kill(index)
    if (closing) throw new Error('Core test cluster is closed')
    const core = cores.get(index) ?? spawnCore(index, root, database?.url, signIn)
    cores.set(index, core)
    try {
      return await core.ready
    } catch (error) {
      if (core.isRunning() && cores.get(index) === core) await kill(index)
      throw error
    }
  }

  function close(): Promise<void> {
    closing ??= (async () => {
      const stopped = await Promise.allSettled([...cores.values()].map((core) => core.close()))
      const cleaned = await Promise.allSettled([
        database?.drop(),
        rm(root, { recursive: true, force: true }),
      ])
      const errors = [...stopped, ...cleaned].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, errors.map(String).join('\n'))
    })()
    return closing
  }

  function client(index: number) {
    const { httpUrl, clientHeaders } = route(index)
    return createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `${httpUrl}/trpc`, headers: clientHeaders })],
    })
  }

  async function enrollDaemon(index = 0): Promise<CoreTestDaemon> {
    const machineId = asMachineId(randomUUID())
    const key = mintSigningKeyPair()
    const publicKey = machinePublicKeyWire(key)
    const { code } = await client(index).machines.pairingCode.mutate({ podiumManaged: false })
    const { socket, reply } = await openDaemonSocket(route(index), {
      credential: { kind: 'pairCode', code, publicKey },
      claims: { machineId, hostname: 'core-test-daemon' },
    })
    try {
      if (reply.enrolledPublicKey !== publicKey)
        throw new Error('Core did not enroll the daemon key')
      if (socket.readyState !== WebSocket.CLOSED) {
        const closed = once(socket, 'close', { signal: AbortSignal.timeout(5000) })
        socket.close()
        await closed
      }
    } finally {
      socket.terminate()
    }
    return { machineId, key }
  }

  try {
    if (engine === 'pg') {
      const { bunPgTestDatabase } = await import('./pg-test-host')
      database = await bunPgTestDatabase()
    }
    // Keep first-boot initialization and peak startup memory bounded. Once
    // started, every worker and request listener runs independently.
    for (let index = 0; index < size; index++) await start(index)
  } catch (error) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Core test cluster failed to start')
    }
    throw error
  }

  return {
    size,
    databaseLocation: database?.url ?? join(root, '0', 'podium.db'),
    route,
    client,
    enrollDaemon,
    async connectDaemon(index: number, daemon: CoreTestDaemon, caps: readonly string[] = []) {
      const { socket } = await openDaemonSocket(
        route(index),
        {
          credential: { kind: 'machineKey', machineHint: daemon.machineId },
          caps,
        },
        daemon.key,
      )
      return socket
    },
    start,
    kill,
    /** Toggle wake-up loss on a process and return the number dropped since the last toggle. */
    async setWakeUpsDropped(index: number, dropped: boolean): Promise<number> {
      checkIndex(index)
      const core = cores.get(index)
      if (!core?.route()) throw new Error(`Core process ${index} is not running`)
      return await core.setWakeUpsDropped(dropped)
    },
    close,
  }
}
