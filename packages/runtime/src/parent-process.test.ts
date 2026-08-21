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
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PARENT_HANDOVER_EXPECTED_VERSION_ENV,
  ParentProcess,
  type SpawnChildFn,
} from './parent-process'
import type { HandoverHealthProbe } from './parent-supervisor'

class FakeChild extends EventEmitter {
  pid: number
  exitCode: number | null = null
  signalsReceived: string[] = []
  constructor(pid: number) {
    super()
    this.pid = pid
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

const healthy = (version: string): HandoverHealthProbe => ({
  serverRunning: true,
  serverVersion: version,
  daemonConnected: true,
})

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

afterEach(async () => {
  for (const parent of parents.splice(0)) {
    parent.removeSignalHandlers()
    await parent.stop()
  }
})

describe('ParentProcess', () => {
  it('spawns server before daemon from the install invocation', async () => {
    const spawned: Array<{ cmd: string; args: readonly string[] }> = []
    let nextPid = 100
    const spawnImpl: SpawnChildFn = (cmd, args) => {
      spawned.push({ cmd, args })
      return new FakeChild(nextPid++) as unknown as ReturnType<SpawnChildFn>
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

  it('RESPAWNS a crashed child once its backoff deadline passes', async () => {
    const clock = fakeClock()
    const serverKids: FakeChild[] = []
    let nextPid = 300
    const spawnImpl: SpawnChildFn = (_cmd, args) => {
      const child = new FakeChild(nextPid++)
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
    const spawnImpl: SpawnChildFn = (_cmd, args) => {
      const child = new FakeChild(nextPid++)
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
    const spawnImpl: SpawnChildFn = (_cmd, args) => {
      const child = new FakeChild(nextPid++)
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

  it('a successor that never gets healthy is killed and supervision comes back', async () => {
    const clock = fakeClock()
    let nextPid = 500
    let successor: FakeChild | undefined
    const kids: FakeChild[] = []
    const spawnImpl: SpawnChildFn = (_cmd, args) => {
      const child = new FakeChild(nextPid++)
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
