/**
 * Long-running relay for the browser e2e harness (tests/e2e/browser/*.browser.e2e.ts).
 * Like serve.ts, but:
 *   - registers THIS repo in an isolated state dir, so its main worktree shows in the
 *     sidebar (sessions surface under a worktree whose path === the session cwd);
 *   - launches a real shell for `shell` sessions (wide output → reflow tests) and the
 *     keyecho echo jig for claude/codex kinds (deterministic keyboard/mouse fidelity).
 *
 * Run: node --conditions=@podium/source --import tsx tests/e2e/serve-harness.ts
 *      (the @podium/source condition resolves workspace packages to TS source; no build)
 * Port: PORT (default 8799). Health: GET /health. The playwright.config webServer starts
 * this automatically; the specs connect via `?server=ws://localhost:8799`.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentLaunchCommand, type LaunchOptions, type LaunchSpec } from '@podium/agent-bridge'
import type { AgentKind } from '@podium/protocol'
import { startDaemon } from '../../apps/daemon/src/daemon'
import { LOCAL_MACHINE_ID } from '../../apps/server/src/local-machine'
import { startServer } from '../../apps/server/src/server'
import { applyHarnessEnv, reapHarnessSessions } from './harness-env'

const PORT = Number(process.env.PORT ?? 8799)
const KEYECHO_CLI = fileURLToPath(new URL('../keyecho/src/cli.tsx', import.meta.url))
const KEYECHO_PKG = fileURLToPath(new URL('../keyecho', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')

// Reap leftovers from a previous hard-killed run, then isolate this run's state +
// abduco/tmux sockets in a per-port dir (never touches the user's ~/.podium or
// real sessions). globalTeardown reaps the same dir after the suite.
reapHarnessSessions(PORT)
const { stateDir } = applyHarnessEnv(PORT)
writeFileSync(join(stateDir, 'repos.json'), JSON.stringify([REPO_ROOT]))

// shell -> real shell (wide output for reflow tests); everything else -> keyecho jig.
const launch = (kind: AgentKind, opts: LaunchOptions): LaunchSpec =>
  kind === 'shell'
    ? agentLaunchCommand(kind, opts)
    : {
        cmd: process.execPath,
        args: ['--import', 'tsx', KEYECHO_CLI, '--mode', 'both'],
        cwd: KEYECHO_PKG,
      }

const server = await startServer({ port: PORT })
const daemon = await startDaemon({
  serverUrl: `ws://localhost:${server.port}`,
  bootstrapToken: server.bootstrapToken,
  machineId: LOCAL_MACHINE_ID,
  launch,
})
console.log(
  `harness relay on ws://localhost:${server.port} (shell=real, else=keyecho); state=${stateDir}`,
)

const shutdown = async (): Promise<void> => {
  // Full reap: harness sessions are throwaway — without this every e2e run leaks
  // durable abduco/tmux masters (durability is the feature; the harness opts out).
  await daemon.close({ reapSessions: true })
  await server.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
await new Promise(() => {})
