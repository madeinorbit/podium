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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type ParentOutcome, readParentOutcome } from './parent-control'
import {
  PARENT_HANDOVER_EXPECTED_VERSION_ENV,
  PARENT_HAS_SERVER_ENV,
  PARENT_POST_UPDATE_ENV,
  PARENT_RELEASE_MIGRATIONS_ENV,
  PARENT_SUCCESSOR_ENV,
  ParentProcess,
  type SpawnChildFn,
} from './parent-process'
import type { DaemonHandoverHealthProbe, HandoverHealthProbe } from './parent-supervisor'

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

  it('AUDIT NEGATIVE CONTROL: failed boot health must not claim ready ownership', async () => {
    const clock = fakeClock()
    const notifications: string[] = []
    let claimed = false
    let probeCount = 0
    const parent = track(
      new ParentProcess({
        port: 19099,
        installDir: '/opt/podium',
        installBinary: '/opt/podium/podium',
        env: { PODIUM_APP_VERSION: '1.0.0', [PARENT_SUCCESSOR_ENV]: '1' },
        children: ['server'],
        spawn: (() =>
          new FakeChild(125) as unknown as ReturnType<SpawnChildFn>) as SpawnChildFn,
        probeHealth: async () => {
          probeCount++
          return { serverRunning: false, serverVersion: null, daemonConnected: false }
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

    expect(probeCount).toBeGreaterThan(0)
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
          return new FakeChild(nextPid++) as unknown as ReturnType<SpawnChildFn>
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

  it('starts a daemon-only fleet member with its configured remote credential', async () => {
    const spawned: Array<{ cmd: string; args: readonly string[] }> = []
    const parent = track(
      new ParentProcess({
        port: 19099,
        installBinary: '/opt/podium/podium',
        children: ['daemon'],
        env: { PODIUM_APP_VERSION: '1.0.0' },
        spawn: ((cmd, args) => {
          spawned.push({ cmd, args })
          return new FakeChild(200) as unknown as ReturnType<SpawnChildFn>
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
        spawn: (() =>
          new FakeChild(nextPid++) as unknown as ReturnType<SpawnChildFn>) as SpawnChildFn,
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
    const spawnImpl: SpawnChildFn = () =>
      new FakeChild(nextPid++) as unknown as ReturnType<SpawnChildFn>
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
    const spawnImpl: SpawnChildFn = (_cmd, args) => {
      const child = new FakeChild(nextPid++)
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
    const spawnImpl: SpawnChildFn = (_cmd, args) => {
      const child = new FakeChild(nextPid++)
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
      const spawnImpl: SpawnChildFn = (_cmd, args) => {
        const child = new FakeChild(nextPid++)
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
      return new FakeChild(nextPid++) as unknown as ReturnType<SpawnChildFn>
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
      const spawnImpl: SpawnChildFn = (_cmd, args) => {
        const child = new FakeChild(nextPid++)
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
      const spawnImpl: SpawnChildFn = (_cmd, args) => {
        const child = new FakeChild(nextPid++)
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
      const spawnImpl: SpawnChildFn = (_cmd, args) => {
        const child = new FakeChild(nextPid++)
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
      const spawnImpl: SpawnChildFn = () =>
        new FakeChild(nextPid++) as unknown as ReturnType<SpawnChildFn>
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
      const spawnImpl: SpawnChildFn = (_cmd, args) => {
        const child = new FakeChild(nextPid++)
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
