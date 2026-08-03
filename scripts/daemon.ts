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
 * The PTY backend is selected at runtime (@podium/harness): node-pty under Node,
 * Bun.Terminal under Bun — so the native addon is never loaded on Bun, and persistence
 * uses node:sqlite/bun:sqlite accordingly. (Default deployment is still Node.)
 *
 * Boot/shutdown semantics live in the shared kernel (@podium/runtime/boot): crash net
 * first, boot watchdog (the split daemon is where the real boot-wedge risk lives —
 * startDaemon resolves on first connect OR after its own ~10s grace, so the 45s default
 * is generous headroom), systemd watchdog pet (the daemon has no HTTP /health, so the
 * notify-unit watchdog is the only thing that catches a wedged-but-alive daemon), and a
 * bounded close (detaches attach clients only — durable masters survive in their own
 * systemd scopes).
 */

import { bootProcess } from '@podium/runtime/boot'
import { resolveLocalServerHost, resolvePort } from '@podium/runtime/config'
import { readOrCreateDaemonSecret, readOrCreateLocalMachineId } from '@podium/runtime/local-machine'
import { startDaemon } from '../apps/daemon/src/daemon'

const port = resolvePort()
// Must match what the server BOUND, not an assumption about it — a `PODIUM_HOST`
// pointing at one interface means loopback is not listening (POD-1585).
const host = resolveLocalServerHost()

await bootProcess({
  name: 'daemon',
  // Same-host trust: this bundled daemon authenticates as the LOCAL machine using the
  // shared secret in the state dir (the server reads/creates the same file). Without it
  // the split daemon has no credential, never registers a machine, and existing
  // `machine_id='__local__'` sessions/repos are never adopted — they vanish on restart.
  start: () =>
    startDaemon({
      serverUrl: `ws://${host}:${port}`,
      bootstrapToken: readOrCreateDaemonSecret(),
      // Same host, same state dir, same identity file the server read: this daemon
      // attaches AS this host rather than as a constant that stood for it.
      machineId: readOrCreateLocalMachineId(),
      installCodexHooks: true,
      installGrokHooks: true,
    }),
  // TELL THE TRUTH ABOUT THE LINK (POD-1585). `startDaemon` resolves on first
  // connect OR after its own ~10s grace, so reaching this line proves the daemon
  // BOOTED — never that it reached the server. The old message said "connected
  // to <url>" unconditionally, and when the server was in fact gone it read as
  // proof the daemon was attached: the machine it never registered showed
  // offline, and working server code was filed as a pre-merge blocker. Both
  // states are normal (the state machine retries with backoff), so name which
  // one this is.
  readyMessage: (daemon) =>
    daemon.connected
      ? `podium daemon up: connected to ws://${host}:${port}/daemon`
      : `podium daemon up: NOT yet connected to ws://${host}:${port}/daemon — retrying in the background (is the server running on ${host}:${port}?)`,
})
