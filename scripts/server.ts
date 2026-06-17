/**
 * Coordinating server process (split deployment): the relay + HTTP/tRPC + client/daemon
 * WebSockets, and NOTHING else. All per-agent work — abduco/tmux attach, transcript
 * tailing, agent-state, discovery, host metrics — lives in the separate daemon process
 * (scripts/daemon.ts), which connects over ws://localhost:<port>/daemon. Keeping that
 * work out of this process is the whole point: a reattach storm or a misbehaving agent
 * can never starve this coordinating loop, so /health and the UI stay responsive.
 *
 * This process does no PTY work, but @podium/agent-bridge is a shared dep, so run under
 * tsx like the rest:
 *   node_modules/.bin/tsx --conditions=@podium/source scripts/server.ts
 */
import { startServer } from '../apps/server/src/server'

// The relay only binds the port and loads persisted sessions from SQLite (fast,
// bounded) — it never reattaches/spawns, so there's no boot-wedge to guard against.
const server = await startServer({ port: Number(process.env.PODIUM_PORT ?? 18787) })
console.log(
  `podium server up: relay on http://localhost:${server.port} (daemon connects separately)`,
)

let shuttingDown = false
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  await server.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

// Stay alive until a signal arrives.
await new Promise(() => {})
