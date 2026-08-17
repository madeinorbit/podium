import { createLogger } from '@podium/logger'
import type { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import { encodeDaemonMessage, parseControlMessage } from '@podium/protocol/daemon'
import type { RawData, WebSocket } from 'ws'
import type { DaemonContext } from './control/context'
import { dispatchControlMessage } from './control/registry'
import { beginControlTurn, timeTask } from './loop-attribution'

const log = createLogger('daemon:frames')

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
 * TWO request types are answered here, and the bar for adding a third is unchanged: the
 * request must have a RESULT frame whose shape already exists in this daemon's own
 * vocabulary, so refusing costs nothing and invents nothing. Guessing at a result shape
 * we have not seen is still not worth the risk of emitting a frame the server rejects.
 *
 *   - `repoOpRequest`  → `repoOpResult`      (POD-1464, the observed case)
 *   - `approvalExecRequest` → `approvalExecResult` (POD-2223)
 *
 * The approval arm exists because the approval broker's op catalog GROWS. `ApprovalOp` is
 * a closed union with closed enums inside it, so every value a newer server adds — a new
 * op kind, a new `channel` target — is a value an older daemon's schema rejects, and this
 * frame carries ONE op, so the codec's per-element quarantine has nothing to quarantine.
 * Dropped, the approval row sits `executing` on the server forever: it leaves the
 * operator's pending list the moment they approve it, the requesting agent is told to keep
 * waiting, and the only trace is one throttled warn in this host's journal.
 *
 * NOTE WHAT THIS ARM CAN AND CANNOT DO, because it is the whole reason the server also
 * carries a deadline (`ApprovalService.sweepStalledExecutions`). This code runs on the
 * daemon that CANNOT READ THE FRAME — which is, by construction, a daemon older than the
 * release that adds the value. So this arm is worth nothing to the widening that ships
 * alongside it and everything to the NEXT one: it is tolerance landed ahead of the value
 * that will need it, which is the whole of spec P8. The server's deadline is what covers
 * the fleet that is already out there.
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
  if (!type || !requestId) return undefined
  const version = process.env.PODIUM_APP_VERSION ?? 'dev'
  const because = err instanceof Error ? err.message : String(err)

  if (type === 'repoOpRequest') {
    const op = typeof envelope?.op === 'string' ? envelope.op : undefined
    const output = op
      ? `repo operation '${op}' is not supported by this daemon (podium ${version}) — update the daemon on this machine`
      : `this daemon (podium ${version}) could not read the repo operation: ${because}`
    return { type: 'repoOpResult', requestId, ok: false, output }
  }

  if (type === 'approvalExecRequest') {
    // `op` is an OBJECT here, and an unparseable one — read it defensively rather than
    // through the schema that just refused it, so the operator is told which operation
    // their approval was for even when this build has no arm for it at all.
    const op = describeUnreadableApprovalOp(envelope?.op)
    const output = op
      ? `approval operation ${op} is not supported by this daemon (podium ${version}) — update podium on this machine, then ask again`
      : `this daemon (podium ${version}) could not read the approved operation: ${because}`
    // `exitCode: null` is the honest value: nothing was spawned, so there is no exit code
    // to report. The server folds `ok: false` into a `failed` row with this text.
    return { type: 'approvalExecResult', requestId, ok: false, exitCode: null, output }
  }

  return undefined
}

/** The unparseable `op` object, rendered for a human: `'channel dev'`, `'update'`.
 *  Returns undefined when even the discriminant is unreadable. */
function describeUnreadableApprovalOp(op: unknown): string | undefined {
  if (typeof op !== 'object' || op === null) return undefined
  const bag = op as Record<string, unknown>
  const kind = typeof bag.kind === 'string' ? bag.kind : undefined
  if (!kind) return undefined
  const target = typeof bag.target === 'string' ? bag.target : undefined
  return target ? `'${kind} ${target}'` : `'${kind}'`
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
    warn?: (msg: string, fields?: Record<string, unknown>) => void
  } = {},
): FrameGuard {
  const now = deps.now ?? Date.now
  const warn = deps.warn ?? ((msg: string, fields?: Record<string, unknown>) => log.warn(msg, fields))
  let lastWarnAt = Number.NEGATIVE_INFINITY
  const warnDropped = (err: unknown, direction: 'inbound' | 'outbound'): void => {
    const at = now()
    if (at - lastWarnAt < WARN_THROTTLE_MS) return
    lastWarnAt = at
    warn('dropped a malformed control frame', { direction, err })
  }

  return {
    receive(raw) {
      const finish = beginControlTurn()
      if (controlFrameByteLength(raw) > MAX_CONTROL_FRAME_BYTES) {
        finish('<oversized>')
        warn('dropping an oversized control frame', {
          bytes: controlFrameByteLength(raw),
          maxBytes: MAX_CONTROL_FRAME_BYTES,
        })
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
        socket.send(encodeDaemonMessage(msg))
      } catch (error) {
        warnDropped(error, 'outbound')
      }
    },
  }
}
