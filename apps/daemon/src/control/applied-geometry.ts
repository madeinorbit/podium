/**
 * ONE OWNER OF THE APPLIED SIZE — AND ONE OPERATION THAT APPLIES IT
 * (POD-3290 stage 5, amended by POD-3809 stage 7, both of POD-3190).
 *
 * MODEL rev 4, rule 1 said: a daemon report carries a geometry only when the
 * daemon APPLIED one. Stage 5 built this module to make that half true by
 * construction — no site can state a size it did not come from.
 *
 * THAT WAS HALF A RULE. The other half is *and ALWAYS when it did*. Stage 5
 * left applying and reporting as two statements a site had to write in the
 * right order, and by stage 7 the daemon had seven apply sites and two report
 * calls. A type can forbid a fabricated size; it cannot compel a call, and
 * silence typechecks. The two that stayed silent are exactly the ones a headed
 * (server-family) driver session goes through — the held resize dispatched at
 * the native attach, and the birth of the client terminal itself — so the
 * server's W sat at the row default while the viewer rendered a small
 * top-left quadrant, and only a LATER ask reflowed it (POD-3809).
 *
 * So the two statements are now ONE, and the whole of it lives in
 * {@link AppliedGeometryRecord.apply}:
 *
 *   1. FLUSH the daemon-held output for this session. Those bytes were produced
 *      at the old grid and must land before the report (MODEL rule 5). The
 *      flush is inside the operation for the same reason the report is: the
 *      next person to add an apply site must not be able to forget it.
 *   2. DISPATCH the resize, through the callback the site brings — that is the
 *      only part which differs between a pty bridge, a harness client terminal
 *      and a terminal that was just BORN at the size. A dispatch that answers
 *      `false` applied nothing, so nothing is recorded and nothing is reported.
 *   3. RECORD it. This is the only expression in the repository that produces
 *      an {@link AppliedGeometry}: its brand is a `declare const` symbol that is
 *      never exported and never assigned, so no object literal anywhere else
 *      typechecks as one.
 *   4. REPORT it, synchronously, before the call returns.
 *
 * There is no other way to write the record, so there is no way to apply in
 * silence. The two counts cannot drift again because there is only one count.
 *
 * THE OTHER REPORT IS THE BIND. {@link bindFrame} is the ONLY writer of
 * `BindMessage.geometry` and {@link geometryAppliedFrame} the only writer of
 * `geometryApplied`; both read the record and neither takes a geometry, so
 * absence in the record is absence on the wire. A site whose apply is followed
 * by a bind therefore reports TWICE — once as it applies, once as it binds —
 * and that is the deliberate direction of the redundancy: two frames stating
 * the same true size cost the server one extra idempotent write, while one
 * missing frame is the bug this file exists to make unwritable.
 *
 * A bare bind is a real answer, not a gap: "attached; applied nothing; W is
 * unknown to me" (stage 3, POD-3279). Every session mode reaches it the same
 * way — by there being nothing in the record.
 *
 * PER DAEMON, NOT PER PROCESS. The record hangs off the `DaemonContext` because
 * what it holds is "what THIS daemon applied": a daemon that restarts and
 * reattaches a surviving abduco master applied nothing to it, and must bind
 * bare. A process-wide singleton would have carried the dead daemon's answers
 * across that boundary — which is the exact stale-belief bug stage 3 removed,
 * arriving by a different road.
 */

import { createLogger } from '@podium/logger'
import type { Geometry, SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'

const log = createLogger('daemon:geometry')

/** Never exported, never assigned: the brand exists only in the type system, so
 *  `apply()` is the sole expression in the repository that produces one. */
declare const appliedGeometryBrand: unique symbol

/**
 * A size THIS DAEMON PUT A SESSION AT. Structurally a {@link Geometry} — the
 * wire carries `{cols, rows}` and nothing more — but unforgeable in the type
 * system, which is what makes "only the apply sites can produce one" a compiler
 * rule rather than a review note.
 */
export type AppliedGeometry = Geometry & { readonly [appliedGeometryBrand]: true }

/** The `bind` frame, as the daemon sends it. */
export type BindFrame = Extract<DaemonMessage, { type: 'bind' }>
/** Everything a bind states EXCEPT the grid — which is the record's to state. */
export type BindFacts = Omit<BindFrame, 'type' | 'geometry'>
type GeometryAppliedFrame = Extract<DaemonMessage, { type: 'geometryApplied' }>

/**
 * PUT THE SESSION AT THIS SIZE, AND SAY WHETHER THAT WORKED.
 *
 * The one part of an apply that differs per site: `bridge.resize` for a pty
 * session, `clientTerminals.resize` for a harness client, and nothing at all
 * for a terminal that was created at the size in the first place (a spawn, or
 * the birth of a client terminal), where the dispatch has already happened and
 * the honest answer is `true`.
 *
 * `false` means the daemon could NOT put the session at the size — there is no
 * terminal to resize yet. The record stays as it was and no report goes out,
 * because nothing was applied.
 */
export type DispatchGeometry = (cols: number, rows: number) => boolean

/** What the record needs from the daemon around it to complete one apply. Kept
 *  structural so this module has no import cycle with `context.ts`. */
export interface AppliedGeometryPorts {
  /** Send a frame to the server. */
  send(msg: DaemonMessage): void
  /** Deliver whatever the output scheduler is holding for this session, now.
   *  Optional so a partially-built host (or a fixture) still applies; the
   *  ordering it buys is proven in `geometry-report.test.ts` against the real
   *  scheduler. */
  flush?(sessionId: SessionId): void
}

/**
 * The last size this daemon applied to each of its sessions.
 *
 * WRITTEN AT THE APPLY SITES AND NOWHERE ELSE — the places where a real
 * TIOCSWINSZ, a real client-terminal spawn, or a real held-resize dispatch has
 * just happened:
 *
 *   - the `resize` handler, on both arms: `bridge.resize` and a driver-owned
 *     session's `clientTerminals.resize`
 *   - `wireBridge`, for the size a bridge is stood up at and for a resize it was
 *     holding and dispatches at bind
 *   - the reattach that DOWNGRADED to an abduco without `-N` and announced a
 *     size after all (`AgentSession.appliedGeometry`)
 *   - the native-client reconcile, dispatching a resize held for a session that
 *     had no terminal when the viewer asked
 *   - `clientTerminals`, where the daemon opens a harness client at a size
 *
 * Every one of them goes through {@link apply}, which reports. An entry is
 * dropped when the thing that was at that size goes away, so "applied" can
 * never outlive its terminal.
 */
export class AppliedGeometryRecord {
  readonly #applied = new Map<SessionId, AppliedGeometry>()
  readonly #ports: AppliedGeometryPorts

  /** REQUIRED, not optional: a record with nowhere to report to is precisely
   *  the silent apply this class exists to make unwritable, so there is no way
   *  to construct one. */
  constructor(ports: AppliedGeometryPorts) {
    this.#ports = ports
  }

  /**
   * FLUSH, DISPATCH, RECORD, REPORT — the whole of an apply, in that order.
   *
   * Being the only expression that can produce the brand, this call also
   * AUTHORISES the size: calling it is what "the daemon put this session at
   * this grid" means, and the report that leaves before it returns is the same
   * fact stated on the wire.
   *
   * Returns the applied size — so a site can hand it straight on without a
   * second lookup — or `undefined` when `dispatch` answered `false` and there
   * was nothing to apply. Omitting `dispatch` says the session is ALREADY at
   * this size: a pty created at it, or a client terminal born at it.
   */
  apply(
    sessionId: SessionId,
    cols: number,
    rows: number,
    dispatch?: DispatchGeometry,
  ): AppliedGeometry | undefined {
    // BEFORE the dispatch, not merely before the report: bytes the daemon is
    // holding were produced at the OLD grid, and a resize that reached the pty
    // first could have new-grid output queued behind them.
    this.#ports.flush?.(sessionId)
    if (dispatch && !dispatch(cols, rows)) return undefined
    const geometry = { cols, rows } as AppliedGeometry
    this.#applied.set(sessionId, geometry)
    const frame = geometryAppliedFrame(this, sessionId)
    if (frame) this.#ports.send(frame)
    // The whole path used to be dark: two hours of the daemon journal with
    // constant sizing activity and not one geometry line (POD-3809). One line
    // per apply, under one namespace, is what makes it readable again.
    log.debug('applied', { sessionId, cols, rows, dispatched: dispatch !== undefined })
    return geometry
  }

  /** What this daemon last applied to this session, or nothing if it never has. */
  applied(sessionId: SessionId): AppliedGeometry | undefined {
    return this.#applied.get(sessionId)
  }

  /** The pty/client this size was applied to is gone; the daemon holds no
   *  applied size for the session any more. */
  forget(sessionId: SessionId): void {
    this.#applied.delete(sessionId)
  }
}

/** Just enough of a `DaemonContext` to carry the record and complete an apply —
 *  kept structural so this module has no import cycle with `context.ts`. */
export interface AppliedGeometryHost extends AppliedGeometryPorts {
  appliedGeometry?: AppliedGeometryRecord
  /** The daemon's real port for {@link AppliedGeometryPorts.flush}. Optional in
   *  the type because fixtures build partial contexts. */
  outputScheduler?: { flushNow?(sessionId: SessionId): void }
}

/**
 * This daemon's record, created on first use.
 *
 * LAZY rather than built in the context literal so that every daemon — and
 * every test that stands one up from a partial object — has exactly one,
 * without a construction site being able to forget it and silently get a
 * second. It is also the ONLY construction site, which is what stops a caller
 * from building a record wired to a `send` that goes nowhere.
 */
export function appliedGeometryFor(host: AppliedGeometryHost): AppliedGeometryRecord {
  const existing = host.appliedGeometry
  if (existing) return existing
  const created = new AppliedGeometryRecord({
    // Read through the host on every call rather than captured: a context is
    // assembled in pieces, and the record is created by whichever apply or bind
    // site runs first.
    send: (msg) => host.send(msg),
    flush: (sessionId) => host.outputScheduler?.flushNow?.(sessionId),
  })
  host.appliedGeometry = created
  return created
}

/**
 * THE ONLY WRITER OF `BindMessage.geometry` (MODEL rule 1).
 *
 * Takes the bind's facts and the record — never a geometry — so a caller has
 * no way to state a size, only to have one stated for it. `undefined` for the
 * record is the honest answer of a caller with no daemon behind it (a driver
 * host built without one): it binds bare, which is what "applied nothing" reads
 * as on the wire.
 *
 * The required fields are written out rather than spread so the frame keeps the
 * schema's field order, with `geometry` where `BindMessage` declares it.
 */
export function bindFrame(record: AppliedGeometryRecord | undefined, facts: BindFacts): BindFrame {
  const { sessionId, cmd, cwd, agentKind, ...rest } = facts
  const applied = record?.applied(sessionId)
  return {
    type: 'bind',
    sessionId,
    cmd,
    cwd,
    agentKind,
    ...(applied ? { geometry: applied } : {}),
    ...rest,
  }
}

/**
 * THE ONLY WRITER OF `geometryApplied` (MODEL rule 5).
 *
 * `undefined` when the record holds nothing for this session — there is no
 * applied grid, so there is no report to send. Exported for the tests that pin
 * that; the one production caller is {@link AppliedGeometryRecord.apply}, which
 * is the point: the frame is built where the size is written.
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
  record: AppliedGeometryRecord,
  sessionId: SessionId,
): GeometryAppliedFrame | undefined {
  const applied = record.applied(sessionId)
  if (!applied) return undefined
  return { type: 'geometryApplied', sessionId, geometry: applied, cause: 'request' }
}
