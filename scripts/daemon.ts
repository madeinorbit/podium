/**
 * Live agent daemon process (split deployment): owns ALL per-agent work — abduco/tmux
 * PTY attach, transcript tailing, agent-state observation, discovery scans, host metrics.
 * Connects to the coordinating server over ws://localhost:<port>/daemon and reconnects
 * with backoff, so it can start before the server is ready and survive a server restart
 * without dropping running agents (the abduco masters live in their own systemd scopes).
 *
 * Runs on Node (tsx) today:
 *   node_modules/.bin/tsx --conditions=@podium/source scripts/daemon.ts
 * It also boots under Bun:
 *   bun --conditions=@podium/source scripts/daemon.ts
 * The PTY backend is selected at runtime (@podium/agent-bridge): node-pty under Node,
 * Bun.Terminal under Bun — so the native addon is never loaded on Bun, and persistence
 * uses node:sqlite/bun:sqlite accordingly. (Default deployment is still Node.)
 */
import { startDaemon } from '../apps/daemon/src/daemon'
import { LOCAL_MACHINE_ID, readOrCreateDaemonSecret } from '../apps/server/src/local-machine'
import { installProcessSafetyNet } from './process-safety'
import { startWatchdog } from './sd-notify'

// Crash net BEFORE anything else: a single bad frame / un-caught rejection from one
// agent must not terminate the daemon and drop reporting for every session (audit P0-1).
installProcessSafetyNet('daemon')

const port = Number(process.env.PODIUM_PORT ?? 18787)

// Boot watchdog (audit P0-3): under host memory pressure startup can wedge mid-init —
// the process stays alive but never finishes booting, and Restart=always (exit-only)
// can't recover it. The original single-process host.ts had this guard; the split
// daemon.ts is where the real boot-wedge risk lives, so it needs it too. startDaemon
// resolves on first connect OR after its own ~10s grace, so 45s is generous headroom.
const BOOT_TIMEOUT_MS = Number(process.env.PODIUM_BOOT_TIMEOUT_MS ?? 45_000)
const bootWatchdog = setTimeout(() => {
  console.error(
    `[podium:daemon] boot did not complete within ${BOOT_TIMEOUT_MS}ms (host memory pressure?) — exiting for systemd to retry`,
  )
  process.exit(1)
}, BOOT_TIMEOUT_MS)

// Same-host trust: this bundled daemon authenticates as the LOCAL machine using the
// shared secret in the state dir (the server reads/creates the same file). Without it
// the split daemon has no credential, never registers a machine, and existing
// `machine_id='__local__'` sessions/repos are never adopted — they vanish on restart.
// Resolves on the first successful connect (or after a short grace if the server isn't
// up yet); the daemon keeps retrying in the background regardless.
const daemon = await startDaemon({
  serverUrl: `ws://localhost:${port}`,
  bootstrapToken: readOrCreateDaemonSecret(),
  machineId: LOCAL_MACHINE_ID, // attach to the machine the server adopted '__local__' rows onto
})
clearTimeout(bootWatchdog)
console.log(`podium daemon up: connected to ws://localhost:${port}/daemon`)

// Systemd watchdog pet (audit P0-3): with Type=notify + WatchdogSec on the unit, a
// wedged event loop stops petting and systemd restarts us — the only thing that
// catches a wedged-but-alive daemon (the documented big-paste msg-loop wedge).
// No-op when not running under a notify unit (dev/tests).
const stopWatchdog = startWatchdog()

let shuttingDown = false
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  stopWatchdog?.()
  // Detaches attach clients only — durable masters survive in their systemd scopes.
  // Bounded so a slow close (e.g. a lingering socket under Bun's node:http) can't stall
  // SIGTERM; on Node close resolves first, so this is a no-op there.
  await Promise.race([daemon.close(), new Promise((r) => setTimeout(r, 4000))])
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

// Stay alive until a signal arrives.
await new Promise(() => {})
