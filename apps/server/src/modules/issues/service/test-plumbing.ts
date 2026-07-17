import type { ServerMessage } from '@podium/protocol'
import { Ledger, type LedgerDeps } from '@podium/sync'
import type { IssueDeps } from './types'

/**
 * TEST-ONLY funnel/ledger/publish plumbing for IssueDeps (issues #190, #255):
 * a minimal in-memory IssueFunnel (authorize → write for the write-only sites,
 * snapshot-forwarding publishComputed), a REAL write-seam {@link Ledger} over
 * an in-memory change-log store (pass-through transact — atomicity with the
 * SessionStore is covered by the ledger suites, not here), plus the two issue
 * PublishSpec builders WITHOUT the upstream-mirror union. Every published
 * snapshot is forwarded to `broadcast` — the message stream service tests
 * asserted on back when IssueDeps carried a raw `broadcast(msg)` hook.
 * Production wiring lives in relay.ts (WriteFunnel + Ledger + IssuePublisher).
 */
export function issueTestPlumbing(
  broadcast: (msg: ServerMessage) => void = () => {},
): Pick<IssueDeps, 'funnel' | 'ledger' | 'publishSpecs'> {
  return {
    funnel: {
      run: (op) => {
        op.authorize?.()
        return op.write()
      },
      publishComputed: (snapshot) => broadcast(snapshot),
    },
    ledger: new Ledger({
      repo: memoryChangeLogStore(),
      now: Date.now,
      transact: (fn) => fn(),
    }),
    publishSpecs: {
      issueUpdated: (issue) => ({
        rows: [{ id: issue.id, value: issue }],
        snapshot: { type: 'issueUpdated', issue },
      }),
      issuesChanged: (issues) => ({
        rows: issues.map((i) => ({ id: i.id, value: i })),
        snapshot: { type: 'issuesChanged', issues },
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
    pruneChanges: () => 0,
    latestChangeStates: () => {
      const latest = new Map<string, Row>()
      for (const r of rows) latest.set(`${r.entity} ${r.entityId}`, r)
      return [...latest.values()]
    },
  }
}
