// Daemon⇄server connectivity status file (issue #19). The daemon is the only writer; the
// CLI (`podium status`) is the reader — so "up" can reflect whether the daemon is actually
// TALKING to its server, not merely that a PID exists. Lives next to daemon.json (the paired
// identity) so isolated/test daemons never touch the real state dir.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { stateDir } from './config'

/**
 * Exit code a daemon process uses when the server TERMINALLY rejected it (pairRejected /
 * helloRejected with no fallback). Distinct from crash exits so the systemd unit's
 * `RestartPreventExitStatus` can stop the crash-loop: restarting would just re-hammer the
 * server with the same rejected handshake. 78 = BSD EX_CONFIG ("configuration error").
 */
export const DAEMON_BLOCKED_EXIT_CODE = 78

export const ConnectivityStatus = z.object({
  /** connected = helloOk seen on the live socket; disconnected = retrying with backoff;
   *  blocked = server rejected the handshake terminally — re-pairing is required. */
  state: z.enum(['connected', 'disconnected', 'blocked']),
  /** The server URL this status describes. */
  serverUrl: z.string().optional(),
  /** ISO time of the last successful handshake (survives disconnects — "last seen"). */
  lastHelloOkAt: z.string().optional(),
  /** Last socket/handshake error, when disconnected. */
  lastError: z.string().optional(),
  /** Current reconnect backoff, when disconnected. */
  retryBackoffMs: z.number().optional(),
  /** Why the server refused us, when blocked (pairRejected/helloRejected reason). */
  blockedReason: z.string().optional(),
  updatedAt: z.string(),
})
export type ConnectivityStatus = z.infer<typeof ConnectivityStatus>

/** <dir>/connectivity.json (defaults to the state dir). */
export function connectivityPath(dir = stateDir()): string {
  return join(dir, 'connectivity.json')
}

/** Read + validate; missing or corrupt → undefined (status just omits the line). */
export function readConnectivity(dir = stateDir()): ConnectivityStatus | undefined {
  const path = connectivityPath(dir)
  if (!existsSync(path)) return undefined
  try {
    return ConnectivityStatus.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

/**
 * Merge-write the status: fields not in `patch` are carried over from the file (so a
 * disconnect keeps the last `lastHelloOkAt`), except transition-scoped fields — an update
 * REPLACES lastError/retryBackoffMs/blockedReason rather than inheriting stale ones.
 */
export function writeConnectivity(
  patch: Omit<ConnectivityStatus, 'updatedAt'> & { updatedAt?: string },
  dir = stateDir(),
): ConnectivityStatus {
  const prev = readConnectivity(dir)
  const next = ConnectivityStatus.parse({
    ...(prev?.lastHelloOkAt ? { lastHelloOkAt: prev.lastHelloOkAt } : {}),
    ...(prev?.serverUrl ? { serverUrl: prev.serverUrl } : {}),
    ...patch,
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  })
  mkdirSync(dir, { recursive: true })
  writeFileSync(connectivityPath(dir), `${JSON.stringify(next, null, 2)}\n`)
  return next
}
