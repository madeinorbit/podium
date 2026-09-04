import type { IssueId, MachineId, SessionId } from '@podium/model'
import type { ApprovalOp, ApprovalStatus } from '@podium/protocol'
import { and, asc, eq, sql } from 'drizzle-orm'
import { approvalRequests } from '../migrations/schema'
import type { StoreQueries, SyncDrizzle, TransactionRunner } from './executor/sync-drizzle'

/** One approval-broker row [spec:SP-edbb] as stored (wire enrichment — machine
 *  name, issue seq/title — happens in the service layer). */
export interface ApprovalRow {
  id: string
  machineId: MachineId
  sessionId: SessionId
  issueId: IssueId | null
  op: ApprovalOp
  status: ApprovalStatus
  createdAt: string
  decidedAt: string | null
  resultText: string | null
}

type ApprovalSelection = typeof approvalRequests.$inferSelect

function toRow(r: ApprovalSelection): ApprovalRow {
  return {
    id: r.id,
    machineId: r.machineId,
    sessionId: r.sessionId,
    issueId: r.issueId,
    op: JSON.parse(r.opJson) as ApprovalOp,
    status: r.status as ApprovalStatus,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    resultText: r.resultText,
  }
}

export class ApprovalsRepository {
  private readonly rootDb: SyncDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * Rule 34a — `db` RESOLVES on every access rather than being frozen at
   * construction, so rule 35's ambient transaction routing has one line to
   * change at B1 and no call site does.
   */
  protected get db(): SyncDrizzle {
    return this.rootDb
  }

  insert(row: {
    id: string
    machineId: MachineId
    sessionId: SessionId
    issueId: IssueId | null
    op: ApprovalOp
    createdAt: string
  }): void {
    this.db
      .insert(approvalRequests)
      .values({
        id: row.id,
        machineId: row.machineId,
        sessionId: row.sessionId,
        issueId: row.issueId,
        opJson: JSON.stringify(row.op),
        status: 'pending',
        createdAt: row.createdAt,
      })
      .run()
  }

  get(id: string): ApprovalRow | null {
    const r = this.db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get()
    return r ? toRow(r) : null
  }

  listPending(): ApprovalRow[] {
    return this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.status, 'pending'))
      .orderBy(asc(approvalRequests.createdAt))
      .all()
      .map(toRow)
  }

  /** Every row handed to a daemon and not yet answered (POD-2223). The stall sweep
   *  reads this; it is bounded by how many approvals are in flight at once, which is
   *  a human-paced number. `decided_at` is the approve instant — `transition` sets it
   *  on the first move out of `pending`, and pending → executing IS that move. */
  listExecuting(): ApprovalRow[] {
    return this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.status, 'executing'))
      .orderBy(asc(approvalRequests.decidedAt))
      .all()
      .map(toRow)
  }

  /** Atomic state transition; returns false when the row wasn't in `from`
   *  (double-click / racing decisions decide once). */
  transition(id: string, from: ApprovalStatus, to: ApprovalStatus, resultText?: string): boolean {
    const now = new Date().toISOString()
    const next = resultText ?? null
    const r = this.db
      .update(approvalRequests)
      .set({
        status: to,
        decidedAt: sql`COALESCE(${approvalRequests.decidedAt}, ${now})`,
        resultText: sql`COALESCE(${next}, ${approvalRequests.resultText})`,
      })
      .where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, from)))
      .run()
    return r.changes > 0
  }
}
