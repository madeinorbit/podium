/**
 * Unit coverage for the parent's process-driving loop [POD-2505].
 *
 * Every case here OBSERVES A CONSEQUENCE, not a state label. The first cut of
 * this file asserted `status === 'restarting'` and stopped, which is the
 * supervisor's pure state machine restating itself — it could not see that no
 * replacement child was ever spawned, and did not (review finding 14). The
 * real-process proofs live in scripts/parent-lifecycle.integration.test.ts;
 * these are the fast ones that pin the wiring.
 */
import type { SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveLoggingMode } from './config'
import {
  decodeParentMessage,
  encodeLifecycle,
  type LifecycleRole,
  type ParentIdentity,
} from './lifecycle-channel'
import { configureProcessLogging } from './logging'
import { PARENT_GENERATION_ENV } from './machine-supervisor'
import { type ParentOutcome, readParentOutcome } from './parent-control'
import {
  detachSupervisedChild,
  PARENT_HANDOVER_DEADLINE_ENV,
  PARENT_HANDOVER_EXPECTED_VERSION_ENV,
  PARENT_HAS_SERVER_ENV,
  PARENT_POST_UPDATE_ENV,
  PARENT_RELEASE_MIGRATIONS_ENV,
  PARENT_SUCCESSOR_ENV,
  ParentProcess,
  type SpawnChildFn,
} from './parent-process'
import type { DaemonHandoverHealthProbe, HandoverHealthProbe } from './parent-supervisor'

/**
 * A supervised child, including the private lifecycle line `spawn` gives it
 * (POD-3761). The line matters here because the health gate's evidence is the
 * `ready` frame that travels on it (POD-3762): a fake that never sends one is a
 * child that never came up, which is exactly the state the old port probe could
 * not see.
 */
class FakeChild extends EventEmitter {
  pid: number
  exitCode: number | null = null
  signalsReceived: string[] = []
  /** The parent end tests `send`/`connected` to decide whether a line exists. */
  connected = true
  readonly identities: ParentIdentity[] = []
  readonly stopsRequested: string[] = []
  /** Every frame the parent put on the line, raw. */
  readonly sent: unknown[] = []
  private announce: { role: LifecycleRole; version: string; port?: number } | undefined
  constructor(pid: number) {
    super()
    this.pid = pid
  }
  send(frame: object): boolean {
    if (!this.connected) return false
    this.sent.push(frame)
    const message = decodeParentMessage(frame)
    if (message?.type === 'identity') {
      const { type: _type, ...identity } = message
      this.identities.push(identity)
      // A real child reports ready on the line it now knows it has, not before.
      const announce = this.announce
      this.announce = undefined
      if (announce) this.reportReady(announce)
    }
    if (message?.type === 'stop') this.stopsRequested.push(message.reason)
    return true
  }
  /** Report ready the moment the parent introduces itself, like a child that boots clean. */
  readyOnIdentity(announce: { role: LifecycleRole; version: string; port?: number }): this {
    this.announce = announce
    return this
  }
  reportReady(announce: { role: LifecycleRole; version: string; port?: number }): void {
    this.emit('message', encodeLifecycle({ type: 'ready', pid: this.pid, ...announce }))
  }
  /** Put a raw frame on the line, as a child that speaks for itself would. */
  deliver(message: unknown): void {
    this.emit('message', message)
  }
  reportStopping(reason: string): void {
    this.emit('message', encodeLifecycle({ type: 'stopping', reason }))
  }
  kill(signal?: string): boolean {
    this.signalsReceived.push(signal ?? 'SIGTERM')
    this.exitCode = 0
    this.emit('exit', 0, null)
    return true
  }
  /** A crash the parent must restart; a refusal (78) it must park. */
  die(code: number | null, signal: string | null = null): void {
    this.exitCode = code
    this.emit('exit', code, signal)
  }
  unref(): void {}
}

/** A child spawned with no line at all — what a wrong stdio shape produces. */
class MuteChild extends FakeChild {
  override connected = false
}

/**
 * The version a child reports: the one baked into the binary the parent
 * invoked, which is the install's VERSION (scripts/build-bun.ts `--define`).
 */
function spawnedVersion(env: NodeJS.ProcessEnv | undefined): string {
  if (env?.PODIUM_APP_VERSION) return env.PODIUM_APP_VERSION
  const home = env?.PODIUM_HOME
  if (home) {
    try {
      return readFileSync(join(home, 'VERSION'), 'utf8').trim()
    } catch {
      /* no installed bundle in this test */
    }
  }
  return 'dev'
}

/**
 * A child that comes up: it takes the line and reports ready on it with the
 * version of the binary it is and the port it was told to bind. Successor
 * parents (`args[0] === 'parent'`) get no line — they are not children.
 */
function channelChild(
  pid: number,
  args: readonly string[],
  options: SpawnOptions | undefined,
): FakeChild {
  const child = new FakeChild(pid)
  const role = args[0]
  if (role !== 'server' && role !== 'daemon') return child
  const env = options?.env
  const port = Number(env?.PODIUM_PORT)
  return child.readyOnIdentity({
    role,
    version: spawnedVersion(env),
    ...(role === 'server' && Number.isFinite(port) && port > 0 ? { port } : {}),
  })
}


const healthy = (version: string): HandoverHealthProbe => ({
  serverRunning: true,
  serverVersion: version,
  daemonConnected: true,
})

const daemonHealthy = (
  appVersion: string,
  convergedVersion: string | null = null,
): DaemonHandoverHealthProbe => ({ connected: true, appVersion, convergedVersion })

/** A clock the test advances by hand, so backoff deadlines are really reached. */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

const parents: ParentProcess[] = []
function track(parent: ParentProcess): ParentProcess {
  parents.push(parent)
  return parent
}

const roots: string[] = []

afterEach(async () => {
  for (const parent of parents.splice(0)) {
    parent.removeSignalHandlers()
    await parent.stop()
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})

/**
 * A REAL install directory with a REAL retained `.old` sibling, because the
 * rollback substrate is a filesystem fact: `oldBundlePresent`, `restoreOldBundle`
 * and the VERSION re-read all touch disk, and a mocked `.old` proves nothing
 * about the rename that has to succeed. `state/` is deliberately OUTSIDE the
 * install dir — rollback renames the install dir, and `run/` must survive it.
 */
function installDirs(current: string): { install: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), 'podium-parent-rollback-'))
  roots.push(root)
  const install = join(root, 'install')
  const state = join(root, 'state')
  mkdirSync(install, { recursive: true })
  mkdirSync(join(state, 'run'), { recursive: true })
  writeFileSync(join(install, 'VERSION'), `${current}\n`)
  return { install, state }
}

/** What `swapHeadlessBundle` leaves behind: the previous bundle, still on disk. */
function retainBackup(install: string, backup: string): void {
  mkdirSync(`${install}.old`, { recursive: true })
  writeFileSync(join(`${install}.old`, 'VERSION'), `${backup}\n`)
}

function installWithBackup(current: string, backup: string): { install: string; state: string } {
  const dirs = installDirs(current)
  retainBackup(dirs.install, backup)
  return dirs
}

const versionAt = (dir: string): string => readFileSync(join(dir, 'VERSION'), 'utf8').trim()
const outcomeIn = (state: string): ParentOutcome | undefined => readParentOutcome(state)

describe('ParentProcess', () => {
  it('spawns server before daemon from the install invocation', async () => {
    const spawned: Array<{ cmd: string; args: readonly string[] }> = []
    let nextPid = 100
    const spawnImpl: SpawnChildFn = (cmd, args, options) => {
      spawned.push({ cmd, args })
      return channelChild(nextPid++, args, options) as unknown as ReturnType<SpawnChildFn>
    }
    const notifications: string[] = []
    const parent = track(
      new ParentProcess({
        port: 19099,
        installDir: '/opt/podium',
        installBinary: '/opt/podium/podium',
        env: { PODIUM_APP_VERSION: '1.0.0' },
        spawn: spawnImpl,
        probeHealth: async () => healthy('1.0.0'),
        notify: (s) => notifications.push(s),
        sleep: async () => {},
        now: () => 1_000,
        exit: () => {},
      }),
    )

    await parent.start()

    expect(spawned.map((s) => s.args[0])).toEqual(['server', 'daemon'])
    expect(spawned[0]?.cmd).toBe('/opt/podium/podium')
    expect(notifications).toContain('READY=1')
    expect(parent.snapshot().children.server.status).toBe('running')
    expect(parent.snapshot().children.daemon.status).toBe('running')
  })

  it('adds a server without stopping the promotion daemon', async () => {
    const spawned: Array<{ role: string; child: FakeChild }> = []
    let nextPid = 120
    const parent = track(
      new ParentProcess({
        port: 19099,
        installBinary: '/opt/podium/podium',
        children: ['daemon'],
        env: { PODIUM_APP_VERSION: '1.0.0' },
        spawn: ((_cmd, args, options) => {
          const child = channelChild(nextPid++, args, options)
          spawned.push({ role: args[0] as string, child })
          return child as unknown as ReturnType<SpawnChildFn>
        }) as SpawnChildFn,
        probeDaemonHealth: async () => daemonHealthy('1.0.0'),
        probeHealth: async () => healthy('1.0.0'),
        probeServerReady: async () => true,
        notify: () => {},
        sleep: async () => {},
        now: () => 1_000,
        exit: () => {},
      }),
    )
    await parent.start()
    const promotionDaemon = spawned[0]?.child

    await parent.reconcileTopology(['server', 'daemon'], 'server')

    expect(spawned.map((entry) => entry.role)).toEqual(['daemon', 'server'])
    expect(promotionDaemon?.signalsReceived).toEqual([])
  })

  it('retires the source server and restarts its daemon under remote config', async () => {
    const spawned: Array<{
      role: string
      args: readonly string[]
      child: FakeChild
      env?: NodeJS.ProcessEnv
    }> = []
    let nextPid = 140
    const parent = track(
      new ParentProcess({
        port: 19099,
        installBinary: '/opt/podium/podium',
        env: { PODIUM_APP_VERSION: '1.0.0' },
        spawn: ((_cmd, args, options) => {
          const child = channelChild(nextPid++, args, options)
          spawned.push({ role: args[0] as string, args, child, env: options.env })
          return child as unknown as ReturnType<SpawnChildFn>
        }) as SpawnChildFn,
        probeHealth: async () => healthy('1.0.0'),
        probeDaemonHealth: async () => daemonHealthy('1.0.0'),
        notify: () => {},
        sleep: async () => {},
        now: () => 1_000,
        exit: () => {},
      }),
    )
    await parent.start()
    const sourceServer = spawned.find((entry) => entry.role === 'server')?.child
    const localDaemon = spawned.find((entry) => entry.role === 'daemon')?.child

    await parent.reconcileTopology(['daemon'], 'daemon', true)

    expect(sourceServer?.signalsReceived).toContain('SIGTERM')
    expect(localDaemon?.signalsReceived).toContain('SIGTERM')
    const replacement = spawned.at(-1)
    expect(replacement?.args).toEqual(['daemon', '--takeover'])
    expect(replacement?.env?.[PARENT_HAS_SERVER_ENV]).toBe('0')
  })

  /**
   * POD-3762, the defect this gate exists for. A SAME-VERSION handover: the
   * predecessor is still serving on the port, answering `/version` with the very
   * version the successor is waiting for and with its daemon connected. Nothing
   * in that answer says whose stack it is — on ludovico (2026-09-09 07:08Z) the
   * successor passed its gate in 200 ms against the outgoing server. The
   * successor's own children are the only witnesses it can trust.
   */
  it('a successor never passes its gate on a server it did not spawn', async () => {
    const clock = fakeClock()
    let probes = 0
    const notifications: string[] = []
    let claimed = false
    const parent = track(
      new ParentProcess({
        port: 19099,
        installDir: '/opt/podium',
        installBinary: '/opt/podium/podium',
        children: ['server', 'daemon'],
        env: {
          PODIUM_APP_VERSION: '2.0.0',
          [PARENT_SUCCESSOR_ENV]: '1',
          [PARENT_HANDOVER_EXPECTED_VERSION_ENV]: '2.0.0',
        },
        // Its own children start but never come up — no ready frame, ever.
        spawn: ((_cmd, args) =>
          new FakeChild(args[0] === 'server' ? 801 : 802) as unknown as ReturnType<
            SpawnChildFn
          >) as SpawnChildFn,
        // The predecessor's stack, indistinguishable over HTTP from a successful one.
        probeHealth: async () => {
          probes++
          return healthy('2.0.0')
        },
        claimRole: () => {
          claimed = true
        },
        notify: (state) => notifications.push(state),
        sleep: async (ms) => clock.advance(ms),
        now: clock.now,
        exit: () => {},
      }),
    )

    await parent.start()

    expect({
      bootHealthy: parent.isBootHealthy(),
      phase: parent.snapshot().phase,
      claimed,
      ready: notifications.includes('READY=1'),
    }).toEqual({ bootHealthy: false, phase: 'degraded', claimed: false, ready: false })
    expect(probes, 'a server nobody proved is ours is not worth asking').toBe(0)
  })

  it('passes once its own server and daemon report ready on their own lines', async () => {
    const clock = fakeClock()
    const probedPorts: number[] = []
    const notifications: string[] = []
    let nextPid = 810
    const parent = track(
      new ParentProcess({
        port: 19099,
        installDir: '/opt/podium',
        installBinary: '/opt/podium/podium',
        children: ['server', 'daemon'],
        env: {
          PODIUM_APP_VERSION: '2.0.0',
          [PARENT_SUCCESSOR_ENV]: '1',
          [PARENT_HANDOVER_EXPECTED_VERSION_ENV]: '2.0.0',
        },
        spawn: ((_cmd, args) => {
          const child = new FakeChild(nextPid++)
          // The port this server actually bound, which is the one worth asking.
          if (args[0] === 'server')
            child.readyOnIdentity({ role: 'server', version: '2.0.0', port: 4173 })
          if (args[0] === 'daemon') child.readyOnIdentity({ role: 'daemon', version: '2.0.0' })
          return child as unknown as ReturnType<SpawnChildFn>
        }) as SpawnChildFn,
        probeHealth: async (port) => {
          probedPorts.push(port)
          return healthy('2.0.0')
        },
        notify: (state) => notifications.push(state),
        sleep: async (ms) => clock.advance(ms),
        now: clock.now,
        exit: () => {},
      }),
    )

    await parent.start()

    expect(parent.isBootHealthy()).toBe(true)
    expect(notifications).toContain('READY=1')
    expect(probedPorts, 'the daemon question goes to the port our own server named').toEqual([4173])
  })

  it('AUDIT NEGATIVE CONTROL: failed boot health must not claim ready ownership', async () => {
    const clock = fakeClock()
    const notifications: string[] = []
    let claimed = false
    const parent = track(
      new ParentProcess({
        port: 19099,
        installDir: '/opt/podium',
        installBinary: '/opt/podium/podium',
        env: { PODIUM_APP_VERSION: '1.0.0', [PARENT_SUCCESSOR_ENV]: '1' },
        children: ['server'],
        // Spawned with its line, but it never comes up on it.
        spawn: (() => new FakeChild(125) as unknown as ReturnType<SpawnChildFn>) as SpawnChildFn,
        probeHealth: async () => ({
          serverRunning: false,
          serverVersion: null,
          daemonConnected: false,
        }),
        claimRole: () => {
          claimed = true
        },
        notify: (state) => notifications.push(state),
        sleep: async (ms) => clock.advance(ms),
        now: clock.now,
        exit: () => {},
      }),
    )

    await parent.start()

    // The control is ARMED by its positive twin above: the identical parent whose
    // server reports ready on this same line does reach READY=1.
    expect(parent.lifecycle('server'), 'the line was there; nothing came up on it').toEqual({
      channel: 'open',
    })
    expect({
      bootHealthy: parent.isBootHealthy(),
      phase: parent.snapshot().phase,
      claimed,
      ready: notifications.includes('READY=1'),
      watchdog: notifications.includes('WATCHDOG=1'),
    }).toEqual({
      bootHealthy: false,
      phase: 'degraded',
      claimed: false,
      ready: false,
      watchdog: false,
    })
  })

  it('holds a packaged all-in-one marker until the complete server+daemon health gate', async () => {
    let daemonEnv: NodeJS.ProcessEnv | undefined
    let probeCount = 0
    const finalized: string[] = []
    let nextPid = 150
    const parent = track(
      new ParentProcess({
        port: 19099,
        installBinary: '/opt/podium/podium',
        env: { PODIUM_APP_VERSION: '2.0.0' },
        spawn: ((_cmd, args, options) => {
          if (args[0] === 'daemon') daemonEnv = options.env
          return channelChild(nextPid++, args, options) as unknown as ReturnType<SpawnChildFn>
        }) as SpawnChildFn,
        probeHealth: async () => {
          probeCount++
          return healthy('2.0.0')
        },
        finalizePendingGrant: (version) => {
          expect(probeCount).toBeGreaterThan(0)
          finalized.push(version)
        },
        notify: () => {},
        sleep: async () => {},
        now: () => 1_000,
        exit: () => {},
      }),
    )

    await parent.start()

    expect(daemonEnv?.[PARENT_HAS_SERVER_ENV]).toBe('1')
    expect(finalized).toEqual(['2.0.0'])
  })

  it('a child of a systemd parent still picks the journald sink (POD-3177)', async () => {
    // The parent deletes NOTIFY_SOCKET from the child env — only the parent may
    // pet the watchdog — and `resolveLoggingMode` used to read that same variable
    // to choose a sink. So server and daemon wrote pretty console text into
    // journald beside a parent writing NDJSON, and `podium logs`' own jq recipe
    // failed to parse it. THE CHILD'S OWN ENV IS THE SUBJECT: this asserts what
    // the child will resolve from the env it is actually handed.
    const childEnvs = new Map<string, NodeJS.ProcessEnv>()
    let nextPid = 300
    const parent = track(
      new ParentProcess({
        port: 19099,
        installBinary: '/opt/podium/podium',
        env: { PODIUM_APP_VERSION: '2.0.0', NOTIFY_SOCKET: '/run/systemd/notify' },
        spawn: ((_cmd, args, options) => {
          childEnvs.set(String(args[0]), options.env as NodeJS.ProcessEnv)
          return channelChild(nextPid++, args, options) as unknown as ReturnType<SpawnChildFn>
        }) as SpawnChildFn,
        probeHealth: async () => healthy('2.0.0'),
        notify: () => {},
        sleep: async () => {},
        now: () => 1_000,
        exit: () => {},
      }),
    )

    await parent.start()

    for (const child of ['server', 'daemon']) {
      const childEnv = childEnvs.get(child)
      expect(childEnv, `${child} was spawned`).toBeDefined()
      // The delete this bug rode in on is still in force.
      expect(childEnv?.NOTIFY_SOCKET).toBeUndefined()
      expect(resolveLoggingMode(childEnv ?? {})).toBe('systemd')
      const handle = configureProcessLogging({ role: child, env: childEnv })
      try {
        expect(handle.sink.name, `${child} sink`).toBe('stdout')
      } finally {
        await handle.close()
      }
    }
  })

  it('starts a daemon-only fleet member with its configured remote credential', async () => {
    const spawned: Array<{ cmd: string; args: readonly string[] }> = []
    const parent = track(
      new ParentProcess({
        port: 19099,
        installBinary: '/opt/podium/podium',
        children: ['daemon'],
        env: { PODIUM_APP_VERSION: '1.0.0' },
        spawn: ((cmd, args, options) => {
          spawned.push({ cmd, args })
          return channelChild(200, args, options) as unknown as ReturnType<SpawnChildFn>
        }) as SpawnChildFn,
        probeHealth: async () => healthy('1.0.0'),
        probeDaemonHealth: async () => daemonHealthy('1.0.0'),
        notify: () => {},
        sleep: async () => {},
        now: () => 1_000,
        exit: () => {},
      }),
    )

    await parent.start()

    expect(spawned).toEqual([{ cmd: '/opt/podium/podium', args: ['daemon', '--takeover'] }])
  })

  it('completes daemon-only handover after the live successor reconnects and converges', async () => {
    const clock = fakeClock()
    let nextPid = 220
    let successorConverged = false
    let waits = 0
    let localServerProbes = 0
    const notifications: string[] = []
    const exits: number[] = []
    const parent = track(
      new ParentProcess({
        port: 19099,
        installDir: '/opt/podium',
        installBinary: '/opt/podium/podium',
        children: ['daemon'],
        env: { PODIUM_APP_VERSION: '1.0.0' },
        spawn: ((_cmd, args, options) =>
          channelChild(nextPid++, args, options) as unknown as ReturnType<SpawnChildFn>) as SpawnChildFn,
        // A daemon-only host has no local server. Reaching this probe would
        // recreate the production timeout this regression guards.
        probeHealth: async () => {
          localServerProbes++
          return { serverRunning: false, serverVersion: null, daemonConnected: false }
        },
        probeDaemonHealth: async () =>
          successorConverged ? daemonHealthy('2.0.0', '2.0.0') : daemonHealthy('1.0.0'),
        notify: (state) => notifications.push(state),
        sleep: async () => {
          clock.advance(250)
          if (++waits >= 2) successorConverged = true
        },
        now: clock.now,
        handoverTimeoutMs: 1_000,
        exit: (code) => exits.push(code),
      }),
    )

    await parent.start()
    await parent.handover('2.0.0')

    expect(localServerProbes).toBe(0)
    expect(notifications.filter((state) => state.startsWith('MAINPID='))).toHaveLength(1)
    expect(exits).toEqual([0])
  })

  it('RESPAWNS a crashed child once its backoff deadline passes', async () => {
    const clock = fakeClock()
    const serverKids: FakeChild[] = []
    let nextPid = 300
    const spawnImpl: SpawnChildFn = (_cmd, args, options) => {
      const child = channelChild(nextPid++, args, options)
      if (args[0] === 'server') serverKids.push(child)
      return child as unknown as ReturnType<SpawnChildFn>
    }
    const parent = track(
      new ParentProcess({
        port: 19099,
        installBinary: '/opt/podium/podium',
        env: { PODIUM_APP_VERSION: '1.0.0' },
        children: ['server'],
        spawn: spawnImpl,
        probeHealth: async () => healthy('1.0.0'),
        notify: () => {},
        sleep: async () => {},
        now: clock.now,
        exit: () => {},
      }),
    )
    await parent.start()
    expect(serverKids).toHaveLength(1)

    serverKids[0]?.die(1)
    expect(parent.snapshot().children.server.status).toBe('restarting')
    // Not yet: the first rung of the ladder is 1000ms out.
    await new Promise((r) => setTimeout(r, 700))
    expect(serverKids, 'restarted before its backoff elapsed').toHaveLength(1)

    clock.advance(1_500)
    await new Promise((r) => setTimeout(r, 700))
    // THE CONSEQUENCE: a replacement process actually exists.
    expect(serverKids.length).toBeGreaterThanOrEqual(2)
    expect(parent.snapshot().children.server.status).toBe('running')
  })

  it('parks a REFUSING child (exit 78) stopped and degraded, and never respawns it', async () => {
    const clock = fakeClock()
    const serverKids: FakeChild[] = []
    let nextPid = 400
    const spawnImpl: SpawnChildFn = (_cmd, args, options) => {
      const child = channelChild(nextPid++, args, options)
      if (args[0] === 'server') serverKids.push(child)
      return child as unknown as ReturnType<SpawnChildFn>
    }
    const parent = track(
      new ParentProcess({
        port: 19099,
        installBinary: '/opt/podium/podium',
        env: { PODIUM_APP_VERSION: '1.0.0' },
        children: ['server'],
        spawn: spawnImpl,
        probeHealth: async () => healthy('1.0.0'),
        notify: () => {},
        sleep: async () => {},
        now: clock.now,
        exit: () => {},
      }),
    )
    await parent.start()
    serverKids[0]?.die(78)

    expect(parent.snapshot().children.server.status).toBe('refused')
    expect(parent.snapshot().phase).toBe('degraded')
    clock.advance(120_000)
    await new Promise((r) => setTimeout(r, 700))
    expect(serverKids, 'a refusal must not restart').toHaveLength(1)
    expect(parent.components().degraded).toContain('server')
  })

  it('hands over only after health, declares MAINPID only then, and never kills its children', async () => {
    const clock = fakeClock()
    let nextPid = 200
    const kids: FakeChild[] = []
    const spawnImpl: SpawnChildFn = (_cmd, args, options) => {
      const child = channelChild(nextPid++, args, options)
      if (args[0] !== 'parent') kids.push(child)
      return child as unknown as ReturnType<SpawnChildFn>
    }
    let successorUp = false
    let waits = 0
    const notifications: string[] = []
    const exits: number[] = []
    const parent = track(
      new ParentProcess({
        port: 19099,
        installDir: '/opt/podium',
        installBinary: '/opt/podium/podium',
        env: { PODIUM_APP_VERSION: '1.0.0' },
        spawn: spawnImpl,
        probeHealth: async () => healthy(successorUp ? '2.0.0' : '1.0.0'),
        notify: (s) => notifications.push(s),
        // The successor takes three poll intervals to come up on the new version.
        sleep: async () => {
          clock.advance(250)
          if (++waits >= 3) successorUp = true
        },
        now: clock.now,
        exit: (code) => exits.push(code),
      }),
    )

    await parent.start()
    const mainPidBefore = notifications.filter((n) => n.startsWith('MAINPID='))
    await parent.handover('2.0.0')

    expect(mainPidBefore, 'MAINPID must not precede the health gate').toEqual([])
    expect(notifications.filter((n) => n.startsWith('MAINPID='))).toHaveLength(1)
    expect(exits).toEqual([0])
    // Invariant: the successor adopts these; the outgoing parent must not signal them.
    for (const kid of kids) expect(kid.signalsReceived).toEqual([])
  })

  /**
   * POD-2732: the sandbox coordinator is a server-only parent (no daemon child),
   * and its handover gate demanded `daemonConnected` anyway — a bit no process
   * on that machine could ever set. Every install then swapped, timed out for
   * 90s, and rolled back, so the coordinator never held an update while its
   * fleet record claimed one. The gate must judge a daemonless shape by the
   * children it actually supervises, exactly as the boot gate already does.
   */
  it('daemonless handover passes on server health alone — no daemon will ever connect', async () => {
    const clock = fakeClock()
    let nextPid = 700
    const spawnImpl: SpawnChildFn = (_cmd, args, options) =>
      channelChild(nextPid++, args, options) as unknown as ReturnType<SpawnChildFn>
    let successorUp = false
    let waits = 0
    const notifications: string[] = []
    const exits: number[] = []
    const parent = track(
      new ParentProcess({
        port: 19099,
        installDir: '/opt/podium',
        installBinary: '/opt/podium/podium',
        children: ['server'],
        env: { PODIUM_APP_VERSION: '1.0.0' },
        spawn: spawnImpl,
        // The truthful probe of a daemonless machine: the daemon bit stays
        // false forever, before AND after the successor serves the target.
        probeHealth: async () => ({
          serverRunning: true,
          serverVersion: successorUp ? '2.0.0' : '1.0.0',
          daemonConnected: false,
        }),
        notify: (s) => notifications.push(s),
        sleep: async () => {
          clock.advance(250)
          if (++waits >= 3) successorUp = true
        },
        now: clock.now,
        exit: (code) => exits.push(code),
      }),
    )

    await parent.start()
    await parent.handover('2.0.0')

    expect(exits, 'a healthy daemonless successor must be handed the stack').toEqual([0])
    expect(notifications.filter((n) => n.startsWith('MAINPID='))).toHaveLength(1)
  })

  /** The relaxation is shape-scoped: a parent that DOES supervise a daemon still waits for it. */
  it('a daemon-bearing handover still requires the local daemon to connect', async () => {
    const clock = fakeClock()
    let nextPid = 750
    let successor: FakeChild | undefined
    const kids: FakeChild[] = []
    const spawnImpl: SpawnChildFn = (_cmd, args, options) => {
      const child = channelChild(nextPid++, args, options)
      if (args[0] === 'parent') successor = child
      else kids.push(child)
      return child as unknown as ReturnType<SpawnChildFn>
    }
    const exits: number[] = []
    const parent = track(
      new ParentProcess({
        port: 19099,
        installDir: '/opt/podium',
        installBinary: '/opt/podium/podium',
        children: ['server', 'daemon'],
        env: { PODIUM_APP_VERSION: '1.0.0' },
        spawn: spawnImpl,
        // Server serves the target but the machine's daemon never reaches it.
        probeHealth: async () => ({
          serverRunning: true,
          serverVersion: '2.0.0',
          daemonConnected: false,
        }),
        notify: () => {},
        sleep: async () => clock.advance(250),
        now: clock.now,
        exit: (code) => exits.push(code),
      }),
    )

    await parent.start()
    for (const kid of kids.splice(0)) kid.die(0, 'SIGTERM')

    await expect(parent.handover('2.0.0')).rejects.toThrow(/handover timed out/)
    expect(successor?.signalsReceived).toContain('SIGTERM')
    expect(exits, 'the old parent must stay when the daemon never connects').toEqual([])
  })

  it('a successor that never gets healthy is killed and supervision comes back', async () => {
    const clock = fakeClock()
    let nextPid = 500
    let successor: FakeChild | undefined
    const kids: FakeChild[] = []
    const spawnImpl: SpawnChildFn = (_cmd, args, options) => {
      const child = channelChild(nextPid++, args, options)
      if (args[0] === 'parent') successor = child
      else kids.push(child)
      return child as unknown as ReturnType<SpawnChildFn>
    }
    const notifications: string[] = []
    const exits: number[] = []
    const parent = track(
      new ParentProcess({
        port: 19099,
        installDir: '/opt/podium',
        installBinary: '/opt/podium/podium',
        env: { PODIUM_APP_VERSION: '1.0.0' },
        spawn: spawnImpl,
        // Never reaches 2.0.0.
        probeHealth: async () => healthy('1.0.0'),
        notify: (s) => notifications.push(s),
        sleep: async () => clock.advance(250),
        now: clock.now,
        exit: (code) => exits.push(code),
      }),
    )

    await parent.start()
    // The successor's --takeover reclaimed the old children on its way through.
    for (const kid of kids.splice(0)) kid.die(0, 'SIGTERM')

    await expect(parent.handover('2.0.0')).rejects.toThrow(/handover timed out/)

    expect(successor?.signalsReceived, 'the failed successor must be terminated').toContain(
      'SIGTERM',
    )
    expect(exits, 'the old parent must NOT exit when handover fails').toEqual([])
    expect(notifications.filter((n) => n.startsWith('MAINPID='))).toEqual([])
    expect(parent.snapshot().phase).toBe('running')
    // And it puts the stack back on the version that works.
    expect(kids.length).toBeGreaterThanOrEqual(2)
  })

  /**
   * A packaged all-in-one successor can die before it ever binds its server.
   * Waiting for the full 90s health budget leaves the old parent serving while
   * the update operation's terminal wait expires; the observed child exit is
   * already a decisive failed handover and must enter the same rollback path.
   */
  it('all-in-one rollback starts when the successor exits before the health gate', async () => {
    const { install, state } = installDirs('2.0.0')
    const clock = fakeClock()
    const kids: FakeChild[] = []
    let successor: FakeChild | undefined
    let nextPid = 600
    let sleeps = 0
    const spawnImpl: SpawnChildFn = (_cmd, args, options) => {
      const child = channelChild(nextPid++, args, options)
      if (args[0] === 'parent') successor = child
      else kids.push(child)
      return child as unknown as ReturnType<SpawnChildFn>
    }
    const parent = track(
      new ParentProcess({
        port: 19099,
        installDir: install,
        stateDir: state,
        installBinary: join(install, 'podium'),
        children: ['server', 'daemon'],
        env: { PODIUM_APP_VERSION: '2.0.0', NOTIFY_SOCKET: '/dev/null' },
        releaseHadMigrations: false,
        spawn: spawnImpl,
        // The old parent remains healthy, but the successor can never provide
        // the requested target after its own packaged executable exits.
        probeHealth: async () => healthy('2.0.0'),
        notify: () => {},
        sleep: async () => {
          clock.advance(250)
          if (++sleeps === 1) successor?.die(97)
        },
        now: clock.now,
        handoverTimeoutMs: 90_000,
        exit: () => {},
      }),
    )

    await parent.start()
    // The swap retains the previous bundle only after the healthy old parent booted.
    retainBackup(install, '1.0.0')
    // The successor's takeover reclaimed the old children before it crashed.
    for (const kid of kids.splice(0)) kid.die(0, 'SIGTERM')

    await expect(parent.handover('9.9.9')).rejects.toThrow(
      /successor exited before becoming healthy/,
    )

    expect(clock.now(), 'rollback must not wait out the 90s health budget').toBeLessThan(91_000)
    expect(versionAt(install)).toBe('1.0.0')
    expect(existsSync(`${install}.old`)).toBe(false)
    expect(outcomeIn(state)?.outcome).toBe('rolled-back')
    expect(outcomeIn(state)?.why).toMatch(/successor exited before becoming healthy/)
  })

  /**
   * RE-REVIEW R1 — a SUCCESSOR is the only process that can see a post-update
   * crash loop (the parent that ran the swap has exited), and it used to have no
   * way of knowing whether the release carried migrations. It read `undefined`,
   * a `=== true` coercion turned that into "no migrations", and it rolled a
   * MIGRATING release back — decision 4 inverted, and the one failure mode that
   * costs data rather than time.
   *
   * Three cases, because the fix is only real if the flag is actually READ: it
   * has to refuse on `1`, roll back on `0`, and refuse again when nobody said.
   */
  describe('a successor and the migration fact (R1)', () => {
    async function successorCrashLoop(env: NodeJS.ProcessEnv): Promise<{
      install: string
      state: string
      parent: ParentProcess
    }> {
      const { install, state } = installWithBackup('2.0.0', '1.0.0')
      const clock = fakeClock()
      const kids: FakeChild[] = []
      let nextPid = 700
      const spawnImpl: SpawnChildFn = (_cmd, args, options) => {
        const child = channelChild(nextPid++, args, options)
        if (args[0] === 'server') kids.push(child)
        return child as unknown as ReturnType<SpawnChildFn>
      }
      const parent = track(
        new ParentProcess({
          port: 19099,
          installDir: install,
          stateDir: state,
          installBinary: join(install, 'podium'),
          children: ['server'],
          env: {
            // Exactly what `handover()` hands a successor, minus whatever this
            // case is testing the absence of.
            [PARENT_SUCCESSOR_ENV]: '1',
            [PARENT_HANDOVER_EXPECTED_VERSION_ENV]: '2.0.0',
            [PARENT_POST_UPDATE_ENV]: '1',
            NOTIFY_SOCKET: '/dev/null',
            ...env,
          },
          spawn: spawnImpl,
          probeHealth: async () => healthy('2.0.0'),
          notify: () => {},
          sleep: async () => {},
          now: clock.now,
          exit: () => {},
        }),
      )
      await parent.start()
      expect(parent.snapshot().postUpdateSinceMs, 'the successor must boot ARMED').toBeDefined()
      // Three crashes inside the 60s window: the rollback threshold.
      for (let i = 0; i < 3; i++) {
        kids[kids.length - 1]?.die(1)
        clock.advance(11_000)
        await new Promise((r) => setTimeout(r, 700))
      }
      return { install, state, parent }
    }

    it('REFUSES to roll back when the predecessor said the release carried migrations', async () => {
      const { install, state } = await successorCrashLoop({
        [PARENT_RELEASE_MIGRATIONS_ENV]: '1',
      })
      expect(versionAt(install), 'rolled back across a MIGRATING release').toBe('2.0.0')
      expect(existsSync(`${install}.old`), 'the backup must be left alone').toBe(true)
      const outcome = outcomeIn(state)
      expect(outcome?.outcome).toBe('rollback-unavailable')
      expect(outcome?.why).toMatch(/migrations/)
    })

    it('DOES roll back when the predecessor said it carried none', async () => {
      const { install, state } = await successorCrashLoop({
        [PARENT_RELEASE_MIGRATIONS_ENV]: '0',
      })
      expect(versionAt(install), 'the machine must be back on the old bundle').toBe('1.0.0')
      expect(existsSync(`${install}.old`), '.old is consumed by the restore').toBe(false)
      expect(outcomeIn(state)?.outcome).toBe('rolled-back')
      expect(outcomeIn(state)?.version).toBe('1.0.0')
    })

    it('refuses, and says it cannot tell, when nothing carried the fact at all', async () => {
      const { install, state } = await successorCrashLoop({})
      expect(versionAt(install), 'a GUESS must not undo a possible migration').toBe('2.0.0')
      expect(outcomeIn(state)?.why).toMatch(/cannot tell/)
    })
  })

  /**
   * R1's other half: the fact only reaches the successor if the parent that RAN
   * the swap puts it on the wire. This is the producer side of the env var.
   */
  it('hands the migration fact to the successor it spawns', async () => {
    const clock = fakeClock()
    let successorEnv: NodeJS.ProcessEnv | undefined
    let nextPid = 800
    const spawnImpl: SpawnChildFn = (_cmd, args, options) => {
      if (args[0] === 'parent') successorEnv = options.env
      return channelChild(nextPid++, args, options) as unknown as ReturnType<SpawnChildFn>
    }
    const parent = track(
      new ParentProcess({
        port: 19099,
        installDir: '/opt/podium',
        installBinary: '/opt/podium/podium',
        env: { PODIUM_APP_VERSION: '1.0.0', NOTIFY_SOCKET: '/dev/null' },
        children: ['server'],
        releaseHadMigrations: true,
        spawn: spawnImpl,
        probeHealth: async () => healthy('2.0.0'),
        notify: () => {},
        sleep: async () => clock.advance(250),
        now: clock.now,
        exit: () => {},
      }),
    )
    await parent.start()
    await parent.handover('2.0.0')

    expect(successorEnv?.[PARENT_RELEASE_MIGRATIONS_ENV]).toBe('1')
  })

  /**
   * POD-3752: the successor has to be able to say it is the NEXT incarnation of
   * this machine's parent. Both parents dial the same server between the spawn
   * and this one's exit, and the server keeps whichever incarnation is newer —
   * so a successor that could not name its own would let the parent on its way
   * out overwrite the machine's version with the one it is about to stop
   * running. A child (server, daemon) is not an incarnation and must not
   * inherit the number.
   */
  it('hands the successor the next incarnation number, and no child any', async () => {
    const clock = fakeClock()
    let successorEnv: NodeJS.ProcessEnv | undefined
    const childEnvs = new Map<string, NodeJS.ProcessEnv>()
    let nextPid = 820
    const spawnImpl: SpawnChildFn = (_cmd, args, options) => {
      if (args[0] === 'parent') successorEnv = options.env
      else childEnvs.set(String(args[0]), options.env as NodeJS.ProcessEnv)
      return channelChild(nextPid++, args, options) as unknown as ReturnType<SpawnChildFn>
    }
    const parent = track(
      new ParentProcess({
        port: 19099,
        installDir: '/opt/podium',
        installBinary: '/opt/podium/podium',
        env: {
          PODIUM_APP_VERSION: '1.0.0',
          NOTIFY_SOCKET: '/dev/null',
          // The predecessor's own marker: a successor's env carries one, and it
          // must be REPLACED for the next one, never passed along unchanged.
          [PARENT_GENERATION_ENV]: '11',
        },
        children: ['server'],
        supervisorGeneration: 12,
        spawn: spawnImpl,
        probeHealth: async () => healthy('2.0.0'),
        notify: () => {},
        sleep: async () => clock.advance(250),
        now: clock.now,
        exit: () => {},
      }),
    )
    await parent.start()
    expect(childEnvs.get('server')?.[PARENT_GENERATION_ENV]).toBeUndefined()
    await parent.handover('2.0.0')

    expect(successorEnv?.[PARENT_GENERATION_ENV]).toBe('13')
  })

  /**
   * RE-REVIEW R2 — a handover that FAILS used to clear the post-update arming
   * and respawn the children straight back onto the already-swapped, suspect
   * bundle. The crash loop that followed could never reach `considerRollback`,
   * so the rollback substrate was disarmed on precisely the path it exists for,
   * and nothing was reported.
   *
   * The `.old` sibling is what says "an unproven release is installed and its
   * predecessor is still here", so it is the fact these two cases turn on.
   */
  describe('a failed handover and the suspect bundle (R2)', () => {
    async function abortHandoverOn(deps: {
      releaseHadMigrations?: boolean
    }): Promise<{ install: string; state: string; kids: FakeChild[]; parent: ParentProcess }> {
      const { install, state } = installDirs('2.0.0')
      const clock = fakeClock()
      const kids: FakeChild[] = []
      let nextPid = 900
      const spawnImpl: SpawnChildFn = (_cmd, args, options) => {
        const child = channelChild(nextPid++, args, options)
        if (args[0] === 'server') kids.push(child)
        return child as unknown as ReturnType<SpawnChildFn>
      }
      const parent = track(
        new ParentProcess({
          port: 19099,
          installDir: install,
          stateDir: state,
          installBinary: join(install, 'podium'),
          children: ['server'],
          env: { PODIUM_APP_VERSION: '2.0.0', NOTIFY_SOCKET: '/dev/null' },
          ...deps,
          spawn: spawnImpl,
          // The successor never serves 9.9.9, so the gate never closes.
          probeHealth: async () => healthy('2.0.0'),
          notify: () => {},
          sleep: async () => clock.advance(250),
          now: clock.now,
          exit: () => {},
        }),
      )
      await parent.start()
      // THE SWAP, in the order the real one happens: the parent is already up
      // and supervising when the new bundle lands and `.old` is retained.
      retainBackup(install, '1.0.0')
      // The successor's --takeover took the old children on its way through.
      for (const kid of kids.splice(0)) kid.die(0, 'SIGTERM')
      await expect(parent.handover('9.9.9')).rejects.toThrow(/handover timed out/)
      return { install, state, kids, parent }
    }

    it('ROLLS BACK to .old when the release carried no migrations, and says so', async () => {
      const { install, state, kids, parent } = await abortHandoverOn({
        releaseHadMigrations: false,
      })
      expect(versionAt(install), 'left on the bundle that just failed to boot').toBe('1.0.0')
      expect(existsSync(`${install}.old`)).toBe(false)
      // And it is SERVING again — a rollback that does not restart is a stop.
      expect(kids.length, 'children must come back on the restored bundle').toBeGreaterThan(0)
      expect(parent.snapshot().phase).toBe('running')
      const outcome = outcomeIn(state)
      expect(outcome?.outcome).toBe('rolled-back')
      expect(outcome?.why).toMatch(/never became healthy on 9\.9\.9/)
    })

    it('KEEPS the arming and reports why when migrations forbid the rollback', async () => {
      const { install, state, kids, parent } = await abortHandoverOn({
        releaseHadMigrations: true,
      })
      expect(versionAt(install)).toBe('2.0.0')
      expect(existsSync(`${install}.old`), 'the backup stays for a human to use').toBe(true)
      expect(kids.length, 'the machine must still be supervised').toBeGreaterThan(0)
      // THE DEFECT: this used to be undefined, which disarmed every later crash.
      expect(
        parent.snapshot().postUpdateSinceMs,
        'the release is still unproven, so the window must stay open',
      ).toBeDefined()
      expect(parent.snapshot().phase).toBe('degraded')
      const outcome = outcomeIn(state)
      expect(outcome?.outcome).toBe('rollback-unavailable')
      expect(outcome?.why).toMatch(/migrations/)
    })

    /**
     * THE COORDINATOR THAT NEVER CAME BACK ONLINE (POD-2721).
     *
     * The `parent` pidfile is how the rest of Podium discovers that a
     * supervisor exists. A successor claims it once its own boot gate passes,
     * and removes it again when it exits — correct on its own terms, and
     * catastrophic in combination: after an aborted handover the successor is
     * dead, its exit cleanup has deleted the record, and THIS parent is alive
     * and supervising a serving stack under no name at all.
     *
     * What that costs is not cosmetic. The server reads `liveRecord('parent')`
     * to decide whether it can take an update at all; finding nothing, it starts
     * no local update participant, never reports its build, and is counted
     * offline in its own fleet. The sandbox showed exactly that: parent 2859
     * alive since 13:32, `run/` holding `server.pid` and nothing else, and the
     * coordinator's row frozen at the version it had briefly run at 13:46:08
     * with `online: false` for as long as it stays up.
     *
     * The invariant is one sentence: the `parent` record names whoever is
     * actually supervising. A handover moves it forward; an abort must move it
     * back.
     */
    it('takes the parent role back when it reclaims supervision', async () => {
      const claims: string[] = []
      const { install, state } = installDirs('2.0.0')
      const clock = fakeClock()
      const kids: FakeChild[] = []
      let nextPid = 900
      const spawnImpl: SpawnChildFn = (_cmd, args, options) => {
        const child = channelChild(nextPid++, args, options)
        if (args[0] === 'server') kids.push(child)
        return child as unknown as ReturnType<SpawnChildFn>
      }
      const parent = track(
        new ParentProcess({
          port: 19099,
          installDir: install,
          stateDir: state,
          installBinary: join(install, 'podium'),
          children: ['server'],
          env: { PODIUM_APP_VERSION: '2.0.0', NOTIFY_SOCKET: '/dev/null' },
          releaseHadMigrations: false,
          spawn: spawnImpl,
          probeHealth: async () => healthy('2.0.0'),
          notify: () => {},
          sleep: async () => clock.advance(250),
          now: clock.now,
          exit: () => {},
          claimRole: () => {
            claims.push('boot')
          },
          reclaimRole: () => {
            claims.push('abort')
          },
        }),
      )
      await parent.start()
      retainBackup(install, '1.0.0')
      for (const kid of kids.splice(0)) kid.die(0, 'SIGTERM')
      expect(claims, 'the boot gate claims the role once').toEqual(['boot'])

      await expect(parent.handover('9.9.9')).rejects.toThrow(/handover timed out/)

      expect(claims, 'the abort must take the role back').toEqual(['boot', 'abort'])
      // And it is genuinely supervising again, which is what the record claims.
      expect(kids.length).toBeGreaterThan(0)
      expect(parent.snapshot().phase).toBe('running')
    })

    it('takes it back even when migrations forbid the rollback', async () => {
      const claims: string[] = []
      const { install } = installDirs('2.0.0')
      const clock = fakeClock()
      const kids: FakeChild[] = []
      let nextPid = 900
      const spawnImpl: SpawnChildFn = (_cmd, args, options) => {
        const child = channelChild(nextPid++, args, options)
        if (args[0] === 'server') kids.push(child)
        return child as unknown as ReturnType<SpawnChildFn>
      }
      const parent = track(
        new ParentProcess({
          port: 19099,
          installDir: install,
          installBinary: join(install, 'podium'),
          children: ['server'],
          env: { PODIUM_APP_VERSION: '2.0.0', NOTIFY_SOCKET: '/dev/null' },
          releaseHadMigrations: true,
          spawn: spawnImpl,
          probeHealth: async () => healthy('2.0.0'),
          notify: () => {},
          sleep: async () => clock.advance(250),
          now: clock.now,
          exit: () => {},
          reclaimRole: () => {
            claims.push('abort')
          },
        }),
      )
      await parent.start()
      retainBackup(install, '1.0.0')
      for (const kid of kids.splice(0)) kid.die(0, 'SIGTERM')

      await expect(parent.handover('9.9.9')).rejects.toThrow(/handover timed out/)

      // A parent that cannot roll back is still the supervisor, and still the
      // only process that can be asked to restart this machine.
      expect(claims).toEqual(['abort'])
      expect(parent.snapshot().phase).toBe('degraded')
    })

    /** A handover that SUCCEEDS hands the role on; the outgoing parent must not grab it back. */
    it('does not take the role back when the handover completes', async () => {
      const claims: string[] = []
      const clock = fakeClock()
      let nextPid = 500
      const spawnImpl: SpawnChildFn = (_cmd, args, options) =>
        channelChild(nextPid++, args, options) as unknown as ReturnType<SpawnChildFn>
      const exits: number[] = []
      const parent = track(
        new ParentProcess({
          port: 19099,
          installDir: '/opt/podium',
          installBinary: '/opt/podium/podium',
          env: { PODIUM_APP_VERSION: '1.0.0' },
          spawn: spawnImpl,
          probeHealth: async () => healthy('2.0.0'),
          notify: () => {},
          sleep: async () => clock.advance(250),
          now: clock.now,
          exit: (code) => exits.push(code),
          reclaimRole: () => {
            claims.push('abort')
          },
        }),
      )
      await parent.start()
      await parent.handover('2.0.0')

      expect(exits).toEqual([0])
      expect(claims, 'the successor owns the role now').toEqual([])
    })

    /** An abort that cannot re-register is still an abort: supervision comes first. */
    it('resumes supervision even when re-registering fails', async () => {
      const { install } = installDirs('2.0.0')
      const clock = fakeClock()
      const kids: FakeChild[] = []
      let nextPid = 900
      const spawnImpl: SpawnChildFn = (_cmd, args, options) => {
        const child = channelChild(nextPid++, args, options)
        if (args[0] === 'server') kids.push(child)
        return child as unknown as ReturnType<SpawnChildFn>
      }
      const parent = track(
        new ParentProcess({
          port: 19099,
          installDir: install,
          installBinary: join(install, 'podium'),
          children: ['server'],
          env: { PODIUM_APP_VERSION: '2.0.0', NOTIFY_SOCKET: '/dev/null' },
          releaseHadMigrations: false,
          spawn: spawnImpl,
          probeHealth: async () => healthy('2.0.0'),
          notify: () => {},
          sleep: async () => clock.advance(250),
          now: clock.now,
          exit: () => {},
          reclaimRole: () => {
            throw new Error('run dir is read-only')
          },
        }),
      )
      await parent.start()
      retainBackup(install, '1.0.0')
      for (const kid of kids.splice(0)) kid.die(0, 'SIGTERM')

      await expect(parent.handover('9.9.9')).rejects.toThrow(/handover timed out/)

      expect(kids.length, 'the children must come back regardless').toBeGreaterThan(0)
      expect(parent.snapshot().phase).toBe('running')
    })
  })

  it('a successor boots under handover_incoming with the expected version', () => {
    const parent = track(
      new ParentProcess({
        port: 19099,
        installBinary: '/opt/podium/podium',
        env: {
          PODIUM_APP_VERSION: '1.0.0',
          [PARENT_HANDOVER_EXPECTED_VERSION_ENV]: '2.0.0',
        },
        spawn: (() => new FakeChild(1) as unknown as ReturnType<SpawnChildFn>) as SpawnChildFn,
        probeHealth: async () => healthy('2.0.0'),
        notify: () => {},
        sleep: async () => {},
        now: () => 1_000,
        exit: () => {},
      }),
    )
    expect(parent.snapshot().phase).toBe('handover_incoming')
    expect(parent.snapshot().expectedVersion).toBe('2.0.0')
  })
})

describe('delayed successor boot ownership', () => {
  it('hands over to the exact successor becoming healthy at 61 seconds within the shared 90-second budget', async () => {
    vi.useFakeTimers()
    const clock = fakeClock()
    const { install, state } = installDirs('1.0.0')
    let incoming: ParentProcess | undefined
    let incomingStart: Promise<void> | undefined
    let readyAt = Infinity
    let updating = false
    const predecessorExit = vi.fn()
    const confirmed = vi.fn()
    const claims = vi.fn()
    const successorProcess = new FakeChild(process.pid)
    /** The successor's own server, which binds and reports ready at `readyAt`. */
    let successorServer: FakeChild | undefined
    const probe = async () => healthy(updating && clock.now() >= readyAt ? '2.0.0' : '1.0.0')
    const outgoing = track(
      new ParentProcess({
        port: 19099,
        installDir: install,
        stateDir: state,
        installBinary: '/unused/podium',
        children: ['server'],
        env: { PODIUM_APP_VERSION: '1.0.0' },
        runningIdentity: { version: '1.0.0', digest: 'old' },
        spawn: ((_cmd, args, options) => {
          if (args[0] !== 'parent') return channelChild(111, args, options) as unknown as ReturnType<SpawnChildFn>
          expect(Number(options.env?.[PARENT_HANDOVER_DEADLINE_ENV])).toBe(91_000)
          incoming = track(
            new ParentProcess({
              port: 19099,
              installDir: install,
              stateDir: state,
              installBinary: '/unused/podium',
              children: ['server'],
              env: options.env,
              runningIdentity: { version: '2.0.0', digest: 'new' },
              spawn: (() => {
                successorServer = new FakeChild(222)
                return successorServer as unknown as ReturnType<SpawnChildFn>
              }) as SpawnChildFn,
              probeHealth: probe,
              now: clock.now,
              sleep: async (ms) => clock.advance(ms),
              notify: () => {},
              claimRole: claims,
              exit: () => {},
            }),
          )
          incomingStart = incoming.start(confirmed)
          return successorProcess as unknown as ReturnType<SpawnChildFn>
        }) as SpawnChildFn,
        probeHealth: probe,
        now: clock.now,
        sleep: async (ms) => {
          await incomingStart
          clock.advance(ms)
          // 61 seconds in, the successor's server finally binds and says so on
          // its own line — the only thing that can make its gate pass.
          if (clock.now() >= readyAt && successorServer) {
            const server = successorServer
            successorServer = undefined
            server.reportReady({ role: 'server', version: '2.0.0', port: 19099 })
          }
          await vi.advanceTimersByTimeAsync(ms)
        },
        notify: () => {},
        exit: predecessorExit,
      }),
    )
    await outgoing.start()
    updating = true
    readyAt = clock.now() + 61_000
    writeFileSync(join(install, 'ARTIFACT.sha256'), 'new')
    retainBackup(install, '1.0.0')
    await outgoing.handover('2.0.0')
    expect(clock.now()).toBeGreaterThanOrEqual(62_000)
    expect(clock.now()).toBeLessThan(91_000)
    expect(incoming?.isBootHealthy()).toBe(true)
    expect(claims).toHaveBeenCalledTimes(1)
    expect(confirmed).toHaveBeenCalledTimes(1)
    expect(predecessorExit).toHaveBeenCalledWith(0)
    expect(successorProcess.signalsReceived).toEqual([])
    expect(existsSync(`${install}.old`)).toBe(false)
  })

  it('retains daemon convergence proof after the initial timeout and refuses proof after the inherited deadline', async () => {
    vi.useFakeTimers()
    const clock = fakeClock()
    const { install, state } = installDirs('2.0.0')
    let connected = false
    let converged = false
    const claim = vi.fn()
    const confirmed = vi.fn()
    const parent = track(
      new ParentProcess({
        port: 19099,
        installDir: install,
        stateDir: state,
        installBinary: '/unused/podium',
        children: ['daemon'],
        env: {
          [PARENT_SUCCESSOR_ENV]: '1',
          [PARENT_HANDOVER_EXPECTED_VERSION_ENV]: '2.0.0',
          [PARENT_HANDOVER_DEADLINE_ENV]: '91000',
        },
        runningIdentity: { version: '2.0.0', digest: 'new' },
        spawn: ((_cmd, args, options) =>
          channelChild(123, args, options) as unknown as ReturnType<SpawnChildFn>) as SpawnChildFn,
        probeDaemonHealth: async () => ({
          connected,
          appVersion: '2.0.0',
          convergedVersion: converged ? '2.0.0' : null,
        }),
        probeHealth: async () => healthy('2.0.0'),
        now: clock.now,
        sleep: async (ms) => clock.advance(ms),
        notify: () => {},
        claimRole: claim,
        exit: () => {},
      }),
    )
    await parent.start(confirmed)
    connected = true
    clock.advance(500)
    await vi.advanceTimersByTimeAsync(500)
    expect(parent.isBootHealthy()).toBe(false)
    expect(claim).not.toHaveBeenCalled()
    converged = true
    clock.advance(30_000)
    await vi.advanceTimersByTimeAsync(500)
    expect(parent.isBootHealthy()).toBe(false)
    expect(claim).not.toHaveBeenCalled()
    expect(confirmed).not.toHaveBeenCalled()
    expect(existsSync(join(state, 'run/supervisor-ready.json'))).toBe(false)
  })

  it('does not publish readiness or finalize after termination during the role claim', async () => {
    const { install, state } = installDirs('2.0.0')
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const claimed = vi.fn(() => held)
    const finalize = vi.fn()
    const notify = vi.fn()
    const confirmed = vi.fn()
    const parent = track(
      new ParentProcess({
        port: 19099,
        installDir: install,
        stateDir: state,
        children: [],
        env: { PODIUM_APP_VERSION: '2.0.0' },
        runningIdentity: { version: '2.0.0', digest: 'new' },
        claimRole: claimed,
        finalizePendingGrant: finalize,
        notify,
        exit: () => {},
      }),
    )
    const starting = parent.start(confirmed)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(claimed).toHaveBeenCalledTimes(1)
    await parent.stop()
    release()
    await starting
    expect(parent.isBootHealthy()).toBe(false)
    expect(finalize).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(confirmed).not.toHaveBeenCalled()
    expect(existsSync(join(state, 'run/supervisor-ready.json'))).toBe(false)
  })

  it.each([
    'pid',
    'digest',
  ])('refuses healthy handover with a mismatched successor %s witness', async (mismatch) => {
    const clock = fakeClock()
    const { install, state } = installDirs('2.0.0')
    let spawned: FakeChild | undefined
    const exit = vi.fn()
    const parent = track(
      new ParentProcess({
        port: 19099,
        installDir: install,
        stateDir: state,
        installBinary: '/unused/podium',
        children: ['server'],
        env: { PODIUM_APP_VERSION: '2.0.0' },
        runningIdentity: { version: '2.0.0', digest: 'new' },
        spawn: ((_cmd, args, options) => {
          const child = channelChild(123, args, options)
          if (args[0] === 'parent') {
            spawned = child
            writeFileSync(
              join(state, 'run/supervisor-ready.json'),
              JSON.stringify({
                pid: mismatch === 'pid' ? 456 : 123,
                version: '2.0.0',
                digest: mismatch === 'digest' ? 'wrong' : 'new',
              }),
            )
          }
          return child as unknown as ReturnType<SpawnChildFn>
        }) as SpawnChildFn,
        probeHealth: async () => healthy('2.0.0'),
        handoverTimeoutMs: 1_000,
        now: clock.now,
        sleep: async (ms) => clock.advance(ms),
        notify: () => {},
        exit,
      }),
    )
    await parent.start()
    writeFileSync(join(install, 'ARTIFACT.sha256'), 'new')
    await expect(parent.handover('2.0.0')).rejects.toThrow('timed out')
    expect(spawned?.signalsReceived).toContain('SIGTERM')
    expect(exit).not.toHaveBeenCalled()
  })
})

/**
 * CEDING THE FLEET SOCKET (POD-3765), belt-and-braces over the incarnation
 * fence (POD-3752).
 *
 * The fence refuses a superseded parent's HELLO, which fixes the state the
 * fleet settles on and leaves two windows open in between. A fresh server has
 * an empty supervisor map, so it cannot tell an outgoing parent from a
 * successor and admits whichever hello lands first — the old build then sits
 * on the machine row until the successor's arrives. And a socket that
 * established while it WAS newest keeps writing: `machineReport` and
 * `updateStatus` are never re-fenced after the handshake, so for the whole
 * ~18 s gate the outgoing parent's service report is recorded against the
 * successor's build.
 *
 * Both windows close if the process on its way out simply stops speaking. The
 * cede is not a fence and must never be mistaken for one — it is the outgoing
 * parent declining to race a socket it has already handed on.
 */
describe('ceding the fleet socket across a handover', () => {
  /**
   * The machine-supervisor connection as the composition root wires it: a
   * report only reaches the coordinator while the socket is open, `close()`
   * stops it (and the dialer behind it), `reconfigure()` brings it back.
   * `frames` is what the fleet actually SEES.
   */
  class FakeFleetSocket {
    open = true
    frames: string[] = []
    report(phase: string): void {
      if (this.open) this.frames.push(phase)
    }
    close(): void {
      this.open = false
    }
    reconfigure(): void {
      this.open = true
    }
  }

  function handingOver(opts: {
    fleet: FakeFleetSocket
    successorPid: number
    healthyOn?: string
    onSpawnParent?: () => void
  }): ParentProcess {
    const { install, state } = installDirs('2.0.0')
    const clock = fakeClock()
    return track(
      new ParentProcess({
        port: 19099,
        installDir: install,
        stateDir: state,
        installBinary: join(install, 'podium'),
        children: ['server'],
        env: { PODIUM_APP_VERSION: '2.0.0', NOTIFY_SOCKET: '/dev/null' },
        spawn: ((_cmd, args, options) => {
          if (args[0] !== 'parent') return channelChild(701, args, options) as unknown as ReturnType<SpawnChildFn>
          opts.onSpawnParent?.()
          return new FakeChild(opts.successorPid) as unknown as ReturnType<SpawnChildFn>
        }) as SpawnChildFn,
        probeHealth: async () => healthy(opts.healthyOn ?? '2.0.0'),
        onSnapshot: (snap) => opts.fleet.report(snap.phase),
        cedeFleetSocket: () => opts.fleet.close(),
        resumeFleetSocket: () => opts.fleet.reconfigure(),
        handoverTimeoutMs: 1_000,
        notify: () => {},
        sleep: async (ms) => clock.advance(ms),
        now: clock.now,
        exit: () => {},
      }),
    )
  }

  it('goes quiet BEFORE the successor exists, so the two never overlap on the fleet', async () => {
    const fleet = new FakeFleetSocket()
    let openWhenSuccessorSpawned: boolean | undefined
    const parent = handingOver({
      fleet,
      successorPid: 702,
      healthyOn: '9.9.9',
      onSpawnParent: () => {
        openWhenSuccessorSpawned = fleet.open
      },
    })
    await parent.start()
    fleet.frames.length = 0

    await parent.handover('9.9.9')

    expect(
      openWhenSuccessorSpawned,
      'the socket has to be ceded before the successor can dial, not after',
    ).toBe(false)
    expect(fleet.frames, 'a parent on its way out announces nothing').toEqual([])
    expect(fleet.open, 'a handover that SUCCEEDED never gives the socket back').toBe(false)
  })

  it('comes back on the fleet when the handover is abandoned, on the phase it returns to', async () => {
    const fleet = new FakeFleetSocket()
    const parent = handingOver({ fleet, successorPid: 703, healthyOn: '2.0.0' })
    await parent.start()
    fleet.frames.length = 0

    await expect(parent.handover('9.9.9')).rejects.toThrow(/handover timed out/)

    expect(fleet.open, 'the predecessor is the supervisor again and must say so').toBe(true)
    expect(fleet.frames).toContain('running')
    expect(
      fleet.frames,
      'the socket was down for the whole of handover_outgoing, so the fleet never saw it',
    ).not.toContain('handover_outgoing')
  })

  it('comes back when the successor never got a pid', async () => {
    const fleet = new FakeFleetSocket()
    let openWhenSuccessorSpawned: boolean | undefined
    const parent = handingOver({
      fleet,
      successorPid: 0,
      onSpawnParent: () => {
        openWhenSuccessorSpawned = fleet.open
      },
    })
    await parent.start()

    await expect(parent.handover('9.9.9')).rejects.toThrow(/without a pid/)

    expect(openWhenSuccessorSpawned).toBe(false)
    expect(fleet.open, 'nothing was handed over, so nothing was given up').toBe(true)
  })
})


/** A parent whose children each get a lifecycle line, plus the spawn options it used. */
function channelParent(
  opts: {
    children?: Array<'server' | 'daemon'>
    identity?: () => { generation?: number; machineId?: string }
    supervisorGeneration?: number
    platform?: string
  } = {},
) {
  const spawned: Array<{
    role: string
    child: FakeChild
    options: Parameters<SpawnChildFn>[2]
  }> = []
  let nextPid = 300
  const parent = track(
    new ParentProcess({
      port: 19099,
      installBinary: '/opt/podium/podium',
      children: opts.children ?? ['server', 'daemon'],
      env: { PODIUM_APP_VERSION: '1.0.0', NODE_CHANNEL_FD: '3' },
      spawn: ((_cmd, args, options) => {
        const child = channelChild(nextPid++, args, options)
        spawned.push({ role: args[0] as string, child, options })
        return child as unknown as ReturnType<SpawnChildFn>
      }) as SpawnChildFn,
      probeHealth: async () => healthy('1.0.0'),
      probeDaemonHealth: async () => daemonHealthy('1.0.0'),
      probeServerReady: async () => true,
      notify: () => {},
      sleep: async () => {},
      now: () => 1_000,
      exit: () => {},
      ...(opts.identity ? { identity: opts.identity } : {}),
      ...(opts.supervisorGeneration !== undefined
        ? { supervisorGeneration: opts.supervisorGeneration }
        : {}),
      ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
    }),
  )
  return { parent, spawned }
}

describe('ParentProcess lifecycle channel (POD-3761)', () => {
  it('spawns every child with the ipc descriptor and without an inherited channel name', async () => {
    const { parent, spawned } = channelParent()
    await parent.start()
    expect(spawned).toHaveLength(2)
    for (const { options } of spawned) {
      // stdin/stdout/stderr stay whatever `childStdio` chose for this host (a
      // TTY inherits, a file sink appends); the line is always the fourth slot.
      const stdio = options.stdio as unknown[]
      expect(stdio).toHaveLength(4)
      expect(stdio[3]).toBe('ipc')
      expect(options.env?.NODE_CHANNEL_FD).toBeUndefined()
    }
  })

  it('tells each child who its parent is the moment it is spawned', async () => {
    const { parent, spawned } = channelParent({
      identity: () => ({ machineId: 'machine-a' }),
      supervisorGeneration: 42,
    })
    await parent.start()
    for (const { child } of spawned) {
      expect(child.sent[0]).toEqual({
        podium: 'podium-lifecycle/1',
        type: 'identity',
        generation: 42,
        machineId: 'machine-a',
      })
    }
  })

  it('records what a child reports on its line in the snapshot', async () => {
    const { parent, spawned } = channelParent({ children: ['server'] })
    await parent.start()
    const server = spawned[0]?.child as FakeChild
    expect(parent.lifecycle('server')).toEqual({
      channel: 'open',
      ready: { role: 'server', pid: server.pid, version: '1.0.0', port: 19099, atMs: 1_000 },
    })
    server.deliver({ podium: 'podium-lifecycle/1', type: 'degraded', reason: 'recovery-only' })
    expect(parent.lifecycle('server')).toEqual({
      channel: 'open',
      ready: { role: 'server', pid: server.pid, version: '1.0.0', port: 19099, atMs: 1_000 },
      degraded: { reason: 'recovery-only', atMs: 1_000 },
    })
    expect(parent.snapshot().lifecycle?.server).toEqual(parent.lifecycle('server'))
  })

  it('asks a retired child to stop on its line before signalling it', async () => {
    const { parent, spawned } = channelParent()
    await parent.start()
    const daemon = spawned.find((s) => s.role === 'daemon')?.child as FakeChild
    await parent.reconcileTopology(['server'], 'none')
    expect(daemon.sent[1]).toMatchObject({ type: 'stop' })
    expect(daemon.signalsReceived).toEqual(['SIGTERM'])
  })

  /**
   * A child with no line cannot report ready, so under POD-3762 it can never
   * prove the stack — the parent records the missing line and refuses, rather
   * than falling back to whatever the port says.
   */
  it('records a child spawned without a line as having none, and refuses to call it healthy', async () => {
    const clock = fakeClock()
    let nextPid = 400
    const notifications: string[] = []
    const parent = track(
      new ParentProcess({
        port: 19099,
        installBinary: '/opt/podium/podium',
        children: ['server'],
        env: { PODIUM_APP_VERSION: '1.0.0' },
        spawn: (() =>
          new MuteChild(nextPid++) as unknown as ReturnType<SpawnChildFn>) as SpawnChildFn,
        probeHealth: async () => healthy('1.0.0'),
        notify: (state) => notifications.push(state),
        sleep: async (ms) => clock.advance(ms),
        now: clock.now,
        exit: () => {},
      }),
    )
    await parent.start()
    expect(parent.lifecycle('server')).toEqual({ channel: 'none' })
    expect(parent.isBootHealthy()).toBe(false)
    expect(notifications).not.toContain('READY=1')
    await parent.reconcileTopology([], 'none')
  })
})

/**
 * POD-3790. On Windows a child dies within ~250 ms of the process that SPAWNED
 * it exiting, unless the spawn asked for detachment: POD-3774 measured six arms
 * on windows-latest and the handle-less attached child died exactly like the
 * channelled one, while every detached arm survived. So a supervisor was taking
 * its server and daemon down with it — no chance for them to report `stopping`
 * on their own line, and nothing left to restart them, because the process that
 * restarts them is the one that just died.
 *
 * These cases assert the SPAWN SHAPE rather than its consequence. The
 * consequence is invisible from a POSIX host, and on Windows an attached spawn
 * fails SILENTLY — no disconnect, no heartbeat, indistinguishable from a child
 * that was never going to survive.
 */
describe('supervised child persistence (POD-3790)', () => {
  it('detaches a supervised child on Windows and nowhere else', () => {
    expect(detachSupervisedChild('win32')).toBe(true)
    // POSIX children already outlive their supervisor and already get
    // `disconnect`. Detaching them there would put each in its own process
    // group, changing which signals a terminal delivers to them and what the
    // parent's crash-owner role can assume. Nothing there is broken; nothing
    // there changes.
    expect(detachSupervisedChild('linux')).toBe(false)
    expect(detachSupervisedChild('darwin')).toBe(false)
    expect(detachSupervisedChild('freebsd')).toBe(false)
  })

  it('spawns every supervised child detached on Windows', async () => {
    const { parent, spawned } = channelParent({ platform: 'win32' })
    await parent.start()
    expect(spawned.map((entry) => entry.role)).toEqual(['server', 'daemon'])
    for (const { role, options } of spawned) {
      expect(options.detached, `${role} must outlive the supervisor that spawned it`).toBe(true)
    }
  })

  it('leaves supervised children attached on POSIX', async () => {
    for (const platform of ['linux', 'darwin']) {
      const { parent, spawned } = channelParent({ platform })
      await parent.start()
      expect(spawned).toHaveLength(2)
      for (const { role, options } of spawned) {
        expect(options.detached, `${role} on ${platform}`).toBe(false)
      }
    }
  })

  it('still hands a detached Windows child its lifecycle line', async () => {
    // The flag and the line are one contract. `detached` is what keeps the
    // child alive long enough for the line to close under it, and the closing
    // line is what tells it the supervisor is gone. A detached child with no
    // line would survive and never be told; an attached child with a line is
    // already dead when the disconnect would have arrived.
    const { parent, spawned } = channelParent({ platform: 'win32' })
    await parent.start()
    for (const { options } of spawned) {
      expect((options.stdio as unknown[])[3]).toBe('ipc')
      expect(options.detached).toBe(true)
    }
  })
})
