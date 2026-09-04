/**
 * `setDaemonLogLevel` — the daemon end of the operator's knob (POD-3156).
 *
 * A one-line family on purpose. The whole raise — the TTL, the seeding from the
 * flight recorder, the bounded queue, the way back — belongs to
 * `@podium/runtime/log-forward`, which is where a reader should go and which is
 * where the tests are. What lives here is only the routing fact: this control
 * frame reaches that handle.
 *
 * NO SELECTOR IS APPLIED HERE, and that is not an omission. The server decides
 * WHICH daemons a raise is for and sends the frame to those machines over their
 * own authenticated sockets; a frame that arrived has already been addressed at
 * this machine. A second match here would be a second answer to a question the
 * server has already answered, against a `machineId` this daemon would have to
 * take from the payload.
 */

import type { ControlHandlers } from './context'

export const logHandlers: Pick<ControlHandlers, 'setDaemonLogLevel'> = {
  setDaemonLogLevel: (ctx, msg) => {
    ctx.logForwarding.raise({
      level: msg.level,
      ...(msg.ttlMs !== undefined ? { ttlMs: msg.ttlMs } : {}),
    })
  },
}
