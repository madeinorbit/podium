import type { MetadataChange } from '@podium/protocol'
import { Ledger, type LedgerDeps } from '@podium/sync'
import type { IssueDeps } from './types'

/**
 * TEST-ONLY funnel/ledger/publish plumbing for IssueDeps (issues #190, #255):
 * a minimal in-memory IssueFunnel (authorize → write for the write-only sites),
 * a REAL write-seam {@link Ledger} over an in-memory change-log store
 * (pass-through transact — atomicity with the SessionStore is covered by the
 * ledger suites, not here), plus the two issue PublishSpec builders WITHOUT the
 * upstream-mirror union. Production wiring lives in relay.ts (WriteFunnel +
 * Ledger + IssuePublisher).
 *
 * `broadcast` NO LONGER RECEIVES ANYTHING (POD-1203): the snapshot tail every
 * issue mutation used to call is deleted, so a caller wanting to observe what a
 * mutation published reads the ledger's appended rows — which is the same truth
 * a client is served from, and was not before.
 */
export function issueTestPlumbing(
  /**
   * Observe what a mutation PUBLISHED, one appended change row at a time.
   *
   * This used to be `(msg: ServerMessage) => void`, fed from the snapshot tail.
   * The rows are the honest replacement and a stronger observation point: a
   * snapshot could disagree with them, they are what every client is now served
   * from, and a caller asserting on a row is asserting on the value a user sees
   * rather than on the fact that a message went out.
   */
  onPublished: (change: MetadataChange) => void = () => {},
): Pick<IssueDeps, 'funnel' | 'ledger' | 'publishSpecs'> {
  const ledger = new Ledger({
    repo: memoryChangeLogStore(),
    now: Date.now,
    transact: (fn) => fn(),
  })
  ledger.onAppended((changes) => {
    for (const change of changes) onPublished(change)
  })
  return {
    funnel: {
      run: (op) => {
        op.authorize?.()
        return op.write()
      },
    },
    ledger,
    publishSpecs: {
      issueUpdated: (issue) => ({
        rows: [{ id: issue.id, value: issue }],
      }),
      issuesChanged: (issues) => ({
        rows: issues.map((i) => ({ id: i.id, value: i })),
      }),
    },
  }
}

/** In-memory ChangeLogStore (the shape LedgerDeps injects) — a plain array with
 *  an autoincrementing seq, enough for behavior tests that don't assert on
 *  durable SQL semantics. */
export function memoryChangeLogStore(): LedgerDeps['repo'] {
  type Row = {
    seq: number
    entity: string
    entityId: string
    op: 'upsert' | 'remove'
    payload: string | null
    eventTime: number
  }
  const rows: Row[] = []
  let nextSeq = 1
  return {
    appendChanges(batch, eventTime) {
      return batch.map((r) => {
        const seq = nextSeq++
        rows.push({ seq, ...r, eventTime })
        return seq
      })
    },
    maxChangeSeq: () => nextSeq - 1,
    minChangeSeq: () => rows[0]?.seq ?? null,
    changesSince: (cursor) => rows.filter((r) => r.seq > cursor),
    planChangePrune: () => ({ thresholdSeq: 0 }),
    pruneChangeBatch: () => 0,
    latestChangeStates: () => {
      const latest = new Map<string, Row>()
      for (const r of rows) latest.set(`${r.entity} ${r.entityId}`, r)
      return [...latest.values()]
    },
  }
}
