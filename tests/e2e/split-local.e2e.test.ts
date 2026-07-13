import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { type DaemonOptions, startDaemon } from '../../apps/daemon/src/daemon'
import {
  LOCAL_MACHINE_ID,
  readOrCreateDaemonSecret,
  stateDir,
} from '../../apps/server/src/local-machine'
import { startServer } from '../../apps/server/src/server'
import { SessionStore } from '../../apps/server/src/store'
import { applyHarnessEnv, reapHarnessSessions } from './harness-env'

// Own isolated state dir / port (distinct from relay.e2e 9921, multi-machine 9922).
const ISOLATION_PORT = 9923
reapHarnessSessions(ISOLATION_PORT)
applyHarnessEnv(ISOLATION_PORT)
afterAll(() => reapHarnessSessions(ISOLATION_PORT))

const FIXTURE = fileURLToPath(
  new URL('../../packages/agent-bridge/test/fixtures/fixture-tui.mjs', import.meta.url),
)
const fixtureLaunch: NonNullable<DaemonOptions['launch']> = () => ({
  cmd: process.execPath,
  args: [FIXTURE],
  cwd: '/tmp',
})
async function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

// Reproduces the production split-deployment regression AND its structural fix.
// Regression: scripts/daemon.ts runs the daemon as a SEPARATE process with no access to
// the server's in-process bootstrap token, so it never authenticated → no machine
// registered → existing `machine_id='__local__'` rows (tagged by the v4 migration) were
// never adopted and vanished. Fix has two layers: (1) the server adopts those rows at
// STARTUP onto the stable local machine, independent of any daemon — so the data is
// safe even if the daemon never connects; (2) a shared on-disk secret lets the local
// daemon authenticate without pairing and attach to that same machine.
describe('e2e: split server/daemon local transition', () => {
  it('adopts pre-existing __local__ rows at server startup, before any daemon connects', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'podium-split-'))

    // An UPGRADED single-machine DB: a session + repo stranded at machine_id='__local__'.
    const seed = new SessionStore() // PODIUM_STATE_DIR/podium.db (harness-isolated)
    seed.sessions.upsertSession({
      id: 'leg-1',
      agentKind: 'claude-code',
      cwd: '/tmp',
      title: 'legacy',
      name: null,
      originKind: 'spawn',
      conversationId: null,
      resumeKind: 'claude-session',
      resumeValue: 'abc-123',
      status: 'hibernated',
      exitCode: null,
      durableLabel: 'podium-leg-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-01-01T00:00:00.000Z',
      archived: false,
      workState: null,
      machineId: '__local__',
    })
    seed.repos.addRepo('/tmp/legacy-repo', '__local__')
    seed.close()

    const srv = await startServer()
    const serverUrl = `ws://localhost:${srv.port}`

    try {
      // LAYER 1 — the disaster cannot recur: with NO daemon connected yet, the server has
      // already adopted the legacy rows onto the local machine. Even if the daemon never
      // authenticates, the sessions/repos are attributed and visible.
      const before = srv.registry.modules.sessions
        .listSessions()
        .find((s) => s.sessionId === 'leg-1')
      expect(before?.machineId).toBe(LOCAL_MACHINE_ID)
      expect(
        srv.registry.sessionStore.repos.listRepos(LOCAL_MACHINE_ID).map((r) => r.path),
      ).toContain('/tmp/legacy-repo')
      expect(srv.registry.sessionStore.repos.listRepos('__local__')).toHaveLength(0)
      // The local machine exists but is OFFLINE until its daemon attaches.
      expect(
        srv.registry.modules.machines.listMachines().find((m) => m.id === LOCAL_MACHINE_ID)?.online,
      ).toBe(false)

      // LAYER 2 — the split daemon (no in-process token; reads the shared secret file, and
      // presents the stable local id) authenticates and attaches to the SAME machine.
      const daemon = await startDaemon({
        serverUrl,
        bootstrapToken: readOrCreateDaemonSecret(stateDir()),
        machineId: LOCAL_MACHINE_ID,
        identityDir: tmp,
        launch: fixtureLaunch,
        backend: 'none',
        discovery: { background: false, cachePath: join(tmp, 'discovery.db'), homeDir: tmp },
        metrics: { background: false },
        hooks: { port: 0, settingsDir: join(tmp, 'hooks') },
      })
      try {
        // The local machine is now online (the daemon attached to it, not a second one).
        await waitFor(
          () =>
            srv.registry.modules.machines.listMachines().find((m) => m.id === LOCAL_MACHINE_ID)
              ?.online === true,
        )
        expect(srv.registry.modules.machines.listMachines()).toHaveLength(1)
        // The legacy session is still attributed to the local machine, not stranded.
        const after = srv.registry.modules.sessions
          .listSessions()
          .find((s) => s.sessionId === 'leg-1')
        expect(after?.machineId).toBe(LOCAL_MACHINE_ID)
        expect(after?.machineId).not.toBe('__local__')
      } finally {
        await daemon.close({ reapSessions: true })
      }
    } finally {
      await srv.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 25_000)
})
