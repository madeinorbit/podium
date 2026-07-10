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
 *
 * Boot/shutdown semantics (crash net first, systemd watchdog pet, bounded close) live
 * in the shared kernel: @podium/runtime/boot. No boot timeout here: the relay only
 * binds the port and loads persisted sessions from SQLite (fast, bounded) — it never
 * reattaches/spawns, so there's no boot-wedge to guard against.
 */

import { bootProcess } from '@podium/runtime/boot'
import { resolvePort } from '@podium/runtime/config'
import { startServer } from '../apps/server/src/server'

await bootProcess({
  name: 'server',
  bootTimeoutMs: null,
  start: () => startServer({ port: resolvePort() }),
  readyMessage: (server) =>
    `podium server up: relay on http://localhost:${server.port} (daemon connects separately)`,
})
