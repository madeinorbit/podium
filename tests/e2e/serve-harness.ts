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
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  agentLaunchCommand,
  ConversationDiscoveryCache,
  type LaunchOptions,
  type LaunchSpec,
} from '@podium/agent-bridge'
import type { AgentKind } from '@podium/protocol'
import { startDaemon } from '../../apps/daemon/src/daemon'
import { runIndexRefreshJob, runMemoryBreakdownJob } from '../../apps/daemon/src/discovery-jobs'
import type { WorkerJob } from '../../apps/daemon/src/discovery-worker'
import { DiscoveryWorkerClient, type WorkerLike } from '../../apps/daemon/src/worker-client'
import { LOCAL_MACHINE_ID } from '../../apps/server/src/local-machine'
import { startServer } from '../../apps/server/src/server'
import { writeCodexStartupFixture } from './codex-fixture'
import {
  applyHarnessEnv,
  applyRealAgentCodexEnv,
  harnessPidFile,
  reapHarnessSessions,
} from './harness-env'

/**
 * This harness runs under `node --import tsx`, where worker threads don't inherit the
 * TS loader — so the daemon's default `.ts` discovery worker can't resolve its own bare
 * imports ("Cannot find module ./discovery-jobs") and crash-loops, spamming the log.
 * Run discovery jobs INLINE on the main thread instead (it has the loader), mirroring
 * the worker's own message handler. The live daemon (Bun) still uses the real spawned
 * worker; this is harness-only.
 */
function inlineWorkerClient(): DiscoveryWorkerClient {
  return new DiscoveryWorkerClient({
    spawn: (): WorkerLike => {
      const handlers: Array<(m: unknown) => void> = []
      let cache: ConversationDiscoveryCache | undefined
      const indexCache = (cachePath?: string): ConversationDiscoveryCache => {
        if (!cache) cache = new ConversationDiscoveryCache(cachePath)
        return cache
      }
      return {
        postMessage(m: unknown) {
          const job = m as WorkerJob
          void (async () => {
            try {
              const value =
                job.kind === 'memoryBreakdown'
                  ? runMemoryBreakdownJob(job.input)
                  : await runIndexRefreshJob(job.input, indexCache(job.input.cachePath))
              for (const h of handlers) h({ id: job.id, ok: true, value })
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err)
              for (const h of handlers) h({ id: job.id, ok: false, error })
            }
          })()
        },
        on(ev, cb) {
          if (ev === 'message') handlers.push(cb)
        },
        terminate() {
          cache = undefined
        },
      }
    },
  })
}

const PORT = Number(process.env.PORT ?? 8799)
const KEYECHO_CLI = fileURLToPath(new URL('../keyecho/src/cli.tsx', import.meta.url))
const KEYECHO_PKG = fileURLToPath(new URL('../keyecho', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')

// Reap leftovers from a previous hard-killed run, then isolate this run's state +
// abduco/tmux sockets in a per-port dir (never touches the user's ~/.podium or
// real sessions). globalTeardown reaps the same dir after the suite.
reapHarnessSessions(PORT)
const { stateDir } = applyHarnessEnv(PORT)

// A scratch repo WITH a linked worktree, at a deterministic per-port path so specs
// can compute it (tmpdir()/zz-podium-e2e-repo-<PORT>; the zz- prefix keeps it
// sorted BEHIND the real repo, so specs that hover "the first worktree row"
// keep browsing this repo's tree). Scanning THIS repo (unlike
// REPO_ROOT, which is often itself a linked worktree and scans as a single entry)
// yields a main worktree + a sibling — the multi-worktree sidebar that the
// worktree-follow specs need a session to move between.
const SCRATCH_REPO = join(tmpdir(), `zz-podium-e2e-repo-${PORT}`)
const SCRATCH_FEAT = `${SCRATCH_REPO}-feat`
rmSync(SCRATCH_REPO, { recursive: true, force: true })
rmSync(SCRATCH_FEAT, { recursive: true, force: true })
mkdirSync(SCRATCH_REPO, { recursive: true })
const git = (args: string[], cwd: string): void => {
  execFileSync('git', ['-c', 'user.email=e2e@podium', '-c', 'user.name=e2e', ...args], { cwd })
}
git(['init', '-q', '-b', 'main'], SCRATCH_REPO)
writeFileSync(join(SCRATCH_REPO, 'README.md'), 'e2e scratch repo\n')
git(['add', '.'], SCRATCH_REPO)
git(['commit', '-q', '-m', 'init'], SCRATCH_REPO)
git(['worktree', 'add', '-q', SCRATCH_FEAT, '-b', 'e2e-feat'], SCRATCH_REPO)

writeFileSync(join(stateDir, 'repos.json'), JSON.stringify([REPO_ROOT, SCRATCH_REPO]))
// Pre-pick the deployment mode so the setup gate (SetupGate → /setup/config →
// needsSetup) doesn't block the workspace: the harness IS an all-in-one server.
// Without this every browser spec lands on the first-run SetupView.
writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ mode: 'all-in-one' }))

// shell -> real shell (wide output for reflow tests); everything else -> keyecho jig.
// PODIUM_E2E_REAL_AGENTS=1 launches the REAL claude/codex CLI instead (opt-in,
// uses your account/quota) for specs that need genuine agent behaviour (hooks,
// transcripts, paste handling). Default stays deterministic.
const REAL_AGENTS = process.env.PODIUM_E2E_REAL_AGENTS === '1'
// Real Codex must never see the developer's rollout history: otherwise the
// connect-time discovery snapshot publishes thousands of unrelated threads and
// repeatedly stalls this in-process harness. The private home copies only auth.
const realAgentCodexEnv = REAL_AGENTS ? applyRealAgentCodexEnv(PORT) : undefined
if (realAgentCodexEnv) {
  // Seed only non-secret startup state after its private home exists: every
  // harness worktree is trusted and personality onboarding is already resolved.
  writeCodexStartupFixture(realAgentCodexEnv.codexHomeDir, [REPO_ROOT, SCRATCH_REPO, SCRATCH_FEAT])
}

const launch = (kind: AgentKind, opts: LaunchOptions): LaunchSpec =>
  kind === 'shell' || REAL_AGENTS
    ? agentLaunchCommand(kind, opts)
    : {
        cmd: process.execPath,
        args: ['--import', 'tsx', KEYECHO_CLI, '--mode', 'both'],
        cwd: KEYECHO_PKG,
      }

let server = await startServer({ port: PORT })
const daemon = await startDaemon({
  serverUrl: `ws://localhost:${server.port}`,
  bootstrapToken: server.bootstrapToken,
  machineId: LOCAL_MACHINE_ID,
  launch,
  ...(realAgentCodexEnv ? { discovery: { homeDir: realAgentCodexEnv.discoveryHomeDir } } : {}),
  workerClient: inlineWorkerClient(),
})
console.log(
  `harness relay on ws://localhost:${server.port} (shell=real, else=keyecho); state=${stateDir}`,
)
// Test-only process control: a Playwright spec can restart ONLY the relay while
// leaving the daemon + durable PTY host alive, matching a production server restart.
// The serial file is the completion ack; the deliberate offline window gives the
// browser time to prove its xterm canvas stays untouched while disconnected.
const restartSerialFile = join(stateDir, 'restart-serial')
const pidFile = harnessPidFile(PORT)
let restartSerial = 0
let restartInFlight = false
let shuttingDown = false
writeFileSync(pidFile, String(process.pid))
writeFileSync(restartSerialFile, String(restartSerial))
const restartServer = async (): Promise<void> => {
  if (restartInFlight || shuttingDown) return
  restartInFlight = true
  try {
    await server.close()
    await new Promise((resolve) => setTimeout(resolve, 750))
    if (shuttingDown) return
    server = await startServer({ port: PORT })
    restartSerial += 1
    writeFileSync(restartSerialFile, String(restartSerial))
  } finally {
    restartInFlight = false
  }
}
process.on('SIGUSR1', () => void restartServer())

let shutdownPromise: Promise<void> | undefined
const shutdown = (): Promise<void> => {
  if (shutdownPromise) return shutdownPromise
  shuttingDown = true
  shutdownPromise = (async () => {
    // Full reap: harness sessions are throwaway — without this every e2e run leaks
    // durable abduco/tmux masters (durability is the feature; the harness opts out).
    await daemon.close({ reapSessions: true })
    await server.close()
    // globalTeardown treats removal as the acknowledgement that every writer above
    // is closed. On failure the marker stays until shutdownAndExit kills this process.
    rmSync(pidFile, { force: true })
  })()
  return shutdownPromise
}
const shutdownAndExit = (): void => {
  void shutdown().then(
    () => process.exit(0),
    (err) => {
      console.error('[podium:e2e] harness shutdown failed:', err)
      process.exit(1)
    },
  )
}
process.on('SIGINT', shutdownAndExit)
process.on('SIGTERM', shutdownAndExit)
await new Promise(() => {})
