// Machine⇄server connectivity status file (issue #19). A supervisor-owned install writes
// this from its machine plane; a legacy standalone daemon remains the compatibility writer.
// The CLI (`podium status`) is the reader, so "up" reflects an authenticated machine path,
// not merely a PID. It lives in the selected state root beside the machine identity.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { stateDir } from './config'
import {
  defaultInstanceGuardIo,
  type InstanceGuardIo,
  selfIdentityTriple,
  writerLiveness,
} from './instance-guard'
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
  /**
   * The two companions that pin `processId` to ONE incarnation (POD-3837).
   * Written only when the writer is stamping its own pid, because neither can
   * be observed for another process without guessing.
   *
   * `bootId` is `/proc/sys/kernel/random/boot_id` as the writer saw it, and it
   * is what makes this record survivable across a reboot: after one, every pid
   * in every stale record is being reused by something unrelated.
   * `procStartTime` is `/proc/<pid>/stat` field 22, which catches the same
   * thing within one boot when a pid is recycled.
   *
   * Both are Linux `/proc` facts and both are optional: absent means "the host
   * could not tell us", which is NOT "they disagreed" — see
   * {@link readLiveConnectivity}.
   */
  bootId: z.string().optional(),
  procStartTime: z.string().optional(),
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

/**
 * Read + validate; missing or corrupt → undefined (status just omits the line).
 *
 * UNFENCED: the record may name a process that is long gone (POD-3815), so this
 * does NOT answer "is this machine's link up" — {@link readLiveConnectivity} does.
 *
 * MODULE-PRIVATE ON PURPOSE (POD-3838). Its one legitimate caller is
 * {@link writeConnectivity}, which merges over it. While it was exported beside the
 * fenced reader, the shorter name won and shipped a permanently-stale `podium status`
 * (POD-3826); un-exporting it turns that silent wrong pick into a compile error. Tests
 * asserting what was WRITTEN reach it through {@link readConnectivityForTest}.
 */
function readConnectivity(dir = stateDir()): ConnectivityStatus | undefined {
  const path = connectivityPath(dir)
  if (!existsSync(path)) return undefined
  try {
    return ConnectivityStatus.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

/**
 * The raw, UNFENCED record — for tests that assert what {@link writeConnectivity} put on
 * disk, which is a question the fence would answer wrongly. Production code wants
 * {@link readLiveConnectivity}; see {@link readConnectivity} for why the raw reader is not
 * exported under its own name.
 */
export const readConnectivityForTest = readConnectivity

/**
 * What the fence decided, and on what evidence.
 *
 * The flag is not decoration. A verdict from the bare pid is a GUESS with a
 * known failure mode, and a caller that renders it as fact — or acts on it once
 * and then trusts the result, as `podium setup --join` does — needs to be able
 * to see which one it got. Same reason `instance-guard`'s handle carries
 * `identityVerified` rather than quietly degrading.
 */
export interface LiveConnectivity {
  status: ConnectivityStatus
  /** True only when pid, boot id AND start time could all be compared. */
  identityVerified: boolean
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
 * THE WRITER'S PID IS NOT THE WRITER (POD-3837). `report()` rewrites this file
 * on every state transition, so "the writer is alive" really does imply "the
 * record is current" — WITHIN one boot. Across a reboot the implication breaks
 * completely, because every recorded pid is then in use by something unrelated
 * and a bare `kill(pid, 0)` reads all of them as live; a pid recycle does the
 * same thing to one record at a time. So the fence compares the identity triple
 * `instance-guard.ts` argues for, not just the name: a record is suppressed
 * when its boot id or its process start time has moved on.
 *
 * The triple is the fence a reader can apply without cooperation from the
 * writer BEYOND the stamp, which is what makes it the safety net for the
 * SIGKILL case the writer-side cede (POD-3765) cannot reach.
 *
 * SUPPRESSION IS ONLY EVER ON PROOF. A record naming no `processId` — anything
 * written before this field existed — still reads as current, and so does one
 * naming no boot id, or one read on a host with no `/proc`: "we cannot tell"
 * must not be rendered as "this is stale". Those verdicts come back with
 * `identityVerified: false` rather than pretending to a precision they do not
 * have.
 *
 * Deliberately NOT folded into {@link readConnectivity}, which is also the
 * merge input for {@link writeConnectivity}: fencing there would make a
 * successor's first write drop the `lastHelloOkAt`/`serverUrl` history it
 * legitimately inherits. Same split as `readRecord`/`liveRecord`.
 */
export function readLiveConnectivity(
  dir = stateDir(),
  kill: KillFn = process.kill,
  io: Partial<InstanceGuardIo> = {},
): LiveConnectivity | undefined {
  const status = readConnectivity(dir)
  if (!status) return undefined
  if (status.processId === undefined) return { status, identityVerified: false }
  const verdict = writerLiveness(
    { pid: status.processId, bootId: status.bootId, startTime: status.procStartTime },
    { ...defaultInstanceGuardIo, pidAlive: (pid) => isAlive(pid, kill), ...io },
  )
  return verdict.live ? { status, identityVerified: verdict.identityVerified } : undefined
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
  // WRITER-SCOPED, like the transition-scoped error fields below: the triple
  // describes whoever is writing NOW, so it is stamped here rather than left to
  // eight call sites, and it is never inherited from `prev` — a successor that
  // adopted its predecessor's boot id would hand the reader a record that
  // agrees with itself for ever. Only a self-stamp is honest; the writer cannot
  // observe when SOMEONE ELSE's pid started without guessing.
  const identity = patch.processId === process.pid ? selfIdentityTriple() : undefined
  const next = ConnectivityStatus.parse({
    ...(prev?.lastHelloOkAt ? { lastHelloOkAt: prev.lastHelloOkAt } : {}),
    ...(prev?.serverUrl ? { serverUrl: prev.serverUrl } : {}),
    ...patch,
    ...(identity?.bootId ? { bootId: identity.bootId } : {}),
    ...(identity?.startTime ? { procStartTime: identity.startTime } : {}),
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  })
  mkdirSync(dir, { recursive: true })
  writeFileSync(connectivityPath(dir), `${JSON.stringify(next, null, 2)}\n`)
  return next
}
