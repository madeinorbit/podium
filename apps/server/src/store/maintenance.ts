import { MaintenanceCommandReply, type MaintenanceCommandReply as Reply } from '@podium/protocol'
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import { maintenanceCommands, maintenanceLeases } from '../migrations/schema'
import type { SyncDrizzle, SyncQueries } from './executor/sync-drizzle'

export interface MaintenanceLeaseRow {
  name: string
  generationId: string
  fencingToken: number
  expiresAt: string
  protocolVersion: number
  schemaVersion: string
  updatedAt: string
}

/** Server-owned durable fence and maintenance idempotency ledger [spec:SP-c29e]. */
export class MaintenanceRepository {
  private readonly db: SyncDrizzle

  constructor(queries: SyncQueries) {
    // Destructured rather than held as `this.queries`, so every query body below
    // reads `this.db` — the receiver B1 keeps when it swaps in the async pair
    // and adds the awaits [spec rule 27b].
    this.db = queries.db
  }

  getLease(name: string): MaintenanceLeaseRow | undefined {
    // `.get()` returns undefined for no row, which is the contract this method
    // already had — and deliberately NOT the `null` LocksRepository returns from
    // the same shape one file over.
    return this.db.select().from(maintenanceLeases).where(eq(maintenanceLeases.name, name)).get()
  }

  putLease(lease: MaintenanceLeaseRow): void {
    this.db
      .insert(maintenanceLeases)
      .values(lease)
      .onConflictDoUpdate({
        target: maintenanceLeases.name,
        set: {
          generationId: lease.generationId,
          fencingToken: lease.fencingToken,
          expiresAt: lease.expiresAt,
          protocolVersion: lease.protocolVersion,
          schemaVersion: lease.schemaVersion,
          updatedAt: lease.updatedAt,
        },
      })
      .run()
  }

  getCommand(jobKind: string, runKey: string): Reply | undefined {
    const row = this.db
      .select({ resultJson: maintenanceCommands.resultJson })
      .from(maintenanceCommands)
      .where(and(eq(maintenanceCommands.jobKind, jobKind), eq(maintenanceCommands.runKey, runKey)))
      .get()
    if (!row) return undefined
    // NOT `mode: 'json'` and not quarantined: an unparseable row in the server's
    // own idempotency ledger throws, which is the behaviour this column has and
    // which the conversion preserves (spec §6 rule 4).
    return MaintenanceCommandReply.parse(JSON.parse(row.resultJson))
  }

  recordCommand(reply: Reply, fencingToken: number, appliedAt: string): void {
    this.db
      .insert(maintenanceCommands)
      .values({
        jobKind: reply.jobKind,
        runKey: reply.runKey,
        fencingToken,
        resultJson: JSON.stringify(reply),
        appliedAt,
      })
      .run()
  }

  /**
   * Bounded head prune of the maintenance idempotency ledger [POD-845 residual].
   * Deletes oldest rows with applied_at strictly before cutoff, in batches.
   *
   * STILL ONE STATEMENT. The bound and the order live in a SUBQUERY over `rowid`,
   * exactly as the raw form did: selecting the victims first and deleting them
   * second would be two statements with a window between them, and after the flip
   * that window contains awaits.
   */
  pruneCommandsBatch(cutoffAppliedAt: string, batchSize: number): number {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new RangeError('batchSize must be a positive integer')
    }
    const oldest = this.db
      .select({ rowid: sql<number>`rowid` })
      .from(maintenanceCommands)
      .where(lt(maintenanceCommands.appliedAt, cutoffAppliedAt))
      .orderBy(
        asc(maintenanceCommands.appliedAt),
        asc(maintenanceCommands.jobKind),
        asc(maintenanceCommands.runKey),
      )
      .limit(batchSize)
    const result = this.db.delete(maintenanceCommands).where(inArray(sql`rowid`, oldest)).run()
    return Number(result.changes)
  }
}
