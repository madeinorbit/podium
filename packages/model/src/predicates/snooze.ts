/**
 * Pure "snooze window" predicates for session snoozing (SessionMeta's
 * `snoozedUntil`), the sibling of issue-stage.ts's defer predicates over
 * `deferUntil`. Both families take an {@link Instant} `now` and convert the
 * stored field through clock.ts — one clock representation, adapters at the
 * edges (POD-299).
 *
 * Structural on purpose (no @podium/protocol import: model is the L0 zero-dep
 * root) so it matches SessionMeta and hub-mirrored shapes alike.
 *
 * NOTE for POD-1076: `snoozedUntil` is one of the fields that becomes per-user
 * state keyed `(userId, entityId)`. Because the clock representation is settled
 * here, that move is a re-KEY of the row these predicates read — not a change
 * to what they compute.
 */

import { type Instant, toInstant, toIso } from '../clock'

/** The minimal row shape the snooze predicates read. */
export interface SnoozableFields {
  /** `undefined` = never snoozed; `null` = snoozed until the next message; an
   *  ISO string = snoozed until that instant. */
  snoozedUntil?: string | null
}

/** Is the row snoozed *right now*? */
export function isSnoozed(row: SnoozableFields, now: Instant): boolean {
  if (row.snoozedUntil === undefined) return false
  if (row.snoozedUntil === null) return true
  const until = toInstant(row.snoozedUntil)
  return until !== null && now < until
}

/** Did a *timed* snooze just lapse — its deadline has passed but it hasn't been
 *  cleared yet (no message sent since)? `null` (until-next-message) snoozes
 *  never expire by time, so they're never "returned" this way. */
export function returnedFromSnooze(row: SnoozableFields, now: Instant): boolean {
  if (typeof row.snoozedUntil !== 'string') return false
  const until = toInstant(row.snoozedUntil)
  return until !== null && until <= now
}

/** Deadline one hour from `now`, in the wire's ISO spelling. */
export function snoozeUntil1h(now: Instant): string {
  return toIso(now + 3_600_000)
}

/** Deadline at the next 5:00am local strictly after `now`, in the wire's ISO
 *  spelling. Local on purpose: "tomorrow morning" is a wall-clock promise to
 *  the person reading the sidebar, not a UTC offset. */
export function snoozeUntilTomorrow5am(now: Instant): string {
  const d = new Date(now)
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 5, 0, 0, 0)
  if (target.getTime() <= now) target.setDate(target.getDate() + 1)
  return toIso(target.getTime())
}
