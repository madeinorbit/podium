import type { ControlMessage, DaemonMessage } from '@podium/protocol'
import { encode, parseControlMessage } from '@podium/protocol'
import type { RawData, WebSocket } from 'ws'
import type { DaemonContext } from './control/context'
import { dispatchControlMessage } from './control/registry'
import { beginControlTurn, timeTask } from './loop-attribution'

/** A real control payload is far smaller; this bounds synchronous parse cost. */
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024 * 1024
const WARN_THROTTLE_MS = 1_000

export function controlFrameByteLength(raw: RawData): number {
  if (Buffer.isBuffer(raw)) return raw.length
  if (Array.isArray(raw)) return raw.reduce((total, chunk) => total + chunk.length, 0)
  return (raw as ArrayBuffer).byteLength
}

export interface FrameGuard {
  receive(raw: RawData): void
  send(socket: Pick<WebSocket, 'readyState' | 'send'> | undefined, msg: DaemonMessage): void
}

/**
 * The daemon's permanent application-frame boundary.
 *
 * Historical scar tissue: a durable reattach can produce one schema-invalid
 * frame while its attach client settles. That one malformed-frame-per-reattach
 * is BENIGN and must be dropped rather than closing the connection. We still
 * warn (throttled), because repeated malformed frames can mean protocol drift.
 */
export function createFrameGuard(
  ctx: DaemonContext,
  deps: {
    now?: () => number
    warn?: (...args: unknown[]) => void
  } = {},
): FrameGuard {
  const now = deps.now ?? Date.now
  const warn = deps.warn ?? console.warn
  let lastWarnAt = Number.NEGATIVE_INFINITY
  const warnDropped = (err: unknown, direction: 'inbound' | 'outbound'): void => {
    const at = now()
    if (at - lastWarnAt < WARN_THROTTLE_MS) return
    lastWarnAt = at
    warn(`[podium:daemon] dropped malformed ${direction} control frame:`, err)
  }

  return {
    receive(raw) {
      const finish = beginControlTurn()
      if (controlFrameByteLength(raw) > MAX_CONTROL_FRAME_BYTES) {
        finish('<oversized>')
        warn('[podium:daemon] dropping oversized control frame')
        return
      }
      let msg: ControlMessage
      try {
        msg = timeTask('controlParse', () => parseControlMessage(raw.toString()))
      } catch (error) {
        finish('<invalid>')
        warnDropped(error, 'inbound')
        return
      }
      try {
        timeTask(`controlDispatch(${msg.type})`, () => dispatchControlMessage(ctx, msg))
      } finally {
        finish(msg.type)
      }
    },
    send(socket, msg) {
      if (socket?.readyState !== 1) return
      try {
        socket.send(encode(msg))
      } catch (error) {
        warnDropped(error, 'outbound')
      }
    },
  }
}
