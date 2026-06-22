/**
 * Backend for the single-origin dev host: relay server + live agent daemon in one process.
 *
 * The Vite dev server (apps/web, on :55556) is the app origin and proxies /trpc, /health,
 * /client and /daemon here; `tailscale serve` fronts it with TLS on :55555. The daemon connects
 * to the server directly on localhost (not through
 * the proxy) and spawns the real `claude`/`codex` CLIs via @podium/agent-bridge.
 *
 * Run under `tsx` (a Node loader — node-pty is a native Node addon, so this must not run on Bun):
 *   node_modules/.bin/tsx watch scripts/host.ts
 * No starter session — sessions are created from the Live UI.
 */
import { startDaemon } from '../apps/daemon/src/daemon'
import { LOCAL_MACHINE_ID } from '../apps/server/src/local-machine'
import { startServer } from '../apps/server/src/server'

// Boot watchdog: under heavy host memory pressure (swap thrash) the startup can
// intermittently wedge mid-init — the process stays alive but never finishes
// booting, so the relay never serves and `Restart=always` (which only fires on
// exit) can't recover it. If boot hasn't completed in time, exit non-zero so
// systemd restarts us and retries — a fresh attempt usually lands in a freer
// memory window. Healthy boots finish in ~1-2s; 45s is generous headroom.
const BOOT_TIMEOUT_MS = Number(process.env.PODIUM_BOOT_TIMEOUT_MS ?? 45_000)
const bootWatchdog = setTimeout(() => {
  console.error(
    `[podium] boot did not complete within ${BOOT_TIMEOUT_MS}ms (host memory pressure?) — exiting for systemd to retry`,
  )
  process.exit(1)
}, BOOT_TIMEOUT_MS)

// Uncommon internal port; the Vite proxy in apps/web/vite.config.ts uses the same PODIUM_PORT.
const server = await startServer({ port: Number(process.env.PODIUM_PORT ?? 18787) })
const daemon = await startDaemon({
  serverUrl: `ws://localhost:${server.port}`,
  bootstrapToken: server.bootstrapToken,
  machineId: LOCAL_MACHINE_ID, // attach to the machine the server adopted '__local__' rows onto
})
clearTimeout(bootWatchdog)
console.log(`podium backend up: relay + daemon on ws://localhost:${server.port}`)

let shuttingDown = false
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  await daemon.close()
  await server.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

// Stay alive until a signal arrives.
await new Promise(() => {})
