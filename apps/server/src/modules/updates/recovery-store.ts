// workspace-scoped (POD-6959)
import { UpdateChannel } from '@podium/model'
import { CONVERGENCE_STATES, UpdateGrantMessage, UpdateTarget } from '@podium/protocol'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { StoreDb, TransactionRunner } from '../../store/executor/sync-drizzle'
import { preparedGlobal } from '../../store/executor/sync-drizzle'
import { MachineRecordWrites } from '../../store/machine-record-writes'

export const MachineFailureReason = z.object({
  code: z.string().optional(),
  message: z.string(),
  source: z.enum(['machine', 'coordinator']),
  at: z.number(),
})
export type MachineFailureReason = z.infer<typeof MachineFailureReason>

const RecoveryState = z.object({
  projectedCurrent: z.boolean().optional(),
  channel: UpdateChannel,
  state: z.enum(CONVERGENCE_STATES),
  requiresExecutionConfirmation: z.boolean().optional(),
  version: z.string(),
  grantId: z.string().optional(),
  detail: z.string().optional(),
  reason: MachineFailureReason.optional(),
  lastReportAt: z.number().optional(),
  lastReportedState: z.enum(CONVERGENCE_STATES).optional(),
  targetVersion: z.string().optional(),
  percent: z.number().optional(),
  phaseDetail: z.string().optional(),
})
const RecoveryGrant = z.object({
  targetFingerprint: z.string(),
  channel: UpdateChannel,
  grantId: z.string(),
  issuedAt: z.number(),
  coordinatorGrant: UpdateGrantMessage.optional(),
})
const RecoverySnapshot = z.object({
  format: z.literal(1),
  lastGrantAuthority: z.number(),
  targets: z.array(z.tuple([UpdateChannel, UpdateTarget])),
  withdrawnTargets: z
    .array(
      z.tuple([
        UpdateChannel,
        z.object({
          target: UpdateTarget,
          reason: z.string(),
          withdrawnAt: z.number(),
        }),
      ]),
    )
    .optional(),
  machines: z.array(z.tuple([z.string(), RecoveryState])),
  grants: z.array(z.tuple([z.string(), RecoveryGrant])),
  // Optional for checkpoints written before retired execution proof was retained.
  retiredGrants: z.array(z.tuple([z.string(), RecoveryGrant])).optional(),
  rollouts: z.array(
    z.tuple([
      UpdateChannel,
      z.object({
        canaryHealthy: z.boolean(),
        halted: z.boolean(),
      }),
    ]),
  ),
})
export type UpdateRecoverySnapshot = z.infer<typeof RecoverySnapshot>
export interface UpdateRecoveryPersistence {
  read(): UpdateRecoverySnapshot | undefined
  write(snapshot: () => UpdateRecoverySnapshot): void | Promise<void>
}

/**
 * THE CHECKPOINT IS THE INSTALL'S (POD-6959 design 2.1): fleet update execution
 * is one per database, an install key of `meta` (`INSTALL_META_KEYS`), so both
 * definitions are global and every workspace's store reads the same row.
 */
const CHECKPOINT_KEY = 'updates.execution.v1'

const checkpoint = preparedGlobal((db, t) =>
  db.select({ value: t.meta.value }).from(t.meta).where(eq(t.meta.key, CHECKPOINT_KEY)).prepare(),
)
const saveCheckpoint = preparedGlobal((db, t) =>
  db
    .insert(t.meta)
    .values({ key: CHECKPOINT_KEY, value: sql.placeholder('value') })
    .onConflictDoUpdate({ target: t.meta.key, set: { value: sql.placeholder('value') } })
    .prepare(),
)

/**
 * What the store is handed: a handle that runs global definitions (a workspace
 * handle does too) and the transaction runner the machine records commit in.
 * In the server that is the workspace's, so the records' change capture lands
 * in that workspace's change log.
 */
export interface UpdateRecoveryQueries {
  readonly db: StoreDb
  readonly createOrJoinTransaction: TransactionRunner
}

/** The checkpoint and any changed machine display records commit together. */
export class UpdateRecoveryStore {
  constructor(
    private readonly queries: UpdateRecoveryQueries,
    private readonly records = new MachineRecordWrites(),
  ) {}

  async read(): Promise<UpdateRecoverySnapshot | undefined> {
    const row = await checkpoint(this.queries.db).get()
    return row ? RecoverySnapshot.parse(JSON.parse(row.value)) : undefined
  }

  async write(snapshot: () => UpdateRecoverySnapshot): Promise<void> {
    // Fleet reads and ticks often leave execution proof unchanged. Compare on
    // the read lane first, so those calls never queue a write transaction.
    const current = await checkpoint(this.queries.db).get()
    if (current?.value === JSON.stringify(snapshot())) return
    await this.queries.createOrJoinTransaction(async () => {
      const row = await checkpoint(this.queries.db).get()
      // Build after acquiring the write lane. Concurrent observers persist the
      // current runtime proof when their turn arrives.
      const next = snapshot()
      const value = JSON.stringify(next)
      if (row?.value === value) return
      // One change-log commit: the capture fires only when a published
      // target version moved, and the machine records it reaches are
      // appended with the checkpoint (POD-6920).
      await this.records.compare(async () => {
        await saveCheckpoint(this.queries.db).run({ value })
      })
    })
  }
}
