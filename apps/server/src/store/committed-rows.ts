/**
 * Repository write results, published by the executor's mandatory commit step.
 * RETURNING is part of the write statement: no SELECT, SQL parsing, invalidation,
 * or change-log projection is needed. The callback builds its query inside the
 * transaction so even a standalone repository write joins the commit funnel.
 */
import { applyAfterCommit } from './executor/executor'
import type { TransactionRunner } from './executor/sync-drizzle'

export interface CommittedRowChange<Row> {
  readonly operation: 'upsert' | 'delete'
  readonly rows: readonly Row[]
}

export class CommittedRows<Row> {
  private readonly listeners = new Set<(change: CommittedRowChange<Row>) => void>()

  constructor(
    private readonly transact: TransactionRunner,
    private readonly label: string,
  ) {}

  subscribe(listener: (change: CommittedRowChange<Row>) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async write(
    query: () => Promise<Row[]>,
    operation: CommittedRowChange<Row>['operation'],
  ): Promise<{ changes: number }> {
    return this.transact(async () => {
      const rows = await query()
      // Capture the result before releasing the lease; apply cannot query or await.
      applyAfterCommit(() => {
        const change = { operation, rows }
        for (const listener of this.listeners) listener(change)
      }, `world-index:${this.label}`)
      return { changes: rows.length }
    })
  }
}
