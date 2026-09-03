/**
 * ONE OWNER OF THE APPLIED SIZE (POD-3290, stage 5 of POD-3190).
 *
 * MODEL rev 4, rule 1: a daemon report carries a geometry only when the daemon
 * APPLIED one. Before this module every reporting site decided that for itself,
 * and four of them decided wrong in the same way — a server-family `bind` that
 * announced `120x40` for a session with no terminal of any kind, a size nothing
 * had ever been put at. The server took it as a report and marked W `current`.
 *
 * So the answer is not "be careful at each site". It is that there is ONE place
 * that knows, and no site can state a size it did not come from:
 *
 *   - {@link AppliedGeometryRecord.apply} is the ONLY producer of an
 *     {@link AppliedGeometry}. Its brand is a `declare const` symbol that is
 *     never exported and never assigned at runtime, so no object literal
 *     anywhere else in the tree typechecks as one. Calling it is what "the
 *     daemon put this session at this size" MEANS.
 *   - {@link bindFrame} is the ONLY writer of `BindMessage.geometry`, and
 *     {@link geometryAppliedFrame} the only writer of `geometryApplied`. Both
 *     read the record and nothing else. A caller cannot pass a geometry in,
 *     because neither takes one.
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

import type { Geometry, SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'

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
 *   - `clientTerminals`, where the daemon opens a harness client at a size
 *
 * An entry is dropped when the thing that was at that size goes away, so
 * "applied" can never outlive its terminal.
 */
export class AppliedGeometryRecord {
  readonly #applied = new Map<SessionId, AppliedGeometry>()

  /**
   * Record — and, by being the only expression that can produce the brand,
   * AUTHORISE — a size this daemon has just put a session at.
   *
   * Returns the value so an apply site can hand it straight to a report without
   * a second lookup, and so the call reads as what it is: the apply IS the
   * report's warrant.
   */
  apply(sessionId: SessionId, cols: number, rows: number): AppliedGeometry {
    const geometry = { cols, rows } as AppliedGeometry
    this.#applied.set(sessionId, geometry)
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

/** Just enough of a `DaemonContext` to carry the record — kept structural so
 *  this module has no import cycle with `context.ts`. */
export interface AppliedGeometryHost {
  appliedGeometry?: AppliedGeometryRecord
}

/**
 * This daemon's record, created on first use.
 *
 * LAZY rather than built in the context literal so that every daemon — and
 * every test that stands one up from a partial object — has exactly one,
 * without a construction site being able to forget it and silently get a
 * second.
 */
export function appliedGeometryFor(host: AppliedGeometryHost): AppliedGeometryRecord {
  const existing = host.appliedGeometry
  if (existing) return existing
  const created = new AppliedGeometryRecord()
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
 * applied grid, so there is no report to send. Callers send what they get and
 * nothing when they get nothing.
 */
export function geometryAppliedFrame(
  record: AppliedGeometryRecord,
  sessionId: SessionId,
): GeometryAppliedFrame | undefined {
  const applied = record.applied(sessionId)
  if (!applied) return undefined
  return { type: 'geometryApplied', sessionId, geometry: applied, cause: 'request' }
}
