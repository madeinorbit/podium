/**
 * "Is this session reconnecting?" — a CONDITION, not stored state (ADR 12 D1).
 *
 * A session reconnects when its agent is still meant to be running (`starting`
 * or `live`) but the link to its machine's daemon is down right now. That is a
 * reading of the present, so no session row stores it: each reader derives it
 * from the machine's live connection through this one rule.
 *
 * - Web and phone read the machine's condition from their LiveStore. Before the
 *   first reading it is UNKNOWN, and unknown never reads as reconnecting: an app
 *   started offline shows the machine state as unknown, not yesterday's answer.
 * - The server (CLI, MCP, the chat bridge) reads its own daemon connections,
 *   which it always knows.
 *
 * Structural input on purpose (model is the L0 root), so the server's session,
 * a wire row and a client model can all be passed straight in.
 */

/**
 * A machine's link as the reader knows it: `true` online, `false` known to be
 * offline, `undefined` not known (no reading yet, or no machine).
 */
export type MachineOnline = boolean | undefined

/** The statuses whose agent is meant to be running, and so can be reconnecting. */
const RUNNING = new Set(['starting', 'live'])

/** True when the session should be running and its machine is known to be offline. */
export function isSessionReconnecting(status: string, machineOnline: MachineOnline): boolean {
  return machineOnline === false && RUNNING.has(status)
}

/**
 * The status word a reader shows: `reconnecting` over a running session whose
 * machine is known offline, otherwise the stored status unchanged.
 */
export function shownSessionStatus<S extends string>(
  status: S,
  machineOnline: MachineOnline,
): S | 'reconnecting' {
  return isSessionReconnecting(status, machineOnline) ? 'reconnecting' : status
}
