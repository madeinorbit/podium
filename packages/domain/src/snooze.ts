/**
 * Pure "snooze window" predicates, shared by session snoozing (SessionMeta's
 * `snoozedUntil`) and — via {@link isIssueDeferred}-style logic in issue-stage.ts
 * — issue deferral. Structural on purpose (no @podium/protocol import: domain is
 * a leaf package with zero deps) so it matches SessionMeta and hub-mirrored
 * shapes alike.
 */

/** The minimal row shape the snooze predicates read. */
export interface SnoozableFields {
  /** `undefined` = never snoozed; `null` = snoozed until the next message; an
   *  ISO string = snoozed until that instant. */
  snoozedUntil?: string | null
}

/** Is the row snoozed *right now*? */
export function isSnoozed(row: SnoozableFields, now: number): boolean {
  if (row.snoozedUntil === undefined) return false
  if (row.snoozedUntil === null) return true
  return now < Date.parse(row.snoozedUntil)
}

/** Did a *timed* snooze just lapse — its deadline has passed but it hasn't been
 *  cleared yet (no message sent since)? `null` (until-next-message) snoozes
 *  never expire by time, so they're never "returned" this way. */
export function returnedFromSnooze(row: SnoozableFields, now: number): boolean {
  return typeof row.snoozedUntil === 'string' && Date.parse(row.snoozedUntil) <= now
}

/** ISO deadline one hour from `now`. */
export function snoozeUntil1h(now: number): string {
  return new Date(now + 3_600_000).toISOString()
}

/** ISO deadline at the next 5:00am local strictly after `now`. */
export function snoozeUntilTomorrow5am(now: number): string {
  const d = new Date(now)
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 5, 0, 0, 0)
  if (target.getTime() <= now) target.setDate(target.getDate() + 1)
  return target.toISOString()
}
