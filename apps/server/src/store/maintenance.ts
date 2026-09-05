import { MaintenanceCommandReply, type MaintenanceCommandReply as Reply } from '@podium/protocol'
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import { maintenanceCommands, maintenanceLeases } from '../migrations/schema'
import type { StoreQueries, StoreDrizzle, TransactionRunner } from './executor/sync-drizzle'
import { currentTransaction } from './executor/sync-drizzle'

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
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /**
   * The query builder every method below reads through [spec rules 34, 34a].
   *
   * A GETTER, not a field assigned in the constructor: rule 35 makes transaction
   * routing ambient, so this has to resolve the ENCLOSING transaction on every
   * access, and a field frozen at construction never could. B1 changes this one
   * line; no call site moves.
   */
  protected get db() {
    return currentTransaction() ?? this.rootDb
  }

  async getLease(name: string): Promise<MaintenanceLeaseRow | undefined> {
    // `.get()` returns undefined for no row, which is the contract this method
    // already had — and deliberately NOT the `null` LocksRepository returns from
    // the same shape one file over.
    return await this.db.select().from(maintenanceLeases).where(eq(maintenanceLeases.name, name)).get()
  }

  async putLease(lease: MaintenanceLeaseRow): Promise<void> {
    ;await (this.db
      .insert(maintenanceLeases)
      .values(lease))
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

  async getCommand(jobKind: string, runKey: string): Promise<Reply | undefined> {
    const row = await this.db
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

  async recordCommand(reply: Reply, fencingToken: number, appliedAt: string): Promise<void> {
    ;await (this.db
      .insert(maintenanceCommands)
      .values({
        jobKind: reply.jobKind,
        runKey: reply.runKey,
        fencingToken,
        resultJson: JSON.stringify(reply),
        appliedAt,
      }))
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
  async pruneCommandsBatch(cutoffAppliedAt: string, batchSize: number): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new RangeError('batchSize must be a positive integer')
    }
    const oldest = await this.db
      .select({ rowid: sql<number>`rowid` })
      .from(maintenanceCommands)
      .where(lt(maintenanceCommands.appliedAt, cutoffAppliedAt))
      .orderBy(
        asc(maintenanceCommands.appliedAt),
        asc(maintenanceCommands.jobKind),
        asc(maintenanceCommands.runKey),
      )
      .limit(batchSize)
    const result = await this.db.delete(maintenanceCommands).where(inArray(sql`rowid`, oldest)).run()
    return Number(result.changes)
  }
}
