/** Record-owned live values: pushed while watched, never saved (POD-7090). */
import { z } from 'zod'
import { DaemonReadiness, MachinePresenceSource } from '../entities/machine'
import { Geometry } from '../fields/session'
import { PresenceIdentity } from '../identity/presence'

/** `machine.condition` — the server's view of the daemon connection. */
export const MachineConditionLive = z.object({
  online: z.boolean(),
  /**
   * When `online` last changed, as this server saw it. `null` when the server
   * has not seen the machine connect since it started: honest "offline, since
   * at least the server's start", never an invented time.
   */
  since: z.string().nullable(),
  // The rest of the connection's condition (POD-6644): facts about the live
  // link, so they are never record fields. Optional: absent until known.
  /** When the server last heard from the machine (ISO 8601). */
  lastSeenAt: z.string().optional(),
  /** Which compatibility-window path represents the machine now. */
  presenceSource: MachinePresenceSource.optional(),
  /** What the current boot is observed to run. */
  availability: z
    .object({
      epoch: z.string(),
      server: z.boolean(),
      daemon: z.boolean(),
      supervisor: z.boolean(),
    })
    .optional(),
  /** The daemon's recovery after attaching. */
  daemonReadiness: DaemonReadiness.optional(),
})
export type MachineConditionLive = z.infer<typeof MachineConditionLive>

/**
 * `session.terminalState` — who controls a session's terminal and at what size
 * (ADR 7 Amendment 2 D26, D27; built by POD-6764). A value: the facts the
 * `attached`, `controllerChanged`, `geometry` and `agentExit` frames carry for
 * an attached client, for anyone who holds the key.
 *
 * `geometry` is also a stored column of the session, so the snapshot of a
 * session no process holds the terminal of (its daemon is offline, the server
 * restarted, it stopped) is the stored size with no controller: a client can
 * show the cached terminal view at the right size.
 */
export const SessionTerminalStateLive = z.object({
  /** The WEBSOCKET CLIENT that holds control; null when nobody does. */
  controller: z.string().nullable(),
  /** Who that client is, when the server knows. */
  controllerIdentity: PresenceIdentity.nullable().optional(),
  geometry: Geometry,
  /** The process ended; absent while it runs or was never started. */
  exit: z.object({ code: z.number().int() }).optional(),
})
export type SessionTerminalStateLive = z.infer<typeof SessionTerminalStateLive>

/**
 * `session.condition` — what a running session is doing right now (POD-6764).
 * None of it would be right when read from a saved copy tomorrow, so none of it
 * is a record field (ADR 12 D1). A session nothing runs reads `busy: false`,
 * no gated requests and its stored last input time.
 */
export const SessionConditionLive = z.object({
  /** The session is writing to its terminal now. */
  busy: z.boolean(),
  /** Viewport requests not forwarded because their sender did not hold control (POD-3239 B6). */
  requestsGated: z.number().int().nonnegative(),
  /** The last human (controller) input, ISO 8601; absent when there was none. */
  lastInputAt: z.string().optional(),
  /** The harness's latest exact context-window use, when it reports one. */
  contextUsagePercent: z.number().finite().min(0).max(100).optional(),
})
export type SessionConditionLive = z.infer<typeof SessionConditionLive>
