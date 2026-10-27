/** Mobile presentation facts. Copy, clock formatting, colours and local
 * navigation feedback remain in the existing native components. */
import type { Aggregate } from './rollup'

/** Where a phone row opens: its issue, or a session-only draft's session. */
export interface MobileNavigation {
  readonly kind: 'issue' | 'session'
  readonly id: string
}

/** Exact branch-wide badge, including offer-only decision deduplication.
 * The attention cache already composes these counters over nested rows. */
export function mobileWaitingCount(aggregate: Aggregate, finished: boolean): number {
  const counts = aggregate.railWaiting
  return counts === undefined ? 0 : counts.decisions + (finished ? counts.finished : counts.open)
}
