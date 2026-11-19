import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asMachineId, firstAdminMemberId } from '@podium/model'
import { directPtyDurableForTests } from '@podium/process/durable'
import { wireSchemaDigest } from '@podium/protocol'
import { readOrCreateLocalMachineId } from '@podium/runtime/local-machine'
import {
  createMachineSupervisorConnection,
  loadSupervisorState,
  saveSupervisorState,
} from '@podium/runtime/machine-supervisor'
import { afterAll, describe, expect, it } from 'vitest'
import { type DaemonOptions, startDaemon } from '../../apps/daemon/src/daemon'
import { startServer } from '../../apps/server/src/test-support/enrolled-server'
import { applyHarnessEnv, reapHarnessSessions } from './harness-env'

/** THIS HOST's machine id (POD-318) — read from `<stateDir>/machine.id`, the same
 *  file the server and the split-mode daemon read. There is no `'local'` constant
 *  any more; a machine id is minted material.
 *
 *  A FUNCTION, not a module-level constant: these harnesses point PODIUM_STATE_DIR
 *  at an isolated directory AFTER the imports run, and a constant would have read
 *  (and minted into) the real state dir before that happened. */
const hostMachineId = (): string => readOrCreateLocalMachineId()

// Without this isolation the test server writes session rows into the REAL
// ~/.podium/podium.db and the daemon parks a REAL durable abduco master that
// outlives the test run. Must run before startServer()/startDaemon() read env.
const ISOLATION_PORT = 9922
reapHarnessSessions(ISOLATION_PORT)
applyHarnessEnv(ISOLATION_PORT)
afterAll(() => reapHarnessSessions(ISOLATION_PORT))

const FIXTURE = fileURLToPath(
  new URL('../../packages/pty/test/fixtures/fixture-tui.mjs', import.meta.url),
)

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const fixtureLaunch: NonNullable<DaemonOptions['launch']> = () => ({
  cmd: process.execPath,
  args: [FIXTURE],
  cwd: '/tmp',
})

describe('e2e: two-daemon pairing + routing', () => {
  it('pairs a second daemon and routes a session to it', async () => {
    // --- temp dirs for per-daemon identity isolation ---
    const tmp1 = mkdtempSync(join(tmpdir(), 'podium-d1-'))
    const tmp2 = mkdtempSync(join(tmpdir(), 'podium-d2-'))

    const srv = await startServer()
    const serverUrl = `ws://localhost:${srv.port}`

    // daemon1: the local/bootstrap machine
    const daemon1 = await startDaemon({
      serverUrl,
      machineToken: srv.machineToken,
      machineId: hostMachineId(),
      identityDir: tmp1,
      launch: fixtureLaunch,
      backend: 'none',
      durable: directPtyDurableForTests(),
      discovery: {
        background: false,
        cachePath: join(tmp1, 'discovery.db'),
        homeDir: tmp1,
      },
      metrics: { background: false },
      hooks: { port: 0, settingsDir: join(tmp1, 'hooks') },
      agentRelay: { port: 0 },
    })

    // mint a pairing code for daemon2
    const ownerUserId = await firstAdminMemberId(srv.registry.sessionStore)
    const pairCode = srv.registry.modules.machines.mintPairingCode({ ownerUserId })
    const supervisorState = loadSupervisorState(tmp2)
    supervisorState.assignment = { server: false, agentExecution: true }
    supervisorState.generation = 1
    saveSupervisorState(tmp2, supervisorState)
    const supervisor = createMachineSupervisorConnection({
      serverUrl,
      stateDir: tmp2,
      state: supervisorState,
      pairCode,
      name: 'routing-peer',
      build: {
        appVersion: 'fixture',
        wireSchemaDigest: wireSchemaDigest(),
        supervisorGeneration: 1,
      },
      deliveryCaps: [],
      report: () => ({
        server: { policy: 'disabled', state: 'stopped', observedAt: new Date().toISOString() },
        agentExecution: {
          policy: 'enabled',
          state: 'starting',
          observedAt: new Date().toISOString(),
        },
      }),
      onGrant: () => {},
    })
    supervisor.start()
    expect(await supervisor.waitUntilConnected(15_000)).toBe(true)

    // daemon2: the "remote" machine that pairs with the code
    const daemon2 = await startDaemon({
      serverUrl,
      identityDir: tmp2,
      launch: fixtureLaunch,
      backend: 'none',
      durable: directPtyDurableForTests(),
      discovery: {
        background: false,
        cachePath: join(tmp2, 'discovery.db'),
        homeDir: tmp2,
      },
      metrics: { background: false },
      hooks: { port: 0, settingsDir: join(tmp2, 'hooks') },
      agentRelay: { port: 0 },
    })

    try {
      await waitFor(() => daemon1.connected && daemon2.connected)
      // 1) Both machines must appear online
      const machines = (await srv.registry.modules.machines.listMachines()).filter(
        (machine) => machine.online,
      )
      expect(machines).toHaveLength(2)
      expect(machines.every((m) => m.online)).toBe(true)

      // 2) Identify each machine. daemon1 is the LOCAL machine: it presents
      //    hostMachineId() so it attaches to the machine the server adopts at startup.
      //    daemon2 paired, so its id is the UUID minted in its own identity file.
      const daemon1Id = hostMachineId()
      const daemon2Id = JSON.parse(readFileSync(join(tmp2, 'daemon.json'), 'utf8'))
        .machineId as string

      // The two daemons must have distinct ids and both must be online.
      expect(daemon1Id).toBeTruthy()
      expect(daemon2Id).toBeTruthy()
      expect(daemon1Id).not.toBe(daemon2Id)
      expect(machines.find((m) => m.id === daemon1Id)?.online).toBe(true)
      expect(machines.find((m) => m.id === daemon2Id)?.online).toBe(true)

      const machine2Name = machines.find((m) => m.id === daemon2Id)?.name ?? ''
      await srv.registry.modules.machines.changeAssignment(
        asMachineId(daemon2Id),
        { server: false, agentExecution: true },
        'routing-fixture',
      )

      // 3) Create a session explicitly targeting daemon2 (the "remote" paired machine)
      const { sessionId } = await srv.registry.modules.sessions.createSession({
        // This runtime injects a fixture launcher, not an installed agent CLI.
        // Shell requires only the live daemon and still proves socket routing.
        agentKind: 'shell',
        cwd: '/tmp',
        machineId: daemon2Id,
      })

      // 4) Wait for the session to go live: daemon2 received the spawn control message,
      //    executed the fixture, and sent a `bind` back — proving that the spawn was
      //    actually delivered to daemon2's socket, not daemon1's.
      await waitFor(async () => {
        const s = (await srv.registry.modules.sessions.listSessions()).find(
          (s) => s.sessionId === sessionId,
        )
        return s?.status === 'live'
      }, 10_000)

      // 5) Assert routing: the session is attributed to daemon2, NOT daemon1.
      //    The negative assertion (machineId !== daemon1Id) is the key proof —
      //    without it the test passes trivially if spawn lands on the wrong daemon.
      const meta = (await srv.registry.modules.sessions.listSessions()).find(
        (s) => s.sessionId === sessionId,
      )
      expect(meta).toBeDefined()
      expect(meta?.machineId).toBe(daemon2Id)
      expect(meta?.machineId).not.toBe(daemon1Id)
      expect(meta?.machineName).toBe(machine2Name)
    } finally {
      await daemon1.close({ reapSessions: true })
      await daemon2.close({ reapSessions: true })
      supervisor.close()
      await srv.close()
      rmSync(tmp1, { recursive: true, force: true })
      rmSync(tmp2, { recursive: true, force: true })
    }
  }, 25_000)
})
