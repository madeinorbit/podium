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
import { startServer } from '../apps/server/src/server'

// Uncommon internal port; the Vite proxy in apps/web/vite.config.ts uses the same PODIUM_PORT.
const server = await startServer({ port: Number(process.env.PODIUM_PORT ?? 18787) })
const daemon = await startDaemon({ serverUrl: `ws://localhost:${server.port}` })
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
