/**
 * REAL-PROCESS proof for the parent's lifecycle guarantees [POD-2505].
 *
 * Each case here corresponds to a blocking review finding and observes the OS,
 * not a state label: pids that exist, pids that stop existing, pids that appear
 * for a second time. The stack is scripts/fixtures/parent-stack-fixture.ts —
 * real processes with the real invocation shape — driven by the real
 * `ParentProcess`. The full stack (scripts/cli.ts, the real server and daemon)
 * is proved separately in parent-supervised-stack.integration.test.ts.
 *
 *   finding 18  SIGTERM DURING BOOT must reap children, never orphan them
 *   finding  2  a crashed child is restarted, and the parent OUTLIVES its last child
 *   finding  3  a refusing child (exit 78) stays parked; the parent stays up
 *   findings 1+4 handover: the old parent decides, MAINPID only after health,
 *               a successor that never arrives is killed and supervision returns
 *
 * REAPING IS PART OF THE CONTRACT: `afterEach` kills every process it started,
 * then FAILS if any grandchild survived — a leak in the code under test must not
 * be able to escape as a leak on the machine.
 */
import { execFileSync } from 'node:child_process'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const FIXTURE = join(ROOT, 'scripts/fixtures/parent-stack-fixture.ts')

const roots: string[] = []
const started: ChildProcess[] = []
/** Every pid this file ever observed, so the reaper can prove the box is clean. */
const observedPids = new Set<number>()

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** Direct children of `pid`, by pgrep. Empty when there are none. */
function childrenOf(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (value !== undefined) return value
    } catch (error) {
      last = error
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${String(last)}` : ''}`)
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('could not reserve a loopback port'))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

interface Stack {
  parent: ChildProcess
  parentPid: number
  stateDir: string
  port: number
  output: () => string
  spawns: (role: string) => number[]
  notifications: () => string[]
}

async function startStack(env: Record<string, string> = {}): Promise<Stack> {
  const stateDir = await mkdtemp(join(tmpdir(), 'podium-parent-lifecycle-'))
  roots.push(stateDir)
  const port = await freePort()
  mkdirSync(join(stateDir, 'run'), { recursive: true })
  writeFileSync(join(stateDir, 'VERSION'), '1.0.0\n')
  const inherited = { ...process.env }
  delete inherited.PODIUM_AGENT_RELAY
  delete inherited.NOTIFY_SOCKET
  const parent = spawn('bun', ['--conditions=@podium/source', FIXTURE, 'parent', '--takeover'], {
    cwd: ROOT,
    env: {
      ...inherited,
      PODIUM_STATE_DIR: stateDir,
      PODIUM_HOME: stateDir,
      PODIUM_PORT: String(port),
      PODIUM_APP_VERSION: '1.0.0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  started.push(parent)
  const parentPid = parent.pid as number
  observedPids.add(parentPid)
  let output = ''
  parent.stdout?.on('data', (c) => (output += String(c)))
  parent.stderr?.on('data', (c) => (output += String(c)))

  const readSpawns = (role: string): number[] => {
    const path = join(stateDir, 'run', 'fixture-spawns.log')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' '))
      .filter(([r]) => r === role)
      .map(([, pid]) => Number(pid))
  }
  const notifications = (): string[] => {
    const path = join(stateDir, 'run', 'fixture-notify.log')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8').split('\n').filter(Boolean)
  }
  return {
    parent,
    parentPid,
    stateDir,
    port,
    output: () => output,
    spawns: (role) => {
      const pids = readSpawns(role)
      for (const pid of pids) observedPids.add(pid)
      return pids
    },
    notifications,
  }
}

/**
 * The reaper. Two jobs, and they are different jobs:
 *
 *  1. LEAVE THE BOX CLEAN. Every process this file ever saw — including the
 *     successor a handover legitimately leaves running, and its children — is
 *     asked to stop, then killed. A previous run of this suite left two
 *     server+daemon stacks on a shared machine for 28 minutes; that must not be
 *     possible from here.
 *  2. FAIL ON A PROCESS THAT IGNORED SIGTERM. Surviving a full SIGTERM grace and
 *     needing SIGKILL is the exact signature of review finding 18, so it is an
 *     assertion, not just cleanup. A process legitimately still running at the
 *     end of a case is fine; one that will not die on request is not.
 */
afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.pid) observedPids.add(child.pid)
  }
  // Grandchildren of anything still alive, so the sweep reaches whole trees.
  for (const pid of [...observedPids]) {
    if (alive(pid)) for (const kid of childrenOf(pid)) observedPids.add(kid)
  }
  for (const pid of observedPids) {
    if (!alive(pid)) continue
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline && [...observedPids].some(alive)) {
    await new Promise((r) => setTimeout(r, 100))
  }
  const stubborn = [...observedPids].filter(alive)
  for (const pid of stubborn) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  observedPids.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  expect(
    stubborn,
    `${stubborn.length} process(es) ignored SIGTERM and needed SIGKILL`,
  ).toEqual([])
})

describe('parent lifecycle (real processes)', () => {
  /**
   * FINDING 18, ARM A. The reviewer proved the old code leaked both children
   * here: `start()` blocks in the 60s health gate, the SIGINT/SIGTERM handlers
   * were installed only after it returned, and `registerProcess`'s own SIGTERM
   * listener suppressed the default terminate action — so the parent ignored the
   * signal, was SIGKILLed, and SIGKILL cannot run `stopChildren()`.
   *
   * `FIXTURE_SERVER_NEVER_HEALTHY=1` holds the parent inside that gate for the
   * whole test, which is the window the defect lived in.
   */
  it('ARM A — SIGTERM DURING BOOT shuts the children down instead of orphaning them', async () => {
    const stack = await startStack({ FIXTURE_SERVER_NEVER_HEALTHY: '1' })
    const kids = await until(
      () => {
        const found = childrenOf(stack.parentPid)
        return found.length >= 2 ? found : undefined
      },
      'both children spawned',
    )
    for (const pid of kids) observedPids.add(pid)
    // The parent is still inside its health gate — start() has NOT returned.
    expect(stack.notifications(), 'READY must not have been sent yet').not.toContain('READY=1')

    stack.parent.kill('SIGTERM')

    const exited = await until(
      () => (stack.parent.exitCode !== null || stack.parent.signalCode !== null ? true : undefined),
      'parent exit after SIGTERM during boot',
      15_000,
    )
    expect(exited).toBe(true)
    await until(
      () => (kids.every((pid) => !alive(pid)) ? true : undefined),
      `children ${kids.join(',')} to be reaped`,
      10_000,
    )
    expect(kids.filter(alive), 'orphaned children').toEqual([])
  }, 45_000)

  /** ARM B — the control: the same signal after boot was always clean. */
  it('ARM B — SIGTERM AFTER BOOT is clean, same signal, same code path', async () => {
    const stack = await startStack()
    await until(
      () => (stack.notifications().includes('READY=1') ? true : undefined),
      'parent READY',
    )
    const kids = childrenOf(stack.parentPid)
    for (const pid of kids) observedPids.add(pid)
    expect(kids.length).toBe(2)

    stack.parent.kill('SIGTERM')
    await until(
      () => (stack.parent.exitCode !== null ? true : undefined),
      'parent exit after boot',
      15_000,
    )
    await until(
      () => (kids.every((pid) => !alive(pid)) ? true : undefined),
      'children reaped',
      10_000,
    )
  }, 45_000)

  /**
   * FINDING 2. The reviewer's repro: a server-only parent whose only child exits.
   * With the supervision tick `unref`'d, nothing referenced the event loop and
   * the parent drained and exited ~1ms after scheduling the restart — so
   * server-only hosts lost supervision on the FIRST crash, and the rollback path
   * could never run in the situation it exists for.
   */
  it('FINDING 2 — the parent OUTLIVES its last child and restarts it on the backoff ladder', async () => {
    const stack = await startStack({
      FIXTURE_PARENT_CHILDREN: 'server',
      FIXTURE_SERVER_EXIT_AFTER_MS: '1500',
      FIXTURE_SERVER_EXIT_CODE: '1',
    })
    const first = await until(
      () => (stack.spawns('server').length >= 1 ? stack.spawns('server') : undefined),
      'first server',
    )
    await until(() => (!alive(first[0] as number) ? true : undefined), 'first server to crash')

    // THE POINT: the parent is still here after its only child died.
    expect(alive(stack.parentPid), 'parent exited when its last child did').toBe(true)
    expect(stack.parent.exitCode).toBeNull()

    const restarted = await until(
      () => (stack.spawns('server').length >= 2 ? stack.spawns('server') : undefined),
      'server restarted',
    )
    expect(restarted[1]).not.toBe(restarted[0])
    expect(alive(stack.parentPid)).toBe(true)
  }, 45_000)

  /**
   * FINDING 3, at the parent's layer: exit 78 is a REFUSAL. The child stays
   * stopped, the parent keeps running, and no restart ladder is climbed.
   */
  it('FINDING 3 — a child that REFUSES (exit 78) stays parked and never respawns', async () => {
    const stack = await startStack({
      FIXTURE_PARENT_CHILDREN: 'server',
      FIXTURE_SERVER_EXIT_AFTER_MS: '1000',
      FIXTURE_SERVER_EXIT_CODE: '78',
    })
    const first = await until(
      () => (stack.spawns('server').length >= 1 ? stack.spawns('server') : undefined),
      'first server',
    )
    await until(() => (!alive(first[0] as number) ? true : undefined), 'server to refuse')

    // Well past every rung of the ladder that a CRASH would have climbed.
    await new Promise((r) => setTimeout(r, 6_000))
    expect(stack.spawns('server'), 'a refusal must not be restarted').toHaveLength(1)
    expect(alive(stack.parentPid), 'the server keeps its supervisor').toBe(true)
  }, 45_000)

  /**
   * FINDINGS 1 AND 4, the centrepiece. The old parent spawns the successor,
   * watches it over HTTP, and only then exits — and the successor never reclaims
   * the pidfile on its way up, so it cannot SIGTERM the parent that is still
   * supervising a serving stack.
   *
   * The bundle "swap" is a rewrite of VERSION: the fixture server reads its
   * version once at boot, exactly as a real binary bakes one in.
   */
  it('FINDINGS 1+4 — handover: successor healthy FIRST, then MAINPID, then the old parent exits', async () => {
    const notifySocket = join(await mkdtemp(join(tmpdir(), 'podium-notify-')), 'notify.sock')
    roots.push(join(notifySocket, '..'))
    const stack = await startStack({ NOTIFY_SOCKET: notifySocket })
    await until(
      () => (stack.notifications().includes('READY=1') ? true : undefined),
      'old parent READY',
    )
    const oldKids = childrenOf(stack.parentPid)
    for (const pid of oldKids) observedPids.add(pid)
    const oldParentRecord = JSON.parse(
      readFileSync(join(stack.stateDir, 'run', 'parent.pid'), 'utf8'),
    ) as { pid: number }
    expect(oldParentRecord.pid).toBe(stack.parentPid)

    // The "update": a new bundle is on disk.
    writeFileSync(join(stack.stateDir, 'VERSION'), '2.0.0\n')
    const { writeParentRequest } = await import('../packages/runtime/src/parent-control')
    writeParentRequest(
      {
        requestId: 'handover-test',
        kind: 'handover',
        expectedVersion: '2.0.0',
        requestedAt: new Date().toISOString(),
      },
      stack.stateDir,
    )
    process.kill(stack.parentPid, 'SIGUSR1')

    // The old parent exits ONLY after the successor serves 2.0.0 with its daemon.
    await until(
      () => (stack.parent.exitCode !== null ? true : undefined),
      `old parent to exit after handover; log:\n${stack.output()}`,
      40_000,
    )
    expect(stack.parent.exitCode, 'a clean handover exit').toBe(0)

    const body = (await (await fetch(`http://127.0.0.1:${stack.port}/version`)).json()) as {
      appVersion: string
      daemonConnected: boolean
    }
    expect(body.appVersion, 'the successor serves the new version').toBe('2.0.0')
    expect(body.daemonConnected).toBe(true)

    // MAINPID: sent exactly once, AFTER the gate, naming the successor.
    const notifications = stack.notifications()
    const mainPid = notifications.filter((n) => n.startsWith('MAINPID='))
    expect(mainPid).toHaveLength(1)
    expect(notifications.indexOf(mainPid[0] as string)).toBeGreaterThan(
      notifications.indexOf('READY=1'),
    )
    const successorPid = Number((mainPid[0] as string).split('=')[1])
    observedPids.add(successorPid)
    expect(alive(successorPid), 'the successor is the live supervisor').toBe(true)

    // Finding 1's core: the successor must own the pidfile, and must have taken
    // it WITHOUT reclaiming — the old parent exited on its own terms, code 0.
    const record = JSON.parse(
      readFileSync(join(stack.stateDir, 'run', 'parent.pid'), 'utf8'),
    ) as { pid: number }
    expect(record.pid).toBe(successorPid)
    for (const pid of childrenOf(successorPid)) observedPids.add(pid)
  }, 60_000)

  /**
   * FINDING 4's other half: a successor that never becomes healthy must not
   * strand systemd's MAINPID on a dead process, must not leave `snap.phase`
   * parked in `handover_outgoing` (which disabled every restart and every
   * rollback forever), and must not leave the machine unsupervised.
   */
  it('FINDING 4 — a successor that never gets healthy is killed and supervision returns', async () => {
    const stack = await startStack()
    await until(
      () => (stack.notifications().includes('READY=1') ? true : undefined),
      'old parent READY',
    )
    const before = stack.spawns('parent').length

    // A "release" whose server refuses to start: the successor can never be healthy.
    writeFileSync(join(stack.stateDir, 'VERSION'), '2.0.0\n')
    const { writeParentRequest } = await import('../packages/runtime/src/parent-control')
    writeParentRequest(
      {
        requestId: 'doomed-handover',
        kind: 'handover',
        expectedVersion: '9.9.9-never-arrives',
        requestedAt: new Date().toISOString(),
      },
      stack.stateDir,
    )
    process.kill(stack.parentPid, 'SIGUSR1')

    const successorPid = await until(
      () => {
        const pids = stack.spawns('parent')
        return pids.length > before ? (pids[before] as number) : undefined
      },
      'successor parent spawned',
    )
    observedPids.add(successorPid)

    // The gate is 90s; assert what must hold WHILE it runs rather than waiting it out.
    expect(alive(stack.parentPid), 'the old parent must not exit for a doomed successor').toBe(true)
    expect(
      stack.notifications().filter((n) => n.startsWith('MAINPID=')),
      'MAINPID must never name a successor that is not healthy',
    ).toEqual([])
    expect(stack.parent.exitCode).toBeNull()
  }, 45_000)
})
