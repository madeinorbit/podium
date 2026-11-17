// workspace-scoped (POD-6959)
import { MaintenanceCommandReply, type MaintenanceCommandReply as Reply } from '@podium/protocol'
import { asc, eq, lt, sql } from 'drizzle-orm'
import type { TransactionRunner, WorkspaceDb, WorkspaceQueries } from './executor/sync-drizzle'
import { inWorkspace, param, prepared, preparedGlobal, WORKSPACE } from './executor/sync-drizzle'

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
// Every query this repository runs, prepared once per store [POD-6147].
//
// TWO KINDS OF ROW (POD-6959 design 2.1). The lease is the installation's (an
// install table, so its definitions are global); the idempotency ledger is the
// workspace's, so a job's receipts and their prune are this workspace's only.

const leaseByName = preparedGlobal((db, t) =>
  db
    .select()
    .from(t.maintenanceLeases)
    .where(eq(t.maintenanceLeases.name, param(t.maintenanceLeases.name, 'name')))
    .prepare(),
)

const upsertLease = preparedGlobal((db, t) =>
  db
    .insert(t.maintenanceLeases)
    .values({
      name: sql.placeholder('name'),
      generationId: sql.placeholder('generationId'),
      fencingToken: sql.placeholder('fencingToken'),
      expiresAt: sql.placeholder('expiresAt'),
      protocolVersion: sql.placeholder('protocolVersion'),
      schemaVersion: sql.placeholder('schemaVersion'),
      updatedAt: sql.placeholder('updatedAt'),
    })
    .onConflictDoUpdate({
      target: t.maintenanceLeases.name,
      set: {
        generationId: sql.placeholder('generationId'),
        fencingToken: sql.placeholder('fencingToken'),
        expiresAt: sql.placeholder('expiresAt'),
        protocolVersion: sql.placeholder('protocolVersion'),
        schemaVersion: sql.placeholder('schemaVersion'),
        updatedAt: sql.placeholder('updatedAt'),
      },
    })
    .prepare(),
)

const commandResult = prepared((db, t) =>
  db
    .select({ resultJson: t.maintenanceCommands.resultJson })
    .from(t.maintenanceCommands)
    .where(
      inWorkspace(
        t.maintenanceCommands,
        eq(t.maintenanceCommands.jobKind, param(t.maintenanceCommands.jobKind, 'jobKind')),
        eq(t.maintenanceCommands.runKey, param(t.maintenanceCommands.runKey, 'runKey')),
      ),
    )
    .prepare(),
)

const insertCommand = prepared((db, t) =>
  db
    .insert(t.maintenanceCommands)
    .values({
      workspaceId: WORKSPACE,
      jobKind: sql.placeholder('jobKind'),
      runKey: sql.placeholder('runKey'),
      fencingToken: sql.placeholder('fencingToken'),
      resultJson: sql.placeholder('resultJson'),
      appliedAt: sql.placeholder('appliedAt'),
    })
    .prepare(),
)

const pruneOldestCommands = prepared((db, t) => {
  const oldest = db
    .select({ jobKind: t.maintenanceCommands.jobKind, runKey: t.maintenanceCommands.runKey })
    .from(t.maintenanceCommands)
    .where(
      inWorkspace(
        t.maintenanceCommands,
        lt(
          t.maintenanceCommands.appliedAt,
          param(t.maintenanceCommands.appliedAt, 'cutoffAppliedAt'),
        ),
      ),
    )
    .orderBy(
      asc(t.maintenanceCommands.appliedAt),
      asc(t.maintenanceCommands.jobKind),
      asc(t.maintenanceCommands.runKey),
    )
    .limit(sql.placeholder('batchSize'))
  return (
    db
      .delete(t.maintenanceCommands)
      // The victims by their key (a row value), not by `rowid`, which Postgres has not.
      .where(
        inWorkspace(
          t.maintenanceCommands,
          sql`(${t.maintenanceCommands.jobKind}, ${t.maintenanceCommands.runKey}) IN ${oldest}`,
        ),
      )
      .prepare()
  )
})

export class MaintenanceRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
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
  protected get db(): WorkspaceDb {
    return this.scope
  }

  async getLease(name: string): Promise<MaintenanceLeaseRow | undefined> {
    // `.get()` returns undefined for no row, which is the contract this method
    // already had — and deliberately NOT the `null` LocksRepository returns from
    // the same shape one file over.
    return await leaseByName(this.db).get({ name })
  }

  async putLease(lease: MaintenanceLeaseRow): Promise<void> {
    await upsertLease(this.db).run({
      name: lease.name,
      generationId: lease.generationId,
      fencingToken: lease.fencingToken,
      expiresAt: lease.expiresAt,
      protocolVersion: lease.protocolVersion,
      schemaVersion: lease.schemaVersion,
      updatedAt: lease.updatedAt,
    })
  }

  async getCommand(jobKind: string, runKey: string): Promise<Reply | undefined> {
    const row = await commandResult(this.db).get({ jobKind, runKey })
    if (!row) return undefined
    // NOT `mode: 'json'` and not quarantined: an unparseable row in the server's
    // own idempotency ledger throws, which is the behaviour this column has and
    // which the conversion preserves (spec §6 rule 4).
    return MaintenanceCommandReply.parse(JSON.parse(row.resultJson))
  }

  async recordCommand(reply: Reply, fencingToken: number, appliedAt: string): Promise<void> {
    await insertCommand(this.db).run({
      jobKind: reply.jobKind,
      runKey: reply.runKey,
      fencingToken,
      resultJson: JSON.stringify(reply),
      appliedAt,
    })
  }

  /**
   * Bounded head prune of the maintenance idempotency ledger [POD-845 residual].
   * Deletes oldest rows with applied_at strictly before cutoff, in batches.
   *
   * STILL ONE STATEMENT. The bound and the order live in a SUBQUERY over the key,
   * exactly as the raw form did: selecting the victims first and deleting them
   * second would be two statements with a window between them, and after the flip
   * that window contains awaits.
   */
  async pruneCommandsBatch(cutoffAppliedAt: string, batchSize: number): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new RangeError('batchSize must be a positive integer')
    }
    const result = await pruneOldestCommands(this.db).run({ cutoffAppliedAt, batchSize })
    return Number(result.changes)
  }
}
