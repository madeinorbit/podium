/** Principal-local failure counters. Retains no rows or errors; repeated
 * failures stay countable without flooding the console. */
export type FeedFailureKind =
  | `listener:${'update' | 'replace'}`
  | `cold-index:${'update' | 'replace'}`
  | 'header:quota'
  | 'header:history'
  | 'header:lifecycle'

export class FeedDiagnostics {
  errors = 0
  readonly counts: Partial<Record<FeedFailureKind, number>> = {}
  resyncPending = false
  replaceResyncs = 0

  report(kind: FeedFailureKind, error: unknown): void {
    this.errors += 1
    const count = (this.counts[kind] ?? 0) + 1
    this.counts[kind] = count
    if (count === 1) console.error(`[pool feed] ${kind} failed`, error)
  }
}
