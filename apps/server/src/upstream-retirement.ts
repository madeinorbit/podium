/**
 * THE OPERATOR-VISIBLE HALF OF THE UPSTREAM RETIREMENT (POD-309, ADR 5 D8).
 *
 * `UpstreamForwarder` durably queued issue mutations into `upstream_outbox` whenever a
 * NODE could not reach its hub, and drained them on reconnect. POD-309 deletes the
 * forwarder because federation is deferred ([spec:SP-0371]). Anything still queued when
 * this build lands therefore has no drainer, ever — which is exactly the case ADR 5 D8
 * legislates: *"Schema may be archived with operator-visible reporting of pending rows;
 * silent discard of poison/pending work is forbidden."*
 *
 * ---------------------------------------------------------------------------
 * WHY THIS PARKS THE ROWS RATHER THAN MIGRATING THEM
 * ---------------------------------------------------------------------------
 *
 * The obvious reading of "one-shot migration parks the pending rows" is a drizzle
 * migration renaming `upstream_outbox` to an `_archived` name. It was rejected on a
 * mechanical fact rather than a preference: `drizzle-kit generate` resolves a rename
 * INTERACTIVELY, and this repo generates non-interactively ([spec:SP-4428],
 * `migrations/index.ts`), where the same schema edit emits DROP + CREATE. That
 * migration would destroy the precise rows this function exists to protect, and it
 * would do it silently, in one transaction, at boot.
 *
 * So the rows are parked WHERE THEY ALREADY ARE. The table keeps its name and its
 * contents; what changes is that nothing writes it (`SyncRepository`'s enqueue/delete/
 * bump methods are deleted — only {@link SyncRepository.listParkedUpstreamMutations}
 * survives) and that their existence is now REPORTED. "Archived" is a statement about
 * who may touch a table, not about what it is called.
 *
 * ---------------------------------------------------------------------------
 * WHAT "REPORTED" MEANS, AND WHY IT IS TWO CHANNELS
 * ---------------------------------------------------------------------------
 *
 * A `console.warn` alone is a log line in a systemd journal that rotates. A durable
 * event alone is invisible to an operator running `podium` in a terminal. Pending work
 * that nothing will ever drain deserves both, so this emits:
 *
 *   1. a loud boot warning naming every parked mutation (id + proc + queue time), and
 *   2. one durable `upstream.retired_pending` podium event carrying the same list,
 *      which survives the log and is queryable after the fact.
 *
 * It reports on EVERY boot while rows remain, deliberately. A once-only flag would make
 * the notice miss precisely the operator who inherits the box later — and there is no
 * "acknowledge" surface to gate it on, because building one would be product work for a
 * feature that has been retired.
 */

import type { SyncRepository } from '@podium/sync'

/** The durable-event sink this needs — narrowed so a test supplies a function. */
export interface RetirementEventSink {
  appendEvent(e: {
    ts: string
    kind: string
    subject: string
    repoPath?: string | null
    payload?: unknown
  }): unknown
}

/** The parked-row reader half. Narrowed to the ONE surviving read. */
export type ParkedUpstreamSource = Pick<SyncRepository, 'listParkedUpstreamMutations'>

/**
 * Report anything still parked in the retired upstream outbox. Returns the number of
 * parked rows so a caller (and the test) can assert on the answer rather than on a log.
 *
 * Best-effort by construction: on a database that predates the table — or one where it
 * was dropped by hand — the read throws and this reports zero rather than refusing to
 * boot. A retirement notice must never be the reason a server will not start.
 */
export function reportParkedUpstreamMutations(
  sync: ParkedUpstreamSource,
  events: RetirementEventSink,
  now: () => number = Date.now,
): number {
  let parked: { mutationId: string; proc: string; queuedAt: number }[]
  try {
    parked = sync.listParkedUpstreamMutations()
  } catch {
    return 0
  }
  if (parked.length === 0) return 0
  const ts = new Date(now()).toISOString()
  console.warn(
    `[podium:upstream] ${parked.length} issue mutation(s) are PARKED in the retired ` +
      'node→hub outbox and will never be delivered — hub/node federation is deferred ' +
      '(POD-353) and the forwarder that drained this queue was removed in POD-309. ' +
      'They are preserved in the `upstream_outbox` table; re-apply anything you still ' +
      'need by hand, then delete the rows.',
  )
  for (const row of parked) {
    console.warn(
      `[podium:upstream]   ${row.mutationId} issues.${row.proc} ` +
        `(queued ${new Date(row.queuedAt).toISOString()})`,
    )
  }
  try {
    events.appendEvent({
      ts,
      kind: 'upstream.retired_pending',
      // The retirement is not about one issue, so the subject is the retired
      // SUBSYSTEM rather than an entity id (`subject` is non-nullable here).
      subject: 'upstream',
      repoPath: null,
      payload: {
        count: parked.length,
        mutations: parked.map((r) => ({
          mutationId: r.mutationId,
          proc: r.proc,
          queuedAt: new Date(r.queuedAt).toISOString(),
        })),
      },
    })
  } catch {
    // The warning above already went out; a failed durable append must not stop boot.
  }
  return parked.length
}
