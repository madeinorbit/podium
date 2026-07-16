/**
 * The scheduler's decision layer (#470) [spec:SP-17db] — a PURE function of
 * (now, automations, liveSessionIds). No clock, no store, no spawn: the service
 * feeds it a snapshot and applies whatever comes back, which is what makes the
 * missed/overlap/re-arm policy table-testable without a database or a PTY.
 */

import type { AutomationScheduleKind } from '@podium/protocol'
import { nextAfter, parseCron } from './cron'

/** How late a fire may be and still run. Past this, the occurrence is recorded as
 *  `missed` and skipped [spec:SP-17db]: an outage must not ambush the user with a
 *  04:00 job at 14:00, and — since every fire spawns an agent session — a naive
 *  backfill of a weekend outage would spawn dozens at once. One hour. */
export const GRACE_MS = 60 * 60 * 1000

/** The scheduler's view of one automation. Deliberately narrower than AutomationRow:
 *  the decision needs only the schedule, the arm state, and the previous run's
 *  session — everything else (prompt, agent, cwd) belongs to the spawn, not here. */
export interface Schedulable {
  id: string
  enabled: boolean
  scheduleKind: AutomationScheduleKind
  cron: string | null
  /** ISO; null = not armed. */
  nextRunAt: string | null
  /** Session of this automation's most recent `spawned` run; null = never spawned. */
  lastSessionId: string | null
}

/** What the tick decided for one automation. `nextRunAt` is the re-arm — always the
 *  first occurrence STRICTLY after `now`, in every branch, so an outage collapses
 *  any number of skipped occurrences into at most ONE late fire [spec:SP-17db]. */
export interface AutomationDecision {
  automationId: string
  /** 'spawn' is an intent; the service turns it into a `spawned` or `error` run. */
  kind: 'spawn' | 'missed' | 'skipped_overlap' | 'error'
  /** The occurrence this decision is about (the due time, not the wall clock). */
  firedAt: string
  /** ISO, or null when the cron can never fire again (or cannot be parsed). */
  nextRunAt: string | null
  detail?: string
}

/**
 * One tick's decisions. Every enabled, armed automation whose `next_run_at` has
 * come is resolved to exactly one decision:
 *
 * | condition                              | decision        |
 * |----------------------------------------|-----------------|
 * | more than GRACE_MS late                | missed          |
 * | previous run's session still live      | skipped_overlap |
 * | otherwise                              | spawn           |
 * | cron unparseable / never fires again   | error (disarmed)|
 *
 * Automations that are disabled, unarmed, or not yet due produce NO decision.
 */
export function decideTick(input: {
  now: Date
  automations: readonly Schedulable[]
  liveSessionIds: ReadonlySet<string>
}): AutomationDecision[] {
  const { now, automations, liveSessionIds } = input
  const decisions: AutomationDecision[] = []
  for (const a of automations) {
    if (!a.enabled || a.nextRunAt === null) continue
    const due = Date.parse(a.nextRunAt)
    if (!Number.isFinite(due)) {
      // A corrupt (hand-edited) next_run_at would otherwise be compared as NaN and
      // silently never fire. Disarm loudly instead of wedging quietly.
      decisions.push({
        automationId: a.id,
        kind: 'error',
        firedAt: now.toISOString(),
        nextRunAt: null,
        detail: `unparseable next_run_at: ${a.nextRunAt}`,
      })
      continue
    }
    if (due > now.getTime()) continue

    // The re-arm is computed BEFORE the outcome branch and is the same in all of
    // them — a skipped or missed fire must still move the automation forward, or
    // the next tick would re-decide the same overdue occurrence forever.
    let nextRunAt: string | null = null
    try {
      if (a.scheduleKind === 'cron') {
        if (!a.cron) throw new Error('cron schedule is missing its expression')
        nextRunAt = nextAfter(parseCron(a.cron), now)?.toISOString() ?? null
      }
    } catch (err) {
      decisions.push({
        automationId: a.id,
        kind: 'error',
        firedAt: new Date(due).toISOString(),
        nextRunAt: null,
        detail: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    const firedAt = new Date(due).toISOString()
    if (now.getTime() - due > GRACE_MS) {
      decisions.push({
        automationId: a.id,
        kind: 'missed',
        firedAt,
        nextRunAt,
        detail: `more than ${Math.round(GRACE_MS / 60_000)} minutes late — skipped, not backfilled`,
      })
      continue
    }
    if (a.lastSessionId !== null && liveSessionIds.has(a.lastSessionId)) {
      decisions.push({
        automationId: a.id,
        kind: 'skipped_overlap',
        firedAt,
        nextRunAt,
        detail: `previous run (session ${a.lastSessionId}) is still running`,
      })
      continue
    }
    decisions.push({ automationId: a.id, kind: 'spawn', firedAt, nextRunAt })
  }
  return decisions
}
