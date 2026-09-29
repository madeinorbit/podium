/**
 * THE SIZE EVENT'S REPORT, AND THE TWO FRAMES THAT CARRY A SIZE
 * (POD-4723, design rev 3 of POD-3190).
 *
 * THE RULE. The kernel's winsize is the only truth, and the host is the only
 * thing that sets or reads it. The daemon's one memory of it is the `size`
 * field on the host connection, written only by the host's WELCOME and
 * RESIZED, which dies with the connection. There is no per-session record:
 *
 *   - A REPORT (`geometryApplied`) is sent only from the size event — one
 *     callback per session on WELCOME/RESIZED — through {@link reportSize}.
 *     The ask sends none: it moves nothing, so a refused or lost ask can never
 *     be reported as applied.
 *   - A BIND carries the connection's current size, read at the bind through
 *     {@link bindFrame}; absent when the session has no terminal or its backend
 *     cannot read its size back (abduco, a direct pty), which binds bare.
 *
 * WHAT THIS REPLACED. `AppliedGeometryRecord` recorded a size at every "apply
 * site" — seven of them — with a dispatch callback that answered `true`
 * before the host had answered. That is how the daemon reported 122x38 over
 * a pty the redraw nudge had put back at 80x24 (POD-4723). A size that comes
 * from the host cannot be wrong that way.
 *
 * FLUSH BEFORE THE REPORT (MODEL rule 5). Output the daemon is holding was
 * produced at the old grid; the report is a control frame that could overtake
 * it, so the size event flushes first — at the event, not at the ask, because
 * DATA that preceded RESIZED on the host socket belongs to the old grid.
 */

import { createLogger } from '@podium/logger'
import type { Geometry, SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'

const log = createLogger('daemon:geometry')

/** The `bind` frame, as the daemon sends it. */
export type BindFrame = Extract<DaemonMessage, { type: 'bind' }>
/** Everything a bind states EXCEPT the grid — which the connection states. */
export type BindFacts = Omit<BindFrame, 'type' | 'geometry'>
type GeometryAppliedFrame = Extract<DaemonMessage, { type: 'geometryApplied' }>

/** What a report needs from the daemon around it. Structural, so this module
 *  has no import cycle with `context.ts`. */
export interface SizeReportPorts {
  /** Send a frame to the server. */
  send(msg: DaemonMessage): void
  /** The daemon's output scheduler; optional because fixtures build partial
   *  contexts. */
  outputScheduler?: { flushNow?(sessionId: SessionId): void }
}

/**
 * FLUSH, THEN REPORT the size the host just stated for this session. Called
 * from the size event only. `birth` marks a Terminal's first size.
 */
export function reportSize(
  ports: SizeReportPorts,
  sessionId: SessionId,
  size: Geometry,
  birth = false,
): void {
  ports.outputScheduler?.flushNow?.(sessionId)
  ports.send(geometryAppliedFrame(sessionId, size, birth))
  log.debug('reported', { sessionId, cols: size.cols, rows: size.rows, birth })
}

/**
 * THE ONLY WRITER OF `BindMessage.geometry` (MODEL rule 1).
 *
 * Takes the connection's size — `Terminal.size()` at the bind — so a bind
 * states exactly what the host last said and nothing else. `undefined` binds
 * bare: "attached; I cannot state a size".
 *
 * The required fields are written out rather than spread so the frame keeps the
 * schema's field order, with `geometry` where `BindMessage` declares it.
 */
export function bindFrame(size: Geometry | undefined, facts: BindFacts): BindFrame {
  const { sessionId, cmd, cwd, agentKind, ...rest } = facts
  return {
    type: 'bind',
    sessionId,
    cmd,
    cwd,
    agentKind,
    ...(size ? { geometry: { cols: size.cols, rows: size.rows } } : {}),
    ...rest,
  }
}

/**
 * THE ONLY WRITER OF `geometryApplied` (MODEL rule 5).
 *
 * The one production caller is {@link reportSize}, which only the size event
 * calls — so the frame only ever carries a size the host stated.
 *
 * ONE CAUSE ON THE WIRE, ON PURPOSE, AND NOT BECAUSE THERE IS ONLY ONE KIND OF
 * APPLY (POD-3809). A birth is not a request. But `cause` is `z.enum(['request'])`
 * in a schema that daemon and server compile separately, and an older server
 * DROPS a frame it cannot parse (`daemon-socket.ts`, `warnDroppedFrame`, itself
 * throttled) — so a newer daemon shipping a new cause value would be answered
 * with exactly the silence this issue is about, and without a log line to say
 * so. The schema is widened first (it now tolerates an unknown cause); the true
 * value may be sent once servers carrying that tolerance are everywhere. See
 * `GeometryAppliedMessage.cause` for the whole of it.
 */
export function geometryAppliedFrame(
  sessionId: SessionId,
  size: Geometry,
  birth = false,
): GeometryAppliedFrame {
  return {
    type: 'geometryApplied',
    sessionId,
    geometry: { cols: size.cols, rows: size.rows },
    cause: 'request',
    // A Terminal's first size (POD-4771): the server treats it like a bind.
    ...(birth ? { birth: true } : {}),
  }
}
