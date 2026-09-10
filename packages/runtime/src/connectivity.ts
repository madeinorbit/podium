// Machine⇄server connectivity status file (issue #19). A supervisor-owned install writes
// this from its machine plane; a legacy standalone daemon remains the compatibility writer.
// The CLI (`podium status`) is the reader, so "up" reflects an authenticated machine path,
// not merely a PID. It lives in the selected state root beside the machine identity.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { stateDir } from './config'
import { isAlive, type KillFn } from './run-registry'

/**
 * Exit code a daemon process uses when the server TERMINALLY rejected it (pairRejected /
 * helloRejected with no fallback). Distinct from crash exits so the systemd unit's
 * `RestartPreventExitStatus` can stop the crash-loop: restarting would just re-hammer the
 * server with the same rejected handshake. 78 = BSD EX_CONFIG ("configuration error").
 */
export const DAEMON_BLOCKED_EXIT_CODE = 78

export const ConnectivityStatus = z.object({
  /** connecting = opening the socket; awaiting-ack = hello sent but not acknowledged;
   *  connected = helloOk seen on the live socket; disconnected = retrying with backoff;
   *  unauthorized = transport reached the server but auth failed (never retried);
   *  blocked = another terminal protocol/configuration refusal. */
  state: z.enum([
    'connecting',
    'awaiting-ack',
    'connected',
    'disconnected',
    'unauthorized',
    'blocked',
  ]),
  /** The server URL this status describes. */
  serverUrl: z.string().optional(),
  /** ISO time of the last successful handshake (survives disconnects — "last seen"). */
  lastHelloOkAt: z.string().optional(),
  /** PID of the daemon process that wrote this observation. */
  processId: z.number().int().positive().optional(),
  /** Build carried by that daemon process. */
  appVersion: z.string().optional(),
  /** Pending update version this process confirmed after boot, when applicable. */
  convergedVersion: z.string().optional(),
  /** Last socket/handshake error, when disconnected. */
  lastError: z.string().optional(),
  /** Current reconnect backoff, when disconnected. */
  retryBackoffMs: z.number().optional(),
  /** Why the server refused us, when blocked (pairRejected/helloRejected reason). */
  blockedReason: z.string().optional(),
  /** Auth refusal detail safe to show to this machine's operator. */
  authorizationReason: z.string().optional(),
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
 * The record iff the process that wrote it is still running; else undefined.
 *
 * THE FILE IS SHARED AND UNFENCED (POD-3815). Every incarnation of this
 * machine's supervisor writes the same `connectivity.json`, and it carries no
 * notion of which one is current — so a parent refused as superseded
 * (POD-3752) leaves `disconnected` behind on its way out and that record goes
 * on describing a machine whose link is healthy. Observed live: `podium status`
 * said "disconnected (retrying every ~5s)" for ever after an update.
 *
 * `processId` is the fence a reader can apply without cooperation from the
 * writer, which is what makes it the safety net for the SIGKILL case the
 * writer-side cede (POD-3765) cannot reach.
 *
 * SUPPRESSION IS ONLY EVER ON PROOF. A record naming no `processId` — anything
 * written before this field existed — still reads as current: "we cannot tell
 * who wrote this" must not be rendered as "this is stale".
 *
 * Deliberately NOT folded into {@link readConnectivity}, which is also the
 * merge input for {@link writeConnectivity}: fencing there would make a
 * successor's first write drop the `lastHelloOkAt`/`serverUrl` history it
 * legitimately inherits. Same split as `readRecord`/`liveRecord`.
 */
export function readLiveConnectivity(
  dir = stateDir(),
  kill: KillFn = process.kill,
): ConnectivityStatus | undefined {
  const status = readConnectivity(dir)
  if (!status) return undefined
  if (status.processId !== undefined && !isAlive(status.processId, kill)) return undefined
  return status
}

/**
 * Merge-write the status: fields not in `patch` are carried over from the file (so a
 * disconnect keeps the last `lastHelloOkAt`), except transition-scoped fields — an update
 * REPLACES transition-scoped error fields rather than inheriting stale ones.
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
