/**
 * Live agent daemon process (split deployment): owns ALL per-agent work — abduco/tmux
 * PTY attach, transcript tailing, agent-state observation, discovery scans, host metrics.
 * Connects to the coordinating server over ws://localhost:<port>/daemon and reconnects
 * with backoff, so it can start before the server is ready and survive a server restart
 * without dropping running agents (the abduco masters live in their own systemd scopes).
 *
 * node-pty is a native Node addon, so this must run under tsx on Node (not Bun):
 *   node_modules/.bin/tsx --conditions=@podium/source scripts/daemon.ts
 */
import { startDaemon } from '../apps/daemon/src/daemon'

const port = Number(process.env.PODIUM_PORT ?? 18787)
// Resolves on the first successful connect (or after a short grace if the server
// isn't up yet); the daemon keeps retrying in the background regardless.
const daemon = await startDaemon({ serverUrl: `ws://localhost:${port}` })
console.log(`podium daemon up: connected to ws://localhost:${port}/daemon`)

let shuttingDown = false
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  // Detaches attach clients only — durable masters survive in their systemd scopes.
  await daemon.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

// Stay alive until a signal arrives.
await new Promise(() => {})
