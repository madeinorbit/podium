import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { type DaemonOptions, startDaemon } from '../../apps/daemon/src/daemon'
import { LOCAL_MACHINE_ID } from '../../apps/server/src/local-machine'
import { startServer } from '../../apps/server/src/server'
import { applyHarnessEnv, reapHarnessSessions } from './harness-env'

// Without this isolation the test server writes session rows into the REAL
// ~/.podium/podium.db and the daemon parks a REAL durable abduco master that
// outlives the test run. Must run before startServer()/startDaemon() read env.
const ISOLATION_PORT = 9922
reapHarnessSessions(ISOLATION_PORT)
applyHarnessEnv(ISOLATION_PORT)
afterAll(() => reapHarnessSessions(ISOLATION_PORT))

const FIXTURE = fileURLToPath(
  new URL('../../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)

async function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
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
      bootstrapToken: srv.bootstrapToken,
      machineId: LOCAL_MACHINE_ID,
      identityDir: tmp1,
      launch: fixtureLaunch,
      backend: 'none',
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
    const pairCode = srv.registry.modules.machines.mintPairingCode()

    // daemon2: the "remote" machine that pairs with the code
    const daemon2 = await startDaemon({
      serverUrl,
      pairCode,
      identityDir: tmp2,
      launch: fixtureLaunch,
      backend: 'none',
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
      // 1) Both machines must appear online
      const machines = srv.registry.modules.machines
        .listMachines()
        .filter((machine) => machine.online)
      expect(machines).toHaveLength(2)
      expect(machines.every((m) => m.online)).toBe(true)

      // 2) Identify each machine. daemon1 is the LOCAL machine: it presents
      //    LOCAL_MACHINE_ID so it attaches to the machine the server adopts at startup.
      //    daemon2 paired, so its id is the UUID minted in its own identity file.
      const daemon1Id = LOCAL_MACHINE_ID
      const daemon2Id = JSON.parse(readFileSync(join(tmp2, 'daemon.json'), 'utf8'))
        .machineId as string

      // The two daemons must have distinct ids and both must be online.
      expect(daemon1Id).toBeTruthy()
      expect(daemon2Id).toBeTruthy()
      expect(daemon1Id).not.toBe(daemon2Id)
      expect(machines.find((m) => m.id === daemon1Id)?.online).toBe(true)
      expect(machines.find((m) => m.id === daemon2Id)?.online).toBe(true)

      const machine2Name = machines.find((m) => m.id === daemon2Id)?.name ?? ''

      // 3) Create a session explicitly targeting daemon2 (the "remote" paired machine)
      const { sessionId } = srv.registry.modules.sessions.createSession({
        // This runtime injects a fixture launcher, not an installed agent CLI.
        // Shell requires only the live daemon and still proves socket routing.
        agentKind: 'shell',
        cwd: '/tmp',
        machineId: daemon2Id,
      })

      // 4) Wait for the session to go live: daemon2 received the spawn control message,
      //    executed the fixture, and sent a `bind` back — proving that the spawn was
      //    actually delivered to daemon2's socket, not daemon1's.
      await waitFor(() => {
        const s = srv.registry.modules.sessions
          .listSessions()
          .find((s) => s.sessionId === sessionId)
        return s?.status === 'live'
      }, 10_000)

      // 5) Assert routing: the session is attributed to daemon2, NOT daemon1.
      //    The negative assertion (machineId !== daemon1Id) is the key proof —
      //    without it the test passes trivially if spawn lands on the wrong daemon.
      const meta = srv.registry.modules.sessions
        .listSessions()
        .find((s) => s.sessionId === sessionId)
      expect(meta).toBeDefined()
      expect(meta?.machineId).toBe(daemon2Id)
      expect(meta?.machineId).not.toBe(daemon1Id)
      expect(meta?.machineName).toBe(machine2Name)
    } finally {
      await daemon1.close({ reapSessions: true })
      await daemon2.close({ reapSessions: true })
      await srv.close()
      rmSync(tmp1, { recursive: true, force: true })
      rmSync(tmp2, { recursive: true, force: true })
    }
  }, 25_000)
})
