/**
 * THE UPGRADE PROOF, ON REAL INSTANCES [POD-3767].
 *
 * Everything this epic built has been proved on ONE plane at a time. The
 * incarnation fence, the message-path re-fence and the compatibility-window
 * fallback were proved against a real server with hand-driven sockets
 * (apps/server/src/gateway/build-report.integration.test.ts); the handover
 * gate, the cede, the abort and the rollback were proved against real parent
 * processes with no coordinator at all (scripts/parent-lifecycle.integration.
 * test.ts). Neither can answer the question this issue asks, because the
 * question spans both: does a machine on the old stable reach the new
 * supervisor, and does a fleet with old and new supervisors in it survive a
 * wave without locking a machine out or stranding the coordinator?
 *
 * So this file joins them. A REAL coordinator — `startServer`, its real
 * `/machine` socket, its real machines store — and REAL parent processes, each
 * with its own state directory and its own credential, dialling it through the
 * production `createMachineSupervisorConnection`. The parents are the
 * parent-stack fixture, which is the real `ParentProcess` spawning real OS
 * children; POD-3767 gave it the fleet plane, wired in the order
 * apps/cli/src/cli.ts wires it.
 *
 * WHAT EACH ARM PROVES
 *   A  a machine installed on the old stable — legacy `daemon.json`, no
 *      incarnation, no `supervisor.json` — upgrades into the new supervisor
 *      WITHOUT becoming a second machine, and attaches as generation 1.
 *   B  a mixed fleet mid-wave: a parent that sends no generation attaches
 *      alongside stamped ones, cannot displace a stamped incarnation of its own
 *      machine, and — the property that matters — is not locked out for ever by
 *      one: when the stamped incarnation goes, it gets back in.
 *   C  a self-update handover settles. The row reaches the new version and
 *      NEVER goes back, which is the "restarting forever" POD-3752 removed.
 *   D  the abort path with the coordinator watching: the successor is killed and
 *      the outgoing parent REATTACHES, on its own generation, with the row back
 *      on the version that is actually running.
 *
 * THE RACE THIS FILE IS BUILT AROUND (POD-3789). A daemon or supervisor attach
 * completes AFTER the handshake reply, so an assertion placed straight after a
 * connection reads the pre-attach row every single time — deterministically,
 * not flakily. Every wait here is on a bus event the server emits AT the
 * transition, through {@link Coordinator.observes}, and never on a client-side
 * event or a sleep.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MachineId } from '@podium/model'
import { noJanitorWorkerForTests } from '../apps/server/src/janitor-host'
import { type ServerHandle, startServer } from '../apps/server/src/server'

const ROOT = join(import.meta.dirname, '..')
const FIXTURE = join(ROOT, 'scripts/fixtures/parent-stack-fixture.ts')

const roots: string[] = []
const started: ChildProcess[] = []
const servers: ServerHandle[] = []
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
    await new Promise((r) => setTimeout(r, 50))
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

async function temporaryRoot(tag: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `podium-fleet-${tag}-`))
  roots.push(root)
  return root
}

interface MachineRow {
  id: MachineId
  appVersion: string | null
  installKind: string | null
  deliveryCaps: string[]
}

class Coordinator {
  private constructor(
    readonly handle: ServerHandle,
    readonly url: string,
    /**
     * Every machine row that existed before this test put one there — the
     * coordinator's own host machine, and anything its local daemon link
     * registers. Subtracted by {@link Coordinator.fleet} so "how many machines
     * are there" counts the ones under test rather than the furniture.
     */
    private readonly baseline: ReadonlySet<string>,
  ) {}

  static async start(): Promise<Coordinator> {
    const stateDir = await temporaryRoot('coordinator')
    const previous = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = stateDir
    try {
      const handle = await startServer({
        janitorWorkerForTests: noJanitorWorkerForTests,
        port: 0,
      })
      servers.push(handle)
      const existing = (await handle.registry.modules.machines.listMachines()) as unknown as {
        id: string
      }[]
      return new Coordinator(
        handle,
        `http://127.0.0.1:${handle.port}`,
        new Set([handle.registry.modules.machines.hostMachineId, ...existing.map((r) => r.id)]),
      )
    } finally {
      if (previous === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = previous
    }
  }

  get machines() {
    return this.handle.registry.modules.machines
  }

  pairCode(): string {
    return this.machines.mintPairingCode()
  }

  async rows(): Promise<MachineRow[]> {
    return (await this.machines.listMachines()) as unknown as MachineRow[]
  }

  /** The machines THIS test put on the coordinator. */
  async fleet(): Promise<MachineRow[]> {
    return (await this.rows()).filter((row) => !this.baseline.has(row.id))
  }

  async row(machineId: MachineId): Promise<MachineRow | undefined> {
    return (await this.rows()).find((row) => row.id === machineId)
  }

  /**
   * Resolve once the SERVER has observed this transition — never once a client
   * has [POD-3789]. `machine.connected` is emitted by the supervisor socket only
   * after `attachSupervisor` has written the build and the map slot;
   * `machine.disconnected` only after `detachSupervisor` returned true, which is
   * after the compatibility-window fallback has been written. Both are emitted
   * AT the transition and nowhere else, which is why this is an event and not a
   * sleep.
   *
   * `match` selects the machine, because a fleet has several and the first event
   * to arrive is usually somebody else's.
   *
   * The deadline NAMES the missing event on a regression and never runs on the
   * passing path — the events land in single-digit milliseconds.
   */
  observes(
    event: 'machine.connected' | 'machine.disconnected',
    match?: MachineId | ((machineId: MachineId) => boolean),
    ms = 30_000,
  ): Promise<MachineId> {
    const wanted =
      match === undefined
        ? () => true
        : typeof match === 'function'
          ? match
          : (machineId: MachineId) => machineId === match
    return new Promise<MachineId>((resolve, reject) => {
      const deadline = setTimeout(() => {
        dispose()
        reject(
          new Error(
            `the coordinator never observed ${event}${
              typeof match === 'string' ? ` for ${match}` : ''
            }`,
          ),
        )
      }, ms)
      const dispose = this.handle.registry.bus.on(event, ({ machineId }) => {
        if (!wanted(machineId)) return
        clearTimeout(deadline)
        dispose()
        resolve(machineId)
      })
    })
  }
}

interface FleetParentOptions {
  /** Reuse an existing state directory — how an upgrade keeps its identity. */
  stateDir?: string
  /** A parent from BEFORE the fence: no incarnation claimed, none on the wire. */
  legacy?: boolean
  pairCode?: string
  version?: string
  env?: Record<string, string>
  /** Empty for a fleet-plane-only peer that supervises nothing. */
  children?: Array<'server' | 'daemon'>
}

interface FleetParent {
  process: ChildProcess
  pid: number
  stateDir: string
  installDir: string
  port: number
  machineId: MachineId
  output: () => string
  spawns: (role: string) => number[]
  notifications: () => string[]
  supervisorState: () => { machineId: string; token?: string; generation?: number }
  legacyState: () => { machineId: string; token?: string } | undefined
}

/**
 * A real parent process on both planes: the real `ParentProcess` supervising
 * real children, and the real machine supervisor connection dialling `url`.
 */
async function startFleetParent(
  coordinator: Coordinator,
  options: FleetParentOptions = {},
): Promise<FleetParent> {
  const stateDir = options.stateDir ?? (await temporaryRoot('machine'))
  const installDir = stateDir
  const port = await freePort()
  const version = options.version ?? '1.0.0'
  mkdirSync(join(stateDir, 'run'), { recursive: true })
  writeFileSync(join(installDir, 'VERSION'), `${version}\n`)
  const inherited = { ...process.env }
  delete inherited.PODIUM_AGENT_RELAY
  delete inherited.NOTIFY_SOCKET
  const child = spawn('bun', ['--conditions=@podium/source', FIXTURE, 'parent', '--takeover'], {
    cwd: ROOT,
    env: {
      ...inherited,
      PODIUM_STATE_DIR: stateDir,
      PODIUM_HOME: installDir,
      PODIUM_PORT: String(port),
      PODIUM_APP_VERSION: version,
      FIXTURE_FLEET_SERVER_URL: coordinator.url,
      ...(options.legacy ? { FIXTURE_FLEET_LEGACY: '1' } : {}),
      ...(options.pairCode ? { FIXTURE_FLEET_PAIR_CODE: options.pairCode } : {}),
      ...(options.children ? { FIXTURE_PARENT_CHILDREN: options.children.join(',') } : {}),
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  started.push(child)
  const pid = child.pid as number
  observedPids.add(pid)
  let output = ''
  child.stdout?.on('data', (c) => (output += String(c)))
  child.stderr?.on('data', (c) => (output += String(c)))

  const readJson = (name: string): Record<string, unknown> | undefined => {
    const path = join(stateDir, name)
    if (!existsSync(path)) return undefined
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  const supervisorState = () =>
    (readJson('supervisor.json') ?? {}) as {
      machineId: string
      token?: string
      generation?: number
    }
  // The parent writes `supervisor.json` before it says anything, so this is the
  // machine's identity as the COORDINATOR will hear it, read from the same file
  // the parent reads it from rather than guessed from the directory name.
  const machineId = (await until(
    () => supervisorState().machineId as MachineId | undefined,
    `the parent to claim a machine identity; log:\n${output}`,
  )) as MachineId

  return {
    process: child,
    pid,
    stateDir,
    installDir,
    port,
    machineId,
    output: () => output,
    spawns: (role) => {
      const path = join(stateDir, 'run', 'fixture-spawns.log')
      if (!existsSync(path)) return []
      const pids = readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' '))
        .filter(([r]) => r === role)
        .map(([, p]) => Number(p))
      for (const found of pids) observedPids.add(found)
      return pids
    },
    notifications: () => {
      const path = join(stateDir, 'run', 'fixture-notify.log')
      if (!existsSync(path)) return []
      return readFileSync(path, 'utf8').split('\n').filter(Boolean)
    },
    supervisorState,
    legacyState: () =>
      readJson('daemon.json') as { machineId: string; token?: string } | undefined,
  }
}

/** Stop a parent and everything under it, and wait for the pid to be gone. */
async function stopParent(parent: FleetParent): Promise<void> {
  for (const kid of childrenOf(parent.pid)) observedPids.add(kid)
  try {
    process.kill(parent.pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
  await until(() => (alive(parent.pid) ? undefined : true), 'the parent to exit', 15_000)
}

/**
 * Sample one machine's reported version until told to stop, keeping only the
 * CHANGES. An end-state assertion passes on the broken code too (POD-3796): the
 * defect this arm is about is a row that reaches the new version and then goes
 * BACK, which only a timeline can see.
 */
function recordVersions(
  coordinator: Coordinator,
  machineId: MachineId,
): { stop: () => Array<{ at: number; appVersion: string | null }> } {
  const timeline: Array<{ at: number; appVersion: string | null }> = []
  let running = true
  const origin = Date.now()
  const tick = async (): Promise<void> => {
    while (running) {
      try {
        const row = await coordinator.row(machineId)
        const appVersion = row?.appVersion ?? null
        if (timeline.at(-1)?.appVersion !== appVersion) {
          timeline.push({ at: Date.now() - origin, appVersion })
        }
      } catch {
        /* the row is briefly unreadable during a store write; the next tick sees it */
      }
      // 100ms, against a regression whose smallest window is the dialer's
      // 500ms minimum backoff: fast enough to catch the shortest flap the
      // reconnect ladder can produce, slow enough that reading the fleet on a
      // loop is not itself what perturbs the handover being measured.
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  void tick()
  return {
    stop: () => {
      running = false
      return timeline
    },
  }
}

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.pid) observedPids.add(child.pid)
  }
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
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  expect(stubborn, `${stubborn.length} process(es) ignored SIGTERM and needed SIGKILL`).toEqual([])
})

/**
 * Put a state directory back into the shape a machine on the old stable is in:
 * the credential in `daemon.json`, no `supervisor.json`, and no incarnation
 * anywhere. The credential is the one the coordinator actually issued, so the
 * machine that comes back is the same machine to the server — which is the
 * thing being proved, not something being arranged.
 */
function rewindToLegacyInstall(parent: FleetParent): { machineId: string; token: string } {
  const current = parent.supervisorState()
  expect(current.token, 'the machine paired and holds a coordinator-issued token').toBeTruthy()
  const legacy = { machineId: current.machineId, token: current.token as string }
  writeFileSync(join(parent.stateDir, 'daemon.json'), JSON.stringify(legacy, null, 2))
  unlinkSync(join(parent.stateDir, 'supervisor.json'))
  return legacy
}

describe('upgrade proof: the old stable and mixed fleets (real instances)', () => {
  /**
   * ARM A — A MACHINE ON THE OLD STABLE UPGRADES INTO THE NEW SUPERVISOR.
   *
   * The failure this rules out is the worst one available: the upgraded machine
   * arriving as a SECOND machine, because it could not find the credential the
   * old build left behind. The operator's fleet grows a ghost, the real row goes
   * stale, and nothing repairs either.
   *
   * The legacy state is not hand-written: the machine really pairs first, then
   * its directory is rewound to the 0.1.0 shape with the token the coordinator
   * really issued, and the new build is started on it.
   */
  it('ARM A — a 0.1.0 install keeps its identity, imports its credential, and attaches as generation 1', async () => {
    const coordinator = await Coordinator.start()

    // The machine as it was on the old stable: a parent that has never heard of
    // the fence, pairing with the coordinator for the first time.
    const beforeUpgrade = await startFleetParent(coordinator, {
      legacy: true,
      pairCode: coordinator.pairCode(),
      version: '0.1.0',
    })
    await coordinator.observes('machine.connected', beforeUpgrade.machineId)
    expect(await coordinator.row(beforeUpgrade.machineId)).toMatchObject({
      appVersion: '0.1.0',
      installKind: 'installed',
    })
    expect(
      coordinator.machines.attachedSupervisorGeneration(beforeUpgrade.machineId),
      'a build from before the fence attaches with no incarnation, read as zero',
    ).toBe(0)

    const detached = coordinator.observes('machine.disconnected', beforeUpgrade.machineId)
    await stopParent(beforeUpgrade)
    await detached

    const legacy = rewindToLegacyInstall(beforeUpgrade)
    expect(existsSync(join(beforeUpgrade.stateDir, 'supervisor.json'))).toBe(false)

    // THE UPGRADE: the new payload, on the same state directory.
    const upgraded = await startFleetParent(coordinator, {
      stateDir: beforeUpgrade.stateDir,
      version: '0.2.0-new-supervisor',
    })
    await coordinator.observes('machine.connected', upgraded.machineId)

    expect(upgraded.machineId, 'the upgrade is the SAME machine, not a new one').toBe(
      legacy.machineId,
    )
    expect(
      upgraded.supervisorState().token,
      'the credential was imported out of the legacy file, not re-paired',
    ).toBe(legacy.token)
    expect(
      upgraded.legacyState(),
      'daemon.json is left in place, because an older build may still read it',
    ).toMatchObject({ machineId: legacy.machineId })
    expect(
      upgraded.supervisorState().generation,
      'the first incarnation under the new build is 1',
    ).toBe(1)
    expect(
      coordinator.machines.attachedSupervisorGeneration(upgraded.machineId),
      'and that is the incarnation the coordinator has attached',
    ).toBe(1)
    expect(await coordinator.row(upgraded.machineId)).toMatchObject({
      appVersion: '0.2.0-new-supervisor',
      installKind: 'installed',
      deliveryCaps: ['update.delivery.feed'],
    })
    expect(
      (await coordinator.fleet()).map((row) => row.id),
      'the upgrade did not add a machine to the fleet',
    ).toEqual([legacy.machineId])
  }, 120_000)

  /**
   * ARM B — A MIXED FLEET MID-WAVE, AND THE LOCKOUT THAT MUST NOT HAPPEN.
   *
   * Three machines on one coordinator: one still on a build that sends no
   * incarnation, two on stamped builds. Then the hard half, on the unstamped
   * machine: a stamped incarnation of it arrives — as it would mid-wave, the
   * moment that machine takes its update — and the unstamped one must lose the
   * slot. That much is the fence working. The property this arm exists for is
   * the NEXT step: when the stamped incarnation goes away, the unstamped parent
   * must get back in. A fence that remembered the number it had seen would
   * refuse it for ever, and that machine would be locked out of its own fleet
   * with no way back short of reinstalling.
   *
   * The two incarnations of the unstamped machine are two real processes with
   * their own state directories and the SAME coordinator-issued credential,
   * which is what "two incarnations of one machine" is on the wire.
   */
  it('ARM B — an ungenerationed parent joins a stamped fleet, yields to a stamped incarnation, and is never locked out', async () => {
    const coordinator = await Coordinator.start()

    const unstamped = await startFleetParent(coordinator, {
      legacy: true,
      pairCode: coordinator.pairCode(),
      version: '0.1.0',
    })
    const stampedOne = await startFleetParent(coordinator, {
      pairCode: coordinator.pairCode(),
      version: '0.2.0',
    })
    const stampedTwo = await startFleetParent(coordinator, {
      pairCode: coordinator.pairCode(),
      version: '0.2.0',
    })
    for (const machine of [unstamped, stampedOne, stampedTwo]) {
      await coordinator.observes('machine.connected', machine.machineId)
    }

    // THE WAVE'S STARTING POSITION: every machine present, every row its own
    // version. The unstamped one is a peer, not a casualty.
    expect(
      Object.fromEntries(
        (await coordinator.fleet()).map((row) => [row.id, row.appVersion]),
      ),
    ).toEqual({
      [unstamped.machineId]: '0.1.0',
      [stampedOne.machineId]: '0.2.0',
      [stampedTwo.machineId]: '0.2.0',
    })
    expect(coordinator.machines.attachedSupervisorGeneration(unstamped.machineId)).toBe(0)
    expect(coordinator.machines.attachedSupervisorGeneration(stampedOne.machineId)).toBe(1)

    // The unstamped machine takes its update: a stamped incarnation of THAT
    // machine arrives while the unstamped one is still dialling.
    const takeoverDir = await temporaryRoot('takeover')
    writeFileSync(
      join(takeoverDir, 'supervisor.json'),
      JSON.stringify(unstamped.supervisorState(), null, 2),
    )
    // NOT waited on as a disconnect: displacement does not close the loser's
    // socket. `attachSupervisor` replaces the map entry, and the unstamped
    // parent's socket stays open until its next frame meets the message-path
    // re-fence — at which point `detachSupervisor` returns false, because it no
    // longer holds the slot, and no `machine.disconnected` is emitted. The
    // transition to wait for is the winner's attach.
    const stampedAttached = coordinator.observes('machine.connected', unstamped.machineId)
    const stampedIncarnation = await startFleetParent(coordinator, {
      stateDir: takeoverDir,
      version: '0.2.0',
    })
    expect(stampedIncarnation.machineId).toBe(unstamped.machineId)
    await stampedAttached

    await until(
      async () =>
        coordinator.machines.attachedSupervisorGeneration(unstamped.machineId) === 1
          ? true
          : undefined,
      'the stamped incarnation to hold the slot',
    )
    expect(
      (await coordinator.row(unstamped.machineId))?.appVersion,
      'the row belongs to the incarnation that is actually running',
    ).toBe('0.2.0')

    // The unstamped parent is still alive and still redialling on its backoff
    // ladder. Every one of those hellos is refused — the row must not flap back
    // to 0.1.0 while a newer incarnation holds the machine.
    await new Promise((r) => setTimeout(r, 3_000))
    expect(
      (await coordinator.row(unstamped.machineId))?.appVersion,
      'a superseded incarnation cannot write the row, however often it redials',
    ).toBe('0.2.0')
    expect(unstamped.process.exitCode, 'and it is refused by a close, not killed').toBeNull()

    // THE LOCKOUT TEST. The stamped incarnation goes away. Nothing is remembered
    // about the peer that was refused, so the unstamped parent's next redial —
    // its own, on its own ladder, with no help from this test — is admitted.
    const stampedGone = coordinator.observes('machine.disconnected', unstamped.machineId)
    await stopParent(stampedIncarnation)
    await stampedGone
    await coordinator.observes('machine.connected', unstamped.machineId)
    expect(
      coordinator.machines.attachedSupervisorGeneration(unstamped.machineId),
      'the unstamped parent is back on the machine it owns',
    ).toBe(0)
    await until(
      async () =>
        (await coordinator.row(unstamped.machineId))?.appVersion === '0.1.0' ? true : undefined,
      'the row to follow the incarnation that is running again',
    )

    // The rest of the fleet never noticed any of it.
    expect(
      Object.fromEntries(
        (await coordinator.fleet()).map((row) => [row.id, row.appVersion]),
      ),
    ).toEqual({
      [unstamped.machineId]: '0.1.0',
      [stampedOne.machineId]: '0.2.0',
      [stampedTwo.machineId]: '0.2.0',
    })
  }, 180_000)

  /**
   * ARM C — A SELF-UPDATE HANDOVER SETTLES, AND THE ROW NEVER GOES BACK.
   *
   * The defect POD-3752 removed is not visible in an end state. Both parents are
   * dialling the coordinator during the handover, and when the outgoing one's
   * hello landed last it wrote the version it was about to stop running onto the
   * row — after which nothing could repair it, because the successor had no
   * reason to say hello again. The row stayed on the old version and the machine
   * showed `restarting` for ever. So the assertion is on the TIMELINE: the
   * versions this row ever held, in order, and 1.0.0 must not appear after
   * 2.0.0.
   */
  it('ARM C — a self-update handover settles on the successor and the row never regresses', async () => {
    const coordinator = await Coordinator.start()
    const machine = await startFleetParent(coordinator, {
      pairCode: coordinator.pairCode(),
      version: '1.0.0',
    })
    await coordinator.observes('machine.connected', machine.machineId)
    await until(
      () => (machine.notifications().includes('READY=1') ? true : undefined),
      `the outgoing parent to finish booting; log:\n${machine.output()}`,
      60_000,
    )
    expect(coordinator.machines.attachedSupervisorGeneration(machine.machineId)).toBe(1)

    const versions = recordVersions(coordinator, machine.machineId)
    // BOTH listeners registered before the handover is asked for. The successor
    // is a fresh process that has to boot before it dials, so its attach is
    // hundreds of milliseconds away — but "probably later" is how the race in
    // POD-3789 was missed, and a listener costs nothing.
    const ceded = coordinator.observes('machine.disconnected', machine.machineId)
    const successorAttached = coordinator.observes('machine.connected', machine.machineId)

    // The "update": the new bundle is on disk, and the parent is asked to hand
    // over to it through the real request channel.
    writeFileSync(join(machine.installDir, 'VERSION'), '2.0.0\n')
    const { writeParentRequest } = await import('../packages/runtime/src/parent-control')
    writeParentRequest(
      {
        requestId: 'fleet-upgrade-arm-c',
        kind: 'handover',
        expectedVersion: '2.0.0',
        requestedAt: new Date().toISOString(),
      },
      machine.stateDir,
    )
    process.kill(machine.pid, 'SIGUSR1')

    await ceded
    await successorAttached
    await until(
      () => (machine.process.exitCode !== null ? true : undefined),
      `the outgoing parent to exit after the handover; log:\n${machine.output()}`,
      60_000,
    )
    expect(machine.process.exitCode, 'a clean handover exit').toBe(0)

    const settled = await until(
      async () =>
        (await coordinator.row(machine.machineId))?.appVersion === '2.0.0' ? true : undefined,
      'the coordinator row to settle on the successor',
      30_000,
    )
    expect(settled).toBe(true)
    expect(
      coordinator.machines.attachedSupervisorGeneration(machine.machineId),
      'the successor holds the machine as the NEXT incarnation',
    ).toBe(2)
    expect(
      machine.supervisorState().generation,
      'and it persisted that incarnation, so a reboot cannot repeat it',
    ).toBe(2)

    // Hold the machine long enough for the outgoing parent's ladder to have
    // redialled several times, had it been going to. Then read the whole
    // timeline: this is the assertion, not the end state.
    await new Promise((r) => setTimeout(r, 5_000))
    const timeline = versions.stop()
    const seen = timeline.map((entry) => entry.appVersion)
    expect(seen.at(-1), 'the row ends on the version that is running').toBe('2.0.0')
    expect(
      seen.indexOf('1.0.0') === -1 || seen.lastIndexOf('1.0.0') < seen.indexOf('2.0.0'),
      `the row must never return to 1.0.0 once 2.0.0 has been reported: ${JSON.stringify(timeline)}`,
    ).toBe(true)
    expect(
      (await coordinator.fleet()).length,
      'a handover is one machine changing incarnation, not two machines',
    ).toBe(1)
  }, 180_000)

  /**
   * ARM E — A SAME-VERSION HANDOVER, SEEN FROM THE COORDINATOR.
   *
   * The version is the field everything else reaches for, and in this case it
   * says nothing: the machine hands over to a parent running the identical
   * bundle, so the row before and the row after are the same row. POD-3762
   * proved the process plane copes — the outgoing parent waits for its
   * successor's OWN children rather than for whatever answers the port. What
   * nobody has asked is whether the COORDINATOR can tell the two apart, and it
   * has to be able to: the fence is what stops the outgoing parent's last hello
   * from taking the slot back, and on a same-version handover the fence's input
   * is the only thing that differs between the two peers.
   *
   * So the assertion is the incarnation, not the version. 1 hands over to 2,
   * the version never moves, and the machine ends up attached as 2.
   */
  it('ARM E — a same-version handover advances the incarnation the coordinator holds, though the version cannot', async () => {
    const coordinator = await Coordinator.start()
    const machine = await startFleetParent(coordinator, {
      pairCode: coordinator.pairCode(),
      version: '1.0.0',
    })
    await coordinator.observes('machine.connected', machine.machineId)
    await until(
      () => (machine.notifications().includes('READY=1') ? true : undefined),
      `the outgoing parent to finish booting; log:\n${machine.output()}`,
      60_000,
    )
    expect(coordinator.machines.attachedSupervisorGeneration(machine.machineId)).toBe(1)

    const ceded = coordinator.observes('machine.disconnected', machine.machineId)
    const successorAttached = coordinator.observes('machine.connected', machine.machineId)
    // NOTHING ON DISK CHANGES. The bundle stays at 1.0.0, which is what makes
    // this the case where the version can distinguish nothing.
    const { writeParentRequest } = await import('../packages/runtime/src/parent-control')
    writeParentRequest(
      {
        requestId: 'fleet-upgrade-arm-e',
        kind: 'handover',
        expectedVersion: '1.0.0',
        requestedAt: new Date().toISOString(),
      },
      machine.stateDir,
    )
    process.kill(machine.pid, 'SIGUSR1')

    await ceded
    await successorAttached
    await until(
      () => (machine.process.exitCode !== null ? true : undefined),
      `the outgoing parent to exit after the same-version handover; log:\n${machine.output()}`,
      60_000,
    )
    expect(machine.process.exitCode, 'a clean handover exit').toBe(0)

    await until(
      () =>
        coordinator.machines.attachedSupervisorGeneration(machine.machineId) === 2
          ? true
          : undefined,
      'the coordinator to hold the successor as incarnation 2',
    )
    expect(
      machine.supervisorState().generation,
      'and the successor persisted it, so a reboot resumes past it',
    ).toBe(2)
    expect(
      (await coordinator.row(machine.machineId))?.appVersion,
      'the version is the same on both sides of the handover, which is the point',
    ).toBe('1.0.0')
    expect(
      (await coordinator.fleet()).length,
      'still one machine, one slot, one incarnation holding it',
    ).toBe(1)
  }, 180_000)

  /**
   * ARM D — THE ABORT PATH, WITH THE COORDINATOR WATCHING.
   *
   * A successor spawns, dials the coordinator IMMEDIATELY — before it is healthy,
   * because that is when `cli.ts` starts the connection — and then never comes
   * up. The outgoing parent's gate expires, it kills the successor and takes the
   * machine back. Two things have to be true at the end, and only one of them
   * has been proved before: the box has to be supervised again (proved on the
   * process plane), and the COORDINATOR has to know it. A fence that remembered
   * the successor's incarnation would refuse the parent that is actually running
   * the machine, and the row would name a process that no longer exists.
   *
   * `fixture-server-never-ready` is armed partway through, so only the
   * successor's server stays silent on its line; the outgoing parent's identical
   * children already came up.
   */
  it('ARM D — a killed successor hands the machine back, and the outgoing parent reattaches', async () => {
    const coordinator = await Coordinator.start()
    const machine = await startFleetParent(coordinator, {
      pairCode: coordinator.pairCode(),
      version: '1.0.0',
      env: { FIXTURE_HANDOVER_TIMEOUT_MS: '8000' },
    })
    await coordinator.observes('machine.connected', machine.machineId)
    await until(
      () => (machine.notifications().includes('READY=1') ? true : undefined),
      `the outgoing parent to finish booting; log:\n${machine.output()}`,
      60_000,
    )
    const parentSpawnsBefore = machine.spawns('parent').length

    // From here, a server this stack spawns comes up and serves but never says
    // so on its own line, so the successor can never pass its health gate.
    writeFileSync(join(machine.stateDir, 'run', 'fixture-server-never-ready'), '')

    const versions = recordVersions(coordinator, machine.machineId)
    const ceded = coordinator.observes('machine.disconnected', machine.machineId)
    // The successor dials the coordinator from the moment it boots, long before
    // it is healthy — registered here, before the handover is asked for, so the
    // attach cannot land between the cede resolving and a listener appearing.
    const successorAttached = coordinator.observes('machine.connected', machine.machineId)
    writeFileSync(join(machine.installDir, 'VERSION'), '2.0.0\n')
    const { writeParentRequest } = await import('../packages/runtime/src/parent-control')
    writeParentRequest(
      {
        requestId: 'fleet-upgrade-arm-d',
        kind: 'handover',
        expectedVersion: '2.0.0',
        requestedAt: new Date().toISOString(),
      },
      machine.stateDir,
    )
    process.kill(machine.pid, 'SIGUSR1')
    await ceded

    const successorPid = await until(() => {
      const pids = machine.spawns('parent')
      return pids.length > parentSpawnsBefore ? (pids[parentSpawnsBefore] as number) : undefined
    }, `the successor parent to be spawned; log:\n${machine.output()}`)
    observedPids.add(successorPid)

    // The successor reaches the coordinator before it is healthy — that is the
    // window the fence exists for, and it really is open.
    await successorAttached
    await until(
      () =>
        coordinator.machines.attachedSupervisorGeneration(machine.machineId) === 2
          ? true
          : undefined,
      'the successor to hold the machine as incarnation 2',
    )

    // The gate expires. The successor is killed and the machine comes back to
    // the parent that never stopped running it.
    const successorGone = coordinator.observes('machine.disconnected', machine.machineId)
    const parentReattached = coordinator.observes('machine.connected', machine.machineId)
    await until(
      () => (alive(successorPid) ? undefined : true),
      `the doomed successor to be killed; log:\n${machine.output()}`,
      40_000,
    )
    await successorGone
    await parentReattached

    expect(machine.process.exitCode, 'the outgoing parent must still be here').toBeNull()
    expect(
      coordinator.machines.attachedSupervisorGeneration(machine.machineId),
      'the machine is held by incarnation 1 again, which is the one running it',
    ).toBe(1)
    const settled = await until(
      async () =>
        (await coordinator.row(machine.machineId))?.appVersion === '1.0.0' ? true : undefined,
      'the row to name the version that is actually running',
      30_000,
    )
    expect(settled).toBe(true)

    const timeline = versions.stop()
    expect(
      timeline.at(-1)?.appVersion,
      `the aborted release must not be left on the row: ${JSON.stringify(timeline)}`,
    ).toBe('1.0.0')
    expect(
      machine.notifications().filter((n) => n.startsWith('MAINPID=')),
      'MAINPID must never name a successor that failed its gate',
    ).toEqual([])
  }, 180_000)
})
