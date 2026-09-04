/**
 * ASSEMBLING THE CAUSAL ENVELOPE FOR A TERMINAL SESSION (POD-1761 W3; spec §3
 * rule 4).
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE INVENTS A VALUE
 * ---------------------------------------------------------------------------
 *
 * The envelope's five fields already exist on the daemon, minted by the causal
 * observation protocol: the observer generation and binding version come from
 * the server-issued lease, the provider cursor from the transcript segment the
 * observer is reading, the turn epoch from the fenced transition history. This
 * module's whole job is to STAMP an event body with them and to refuse to stamp
 * one it cannot — because the failure mode the envelope exists to prevent is
 * exactly a plausible default.
 *
 * TWO RULES THE REST OF THE CODEBASE IS ALREADY STRICT ABOUT, restated as code:
 *
 *   1. `at` IS EVENT TIME. Not observe time. Stamping observation time is what
 *      makes a daemon restart re-date every session to "now", which the
 *      reattachment design calls out by name and which the home board renders as
 *      seventy sessions that all just became active.
 *   2. PROVENANCE IS A FACT, NOT A DELIVERY DETAIL. `bootstrap` events replay
 *      what was already true; a consumer must never apply live effects from one.
 *      The only two values a terminal driver produces are `bootstrap` (the single
 *      snapshot fold that opens a stream) and `live` (everything after the
 *      cursor). `replay` is not ours to mint.
 */

import type { ObservationProvenance, ProviderCursor } from '@podium/protocol'
import type { RuntimeEvent, RuntimeEventBody } from '../../events.js'

/**
 * The observation material a session's observers hold at the moment an event is
 * produced. Read fresh per event: an observer rebind changes the generation and
 * the cursor's segment underneath a long-lived stream, and a cached copy is how
 * a stale generation gets merged instead of rejected.
 */
export interface ObservationCheckpoint {
  cursor: ProviderCursor
  observerGeneration: number
  turnEpoch: number
}

/**
 * Stamp one event body.
 *
 * `at` MUST be supplied by the caller from the event's own source — a hook's
 * timestamp, a transcript record's, a process exit's. There is no fallback to
 * `Date.now()` on purpose: a missing event time is a bug in the producer, and a
 * default would hide it behind a number that looks right.
 */
export function stampRuntimeEvent(
  body: RuntimeEventBody,
  at: string,
  provenance: ObservationProvenance,
  checkpoint: ObservationCheckpoint,
): RuntimeEvent {
  return {
    ...body,
    at,
    provenance,
    cursor: checkpoint.cursor,
    observerGeneration: checkpoint.observerGeneration,
    turnEpoch: checkpoint.turnEpoch,
  }
}

/**
 * The cursor a terminal session reports when the causal observer has not bound a
 * provider segment yet.
 *
 * WHY THIS EXISTS AT ALL, given the "no plausible defaults" rule above: a
 * `ProviderCursor` is REQUIRED by the envelope, and a session absolutely does
 * produce events before its observer binds — a spawn error, a process exit
 * during startup, a recovery prompt asked while the handle is still starting.
 * The honest move is a cursor that is unambiguously not a transcript position
 * rather than a fabricated one: the segment is the driver's own process key, so
 * it can never collide with a provider segment id, and `seq` counts events
 * within it so ordering and fencing still work. A consumer comparing it against
 * a real provider cursor sees a different segment and refuses to merge — which
 * is the correct outcome, and the one a zero-filled provider cursor would have
 * silently gotten wrong.
 */
export function driverLocalCursor(processKey: string, seq: number): ProviderCursor {
  return { segmentId: `driver:${processKey}`, components: { seq } }
}

/** Is this cursor one of ours rather than a provider segment? Consumers and
 *  tests both need to ask, so the prefix is not a string literal at two sites. */
export const isDriverLocalCursor = (cursor: ProviderCursor): boolean =>
  cursor.segmentId.startsWith('driver:')

/** Ordering within one segment. Cross-segment comparison is deliberately absent:
 *  two different segments are incomparable, and a helper that returned a number
 *  anyway would be an invitation to merge them. */
export function cursorSeq(cursor: ProviderCursor): number {
  return Number(cursor.components.seq ?? 0)
}
