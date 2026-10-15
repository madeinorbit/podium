import type { IssueId, MachineId, SessionId } from '@podium/model'
import type { ApprovalOp, ApprovalStatus } from '@podium/protocol'
import { and, asc, eq, sql } from 'drizzle-orm'
import { approvalRequests } from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { param, prepared } from './executor/sync-drizzle'

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

// Every query this repository runs, prepared once per store [POD-6147].

const insertApproval = prepared((db: StoreDrizzle) =>
  db
    .insert(approvalRequests)
    .values({
      id: sql.placeholder('id'),
      machineId: sql.placeholder('machineId'),
      sessionId: sql.placeholder('sessionId'),
      issueId: sql.placeholder('issueId'),
      opJson: sql.placeholder('opJson'),
      status: 'pending',
      createdAt: sql.placeholder('createdAt'),
    })
    .prepare(),
)

const approvalById = prepared((db: StoreDrizzle) =>
  db.select().from(approvalRequests).where(eq(approvalRequests.id, param(approvalRequests.id, 'id'))).prepare(),
)

const pendingApprovals = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.status, 'pending'))
    .orderBy(asc(approvalRequests.createdAt))
    .prepare(),
)

const executingApprovals = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.status, 'executing'))
    .orderBy(asc(approvalRequests.decidedAt))
    .prepare(),
)

const transitionApproval = prepared((db: StoreDrizzle) =>
  db
    .update(approvalRequests)
    .set({
      status: sql.placeholder('to'),
      decidedAt: sql`COALESCE(${approvalRequests.decidedAt}, ${sql.placeholder('now')})`,
      resultText: sql`COALESCE(${sql.placeholder('next')}, ${approvalRequests.resultText})`,
    })
    .where(and(eq(approvalRequests.id, param(approvalRequests.id, 'id')), eq(approvalRequests.status, param(approvalRequests.status, 'from'))))
    .prepare(),
)

export class ApprovalsRepository {
  private readonly rootDb: StoreDrizzle
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
  protected get db(): StoreDrizzle {
    return this.rootDb
  }

  async insert(row: {
    id: string
    machineId: MachineId
    sessionId: SessionId
    issueId: IssueId | null
    op: ApprovalOp
    createdAt: string
  }): Promise<void> {
    await insertApproval(this.db).run({
      id: row.id,
      machineId: row.machineId,
      sessionId: row.sessionId,
      issueId: row.issueId,
      opJson: JSON.stringify(row.op),
      createdAt: row.createdAt,
    })
  }

  async get(id: string): Promise<ApprovalRow | null> {
    const r = await approvalById(this.db).get({ id })
    return r ? toRow(r) : null
  }

  async listPending(): Promise<ApprovalRow[]> {
    return (await pendingApprovals(this.db).all()).map(toRow)
  }

  /** Every row handed to a daemon and not yet answered (POD-2223). The stall sweep
   *  reads this; it is bounded by how many approvals are in flight at once, which is
   *  a human-paced number. `decided_at` is the approve instant — `transition` sets it
   *  on the first move out of `pending`, and pending → executing IS that move. */
  async listExecuting(): Promise<ApprovalRow[]> {
    return (await executingApprovals(this.db).all()).map(toRow)
  }

  /** Atomic state transition; returns false when the row wasn't in `from`
   *  (double-click / racing decisions decide once). */
  async transition(id: string, from: ApprovalStatus, to: ApprovalStatus, resultText?: string): Promise<boolean> {
    const now = new Date().toISOString()
    const next = resultText ?? null
    const r = await transitionApproval(this.db).run({ id, from, to, now, next })
    return r.changes > 0
  }
}
