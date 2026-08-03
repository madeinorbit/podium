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

/**
 * Answer a frame whose ENVELOPE is intelligible but whose PAYLOAD is not (POD-1464).
 *
 * A control frame naming an op this daemon's build does not know fails the strict parse,
 * and the throw escapes BEFORE any reply is sent — so the server waits out its 35s
 * timeout and the operator is told "agent relay timed out". Version skew then looks
 * exactly like a machine that is offline, which sends whoever is debugging to the
 * network when the real answer is "update the daemon on that host". Measured on
 * vmi3407763: a `bundleFetch` repo op against a 0.1.2-edge.1 daemon produced nothing but
 * a timeout, and the actual cause was only visible in that machine's journal.
 *
 * The envelope is parsed SEPARATELY from the payload precisely because it survives: the
 * requestId is already on the wire, so a reply is always possible and refusing to send
 * one is a choice. A timeout should mean the machine did not answer, and nothing else.
 *
 * Only `repoOpRequest` is answered here — that is the observed case, and the one whose
 * result frame (`ok` + `output`) can carry a refusal without inventing a shape. Adding a
 * request type is one arm; guessing at result shapes we have not seen is not worth the
 * risk of emitting a frame the server rejects.
 */
export function payloadRejectionReply(rawText: string, err: unknown): DaemonMessage | undefined {
  let envelope: { type?: unknown; requestId?: unknown; op?: unknown }
  try {
    envelope = JSON.parse(rawText) as { type?: unknown; requestId?: unknown; op?: unknown }
  } catch {
    // Not even JSON — there is no requestId to address a reply to.
    return undefined
  }
  const type = typeof envelope?.type === 'string' ? envelope.type : undefined
  const requestId = typeof envelope?.requestId === 'string' ? envelope.requestId : undefined
  if (!type || !requestId || type !== 'repoOpRequest') return undefined
  const version = process.env.PODIUM_APP_VERSION ?? 'dev'
  const op = typeof envelope?.op === 'string' ? envelope.op : undefined
  const output = op
    ? `repo operation '${op}' is not supported by this daemon (podium ${version}) — update the daemon on this machine`
    : `this daemon (podium ${version}) could not read the repo operation: ${
        err instanceof Error ? err.message : String(err)
      }`
  return { type: 'repoOpResult', requestId, ok: false, output }
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
      const text = raw.toString()
      let msg: ControlMessage
      try {
        msg = timeTask('controlParse', () => parseControlMessage(text))
      } catch (error) {
        finish('<invalid>')
        // ANSWER BEFORE DROPPING (POD-1464). The payload did not parse, but the envelope
        // carries the requestId, so somebody IS waiting — and letting them wait out a
        // 35s timeout makes a stale daemon indistinguishable from an unreachable one.
        const reply = payloadRejectionReply(text, error)
        if (reply) ctx.send(reply)
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
