import type { ApprovalOp, ApprovalStatus } from '@podium/protocol'
import type { SqlDatabase } from '@podium/runtime/sqlite'

/** One approval-broker row [spec:SP-edbb] as stored (wire enrichment — machine
 *  name, issue seq/title — happens in the service layer). */
export interface ApprovalRow {
  id: string
  machineId: string
  sessionId: string
  issueId: string | null
  op: ApprovalOp
  status: ApprovalStatus
  createdAt: string
  decidedAt: string | null
  resultText: string | null
}

function toRow(r: Record<string, unknown>): ApprovalRow {
  return {
    id: r.id as string,
    machineId: r.machine_id as string,
    sessionId: r.session_id as string,
    issueId: (r.issue_id as string | null) ?? null,
    op: JSON.parse(r.op_json as string) as ApprovalOp,
    status: r.status as ApprovalStatus,
    createdAt: r.created_at as string,
    decidedAt: (r.decided_at as string | null) ?? null,
    resultText: (r.result_text as string | null) ?? null,
  }
}

export class ApprovalsRepository {
  constructor(private readonly db: SqlDatabase) {}

  insert(row: {
    id: string
    machineId: string
    sessionId: string
    issueId: string | null
    op: ApprovalOp
    createdAt: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO approval_requests (id, machine_id, session_id, issue_id, op_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(row.id, row.machineId, row.sessionId, row.issueId, JSON.stringify(row.op), row.createdAt)
  }

  get(id: string): ApprovalRow | null {
    const r = this.db.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined
    return r ? toRow(r) : null
  }

  listPending(): ApprovalRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM approval_requests WHERE status = 'pending' ORDER BY created_at`)
        .all() as Record<string, unknown>[]
    ).map(toRow)
  }

  /** Atomic state transition; returns false when the row wasn't in `from`
   *  (double-click / racing decisions decide once). */
  transition(id: string, from: ApprovalStatus, to: ApprovalStatus, resultText?: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE approval_requests
         SET status = ?, decided_at = COALESCE(decided_at, ?),
             result_text = COALESCE(?, result_text)
         WHERE id = ? AND status = ?`,
      )
      .run(to, new Date().toISOString(), resultText ?? null, id, from)
    return r.changes > 0
  }
}
