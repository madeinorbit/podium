/**
 * Coordinating server process (split deployment): the relay + HTTP/tRPC + client/daemon
 * WebSockets, and NOTHING else. All per-agent work — abduco/tmux attach, transcript
 * tailing, agent-state, discovery, host metrics — lives in the separate daemon process
 * (scripts/daemon.ts), which connects over ws://localhost:<port>/daemon. Keeping that
 * work out of this process is the whole point: a reattach storm or a misbehaving agent
 * can never starve this coordinating loop, so /health and the UI stay responsive.
 *
 * This process does no PTY work. Run under Node (tsx) today, or under Bun:
 *   node_modules/.bin/tsx --conditions=@podium/source scripts/server.ts
 *   bun --conditions=@podium/source scripts/server.ts
 * Persistence resolves to node:sqlite/bun:sqlite per runtime (@podium/runtime/sqlite).
 */

import { installProcessSafetyNet } from '@podium/runtime/process-safety'
import { startWatchdog } from '@podium/runtime/sd-notify'
import { startServer } from '../apps/server/src/server'

// Crash net BEFORE anything else: an un-caught rejection (a dead socket's send, a
// failing handler) must not drop every client and the daemon link (audit P0-1).
installProcessSafetyNet('server')

// The relay only binds the port and loads persisted sessions from SQLite (fast,
// bounded) — it never reattaches/spawns, so there's no boot-wedge to guard against.
const server = await startServer({ port: Number(process.env.PODIUM_PORT ?? 18787) })
console.log(
  `podium server up: relay on http://localhost:${server.port} (daemon connects separately)`,
)

// Systemd watchdog pet (audit P0-3): a wedged coordinating loop stops petting and
// systemd restarts us. No-op when not under a Type=notify unit (dev/tests).
const stopWatchdog = startWatchdog()

let shuttingDown = false
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  stopWatchdog?.()
  // Bound the close: Bun's node:http server.close() can wait on lingering keep-alive
  // sockets that Node drains promptly, which would stall SIGTERM (and force systemd to
  // SIGKILL). On Node the close resolves first, so this is a no-op there.
  await Promise.race([server.close(), new Promise((r) => setTimeout(r, 4000))])
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

// Stay alive until a signal arrives.
await new Promise(() => {})
