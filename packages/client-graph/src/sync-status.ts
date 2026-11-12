import type { SyncProgressSnapshot } from '@podium/client-core/replica-assembly'

/**
 * THE UNIFIED SYNC STATUS (POD-6852).
 *
 * Five signals used to report one system from three places: the catch-up line
 * under the top bar, the connection glyph (twice), and three top-bar counters
 * ("pending", "didn't sync", "not delivered"). They are one fact for the user —
 * whether this window and the server agree — so they are read here as one.
 *
 * The status has two independent parts:
 *
 *   · the CONDITION — what sync is doing right now. Only the highest-ranked one
 *     is shown, and routine ones pass through hysteresis so a short catch-up
 *     never reaches the screen;
 *   · the REVIEW COUNT — things that will not go through until the user decides
 *     (refused changes and undelivered messages). It is never delayed.
 *
 * Everything here is a pure function of its inputs, so the desktop strip and
 * the phone header read the same answer and tests can drive time directly.
 */

/** Ranked: an earlier entry wins when several hold at once. */
export const SYNC_CONDITIONS = ['offline', 'paused', 'slow', 'catching-up', 'sending'] as const
export type SyncCondition = (typeof SYNC_CONDITIONS)[number]
/** What the strip shows: a condition, the short confirmation, or nothing. */
export type SyncDisplay = SyncCondition | 'up-to-date' | null

export type SyncReplicaSignal = Pick<
  SyncProgressSnapshot,
  'phase' | 'attempt' | 'blocking' | 'error' | 'committedSeq' | 'targetSeq' | 'healFromSeq'
>

export interface SyncSignals {
  readonly connection: 'ok' | 'degraded' | 'down'
  readonly replica: SyncReplicaSignal
  /** Changes saved on this device, waiting to send. */
  readonly queued: number
  /** Changes the server refused (outbox dead letters). */
  readonly refused: number
  /** Chat messages the server says did not arrive, or cannot vouch for. */
  readonly undelivered: number
}

const CATCHING_UP_PHASES: ReadonlySet<SyncReplicaSignal['phase']> = new Set([
  'connecting',
  'reconnecting',
  'updating',
  'downloading',
  'saving',
])

/**
 * A warm catch-up is running. The first sync is excluded: it owns the window
 * through the full-screen loader, and `attempt === 0` is a warm launch that has
 * not started walking yet (the old status line used the same test).
 */
export function isCatchingUp(replica: SyncReplicaSignal): boolean {
  return !replica.blocking && replica.attempt > 0 && CATCHING_UP_PHASES.has(replica.phase)
}

/** A warm catch-up stopped on a failure the user can retry. `auth` goes to sign-in instead. */
export function isPaused(replica: SyncReplicaSignal): boolean {
  return (
    !replica.blocking &&
    replica.phase === 'error' &&
    replica.error !== null &&
    replica.error !== 'auth'
  )
}

export function syncCondition(signals: SyncSignals): SyncCondition | null {
  if (signals.connection === 'down') return 'offline'
  if (isPaused(signals.replica)) return 'paused'
  if (signals.connection === 'degraded') return 'slow'
  if (isCatchingUp(signals.replica)) return 'catching-up'
  if (signals.queued > 0) return 'sending'
  return null
}

export function syncReviewCount(signals: Pick<SyncSignals, 'refused' | 'undelivered'>): number {
  return signals.refused + signals.undelivered
}

/**
 * Catch-up progress as a whole percent, or null when it is not measured. The
 * distance is in feed sequence numbers from where the catch-up started to the
 * target the server fixed for it; without a target there is no denominator and
 * the strip shows a spinner rather than an invented number.
 */
export function catchUpPercent(replica: SyncReplicaSignal): number | null {
  const { healFromSeq: from, committedSeq: at, targetSeq: to } = replica
  if (from === null || at === null || to === null || to <= from) return null
  return Math.max(0, Math.min(100, Math.floor(((at - from) / (to - from)) * 100)))
}

// ── Hysteresis ────────────────────────────────────────────────────────────

/** How long a condition must hold before it is shown. Failures show at once. */
export const SYNC_ENTER_DELAY_MS: Readonly<Record<SyncCondition, number>> = {
  offline: 1200,
  paused: 0,
  slow: 1200,
  'catching-up': 1500,
  sending: 1500,
}
/** Once shown, a condition stays at least this long, so it can be read and never blinks. */
export const SYNC_MIN_HOLD_MS = 600
/** "Up to date" closes the loop the user saw open, then leaves. */
export const SYNC_UP_TO_DATE_MS = 1600

export interface StableSync {
  readonly shown: SyncDisplay
  /** When `shown` last changed. */
  readonly shownAt: number
  /** Since when the raw condition has been continuously non-null. */
  readonly activeSince: number | null
}

export const HIDDEN_SYNC: StableSync = { shown: null, shownAt: 0, activeSince: null }

/**
 * One step of the display state machine. Returns the next state and the moment
 * it must be stepped again (a deadline), or null when nothing is due — the
 * caller keeps at most one timer, for that deadline.
 */
export function stepStableSync(
  state: StableSync,
  raw: SyncCondition | null,
  now: number,
): { state: StableSync; nextAt: number | null } {
  const activeSince = raw === null ? null : (state.activeSince ?? now)
  const { shown, shownAt } = state
  const showing = shown !== null && shown !== 'up-to-date'

  if (raw !== null) {
    if (shown === raw) return { state: { shown, shownAt, activeSince }, nextAt: null }
    if (showing) {
      // One condition gives way to another: no new wait, since something is
      // already on screen, but the old one still gets its minimum hold.
      const heldUntil = shownAt + SYNC_MIN_HOLD_MS
      if (now >= heldUntil)
        return { state: { shown: raw, shownAt: now, activeSince }, nextAt: null }
      return { state: { shown, shownAt, activeSince }, nextAt: heldUntil }
    }
    const due = (activeSince ?? now) + SYNC_ENTER_DELAY_MS[raw]
    if (now >= due) return { state: { shown: raw, shownAt: now, activeSince }, nextAt: null }
    // Still waiting; a confirmation on screen meanwhile runs out on its own clock.
    if (shown === 'up-to-date') {
      const doneAt = shownAt + SYNC_UP_TO_DATE_MS
      if (now >= doneAt) return { state: { shown: null, shownAt: now, activeSince }, nextAt: due }
      return { state: { shown, shownAt, activeSince }, nextAt: Math.min(due, doneAt) }
    }
    return { state: { shown, shownAt, activeSince }, nextAt: due }
  }

  if (shown === null) return { state: { shown, shownAt, activeSince }, nextAt: null }
  if (shown === 'up-to-date') {
    const doneAt = shownAt + SYNC_UP_TO_DATE_MS
    if (now >= doneAt) return { state: { shown: null, shownAt: now, activeSince }, nextAt: null }
    return { state: { shown, shownAt, activeSince }, nextAt: doneAt }
  }
  const heldUntil = shownAt + SYNC_MIN_HOLD_MS
  if (now < heldUntil) return { state: { shown, shownAt, activeSince }, nextAt: heldUntil }
  // A slow link that recovers has nothing to confirm; everything else was work
  // the user watched, so it ends on "Up to date".
  if (shown === 'slow') return { state: { shown: null, shownAt: now, activeSince }, nextAt: null }
  return {
    state: { shown: 'up-to-date', shownAt: now, activeSince },
    nextAt: now + SYNC_UP_TO_DATE_MS,
  }
}
