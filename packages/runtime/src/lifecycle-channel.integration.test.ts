/**
 * REAL-PROCESS proof of the parent-child lifecycle line (POD-3761).
 *
 * The unit tests pin the protocol over a fake peer. This file spawns real OS
 * processes through the real `ParentProcess`, with the real invocation shape,
 * and reads what crossed the real descriptor: the child's `ready` with its
 * pid and port, the parent's identity as the child heard it, a heartbeat that
 * keeps moving, a `stop` that arrives on the line before the signal does, and
 * the containment that keeps a grandchild off the line. The port probe the
 * parent still runs is stubbed healthy here; it is not what is under test.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ParentProcess } from './parent-process'
import { isAlive } from './run-registry'

const ROOT = join(import.meta.dirname, '../../..')
const FIXTURE = join(ROOT, 'scripts/fixtures/lifecycle-channel-fixture.ts')

const roots: string[] = []
const parents: ParentProcess[] = []
const observedPids = new Set<number>()
const savedStateDir = process.env.PODIUM_STATE_DIR

afterEach(async () => {
  for (const parent of parents.splice(0)) {
    parent.removeSignalHandlers()
    await parent.stop()
  }
  // A leak in the code under test must not become a leak on the machine.
  for (const pid of observedPids) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* gone between the check and the signal */
      }
    }
  }
  observedPids.clear()
  if (savedStateDir === undefined) delete process.env.PODIUM_STATE_DIR
  else process.env.PODIUM_STATE_DIR = savedStateDir
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function until<T>(read: () => T, label: string, ms = 20_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined && value !== null) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('no port'))
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

function readNote<T = Record<string, unknown>>(
  root: string,
  role: string,
  event: string,
): T | undefined {
  const path = join(root, 'run', `${role}.${event}.json`)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

async function startStack(
  extraEnv: Record<string, string> = {},
  children: Array<'server' | 'daemon'> = ['server', 'daemon'],
): Promise<{ parent: ParentProcess; root: string; port: number }> {
  const root = await mkdtemp(join(tmpdir(), 'podium-lifecycle-channel-'))
  roots.push(root)
  writeFileSync(join(root, 'VERSION'), '9.9.9\n')
  // The parent's own log-sink decision for child stdio reads the process env.
  process.env.PODIUM_STATE_DIR = root
  const port = await freePort()
  const parent = new ParentProcess({
    port,
    children,
    installDir: root,
    stateDir: root,
    generation: 42,
    identity: () => ({
      machineId: 'machine-under-test',
      assignment: { server: true, agentExecution: true },
    }),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PODIUM_STATE_DIR: root,
      PODIUM_APP_VERSION: '9.9.9',
      PODIUM_PARENT_BIN: process.execPath,
      PODIUM_PARENT_CLI: FIXTURE,
      FIXTURE_DIGEST: 'sha256-fixture',
      ...extraEnv,
    },
    // The port probe stays in service until POD-3762; here it simply agrees.
    probeHealth: async () => ({
      serverRunning: true,
      serverVersion: '9.9.9',
      daemonConnected: true,
    }),
    probeDaemonHealth: async () => ({
      connected: true,
      appVersion: '9.9.9',
      convergedVersion: null,
    }),
    probeServerReady: async () => true,
    notify: () => {},
    exit: () => {},
    onSnapshot: (snap) => {
      for (const state of Object.values(snap.children)) {
        if (state.status === 'running') observedPids.add(state.pid)
      }
    },
  })
  parents.push(parent)
  await parent.start()
  return { parent, root, port }
}

describe('the lifecycle line between a real parent and its real children', () => {
  it("carries ready with the child's own pid, version, digest and port, and identity the other way", async () => {
    const { parent, root, port } = await startStack()
    const server = await until(() => parent.lifecycle('server')?.ready, 'server ready')
    const daemon = await until(() => parent.lifecycle('daemon')?.ready, 'daemon ready')

    const serverState = parent.snapshot().children.server
    expect(serverState.status).toBe('running')
    expect(server).toMatchObject({
      role: 'server',
      pid: serverState.status === 'running' ? serverState.pid : -1,
      version: '9.9.9',
      digest: 'sha256-fixture',
      port,
    })
    expect(daemon).toMatchObject({ role: 'daemon', version: '9.9.9' })
    expect(daemon.port).toBeUndefined()

    // The child heard who spawned it, without asking.
    const identity = await until(() => readNote(root, 'server', 'identity'), 'server identity')
    expect(identity).toEqual({
      generation: 42,
      machineId: 'machine-under-test',
      assignment: { server: true, agentExecution: true },
    })
    expect(readNote(root, 'server', 'channel')).toMatchObject({ present: true })
  }, 40_000)

  it('keeps hearing heartbeats while the child lives', async () => {
    const { parent } = await startStack({ FIXTURE_HEARTBEAT_MS: '50' }, ['server'])
    const first = await until(() => parent.lifecycle('server')?.lastHeartbeatMs, 'first beat')
    const later = await until(() => {
      const beat = parent.lifecycle('server')?.lastHeartbeatMs
      return beat !== undefined && beat > first ? beat : undefined
    }, 'a later beat')
    expect(later).toBeGreaterThan(first)
  }, 40_000)

  it('records a degraded report with its reason', async () => {
    const { parent } = await startStack({ FIXTURE_DAEMON_DEGRADED: 'server unreachable' })
    const degraded = await until(() => parent.lifecycle('daemon')?.degraded, 'daemon degraded')
    expect(degraded.reason).toBe('server unreachable')
    expect(parent.lifecycle('server')?.degraded).toBeUndefined()
  }, 40_000)

  it('retiring a role sends stop on the line, and the child answers stopping before it leaves', async () => {
    const { parent, root } = await startStack()
    await until(() => parent.lifecycle('daemon')?.ready, 'daemon ready')
    const daemonState = parent.snapshot().children.daemon
    const daemonPid = daemonState.status === 'running' ? daemonState.pid : -1
    expect(isAlive(daemonPid)).toBe(true)

    await parent.reconcileTopology(['server'], 'none')

    const stop = await until(() => readNote(root, 'daemon', 'stop'), 'daemon stop note')
    expect(stop.reason).toMatch(/topology/)
    const stopping = await until(() => parent.lifecycle('daemon')?.stopping, 'daemon stopping')
    expect(stopping.reason).toMatch(/asked to stop: .*topology|SIGTERM/)
    await until(() => (isAlive(daemonPid) ? undefined : true), 'daemon exit')
    expect(parent.lifecycle('daemon')?.channel).toBe('closed')
    // The server was not asked anything.
    expect(readNote(root, 'server', 'stop')).toBeUndefined()
    expect(parent.snapshot().children.server.status).toBe('running')
  }, 40_000)

  it('stopping the parent asks every child on its line first', async () => {
    const { parent, root } = await startStack()
    await until(() => parent.lifecycle('daemon')?.ready, 'daemon ready')
    await parent.stop()
    expect(readNote(root, 'server', 'stop')).toEqual({ reason: 'parent stopping' })
    expect(readNote(root, 'daemon', 'stop')).toEqual({ reason: 'parent stopping' })
  }, 40_000)

  it('a grandchild cannot see the line — and the probe can see one when it is there', async () => {
    const { root } = await startStack({ FIXTURE_PROBE_GRANDCHILD: '1' }, ['server'])
    const seen = await until(
      () =>
        readNote<{ ordinary: Record<string, unknown>; control: Record<string, unknown> }>(
          root,
          'server',
          'grandchildren',
        ),
      'grandchild probe',
    )
    // Descriptor 3 in an ordinary grandchild is whatever the runtime opened
    // for itself (a chardev on Linux, per POD-3760) — never a socket, and
    // there is no `process.send` to reach anyone with.
    expect(seen.ordinary).toMatchObject({ send: 'undefined', env: false })
    expect(seen.ordinary.fd3).not.toBe('socket')
    // Positive control: a channel deliberately handed down IS visible to the same probe.
    expect(seen.control).toMatchObject({ send: 'function', env: false })
    expect(['socket', 'fifo']).toContain(seen.control.fd3)
  }, 40_000)

  it.skipIf(process.platform === 'win32')(
    'a child whose parent dies without a word learns it from the line and leaves',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'podium-lifecycle-orphan-'))
      roots.push(root)
      // A stand-in parent that exits WITHOUT closing the line or killing the
      // child, as a crashed supervisor would. The child's end must notice.
      const shell = `
        import { spawn } from 'node:child_process'
        const child = spawn(process.execPath, ['--conditions=@podium/source', ${JSON.stringify(FIXTURE)}, 'server'], {
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          env: { ...process.env, PODIUM_STATE_DIR: ${JSON.stringify(root)}, PODIUM_PORT: '1' },
        })
        child.once('message', () => { child.unref(); process.exit(0) })
      `
      const parent = spawn(process.execPath, ['-e', shell], { stdio: 'inherit', cwd: ROOT })
      const channel = await until(() => readNote(root, 'server', 'channel'), 'child channel note')
      const childPid = channel.pid as number
      observedPids.add(childPid)
      expect(channel.present).toBe(true)
      await new Promise<void>((r) => parent.on('exit', () => r()))
      const gone = await until(() => readNote(root, 'server', 'gone'), 'gone note', 10_000)
      expect(typeof gone.atMs).toBe('number')
      await until(() => (isAlive(childPid) ? undefined : true), 'orphan exit', 10_000)
    },
    40_000,
  )
})
