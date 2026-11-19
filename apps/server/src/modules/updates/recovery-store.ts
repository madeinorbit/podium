// workspace-scoped (POD-6959)

import { UpdateChannel } from '@podium/model'
import { CONVERGENCE_STATES, UpdateGrantMessage, UpdateTarget } from '@podium/protocol'
import { z } from 'zod'
import type { StoreDb, TransactionRunner } from '../../store/executor/sync-drizzle'
import { MachineRecordWrites } from '../../store/machine-record-writes'
import { readUpdateRecoveryValue, writeUpdateRecoveryValue } from '../../store/update-recovery'

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
    const value = await readUpdateRecoveryValue(this.queries.db)
    return value === undefined ? undefined : RecoverySnapshot.parse(JSON.parse(value))
  }

  async write(snapshot: () => UpdateRecoverySnapshot): Promise<void> {
    // Fleet reads and ticks often leave execution proof unchanged. Compare on
    // the read lane first, so those calls never queue a write transaction.
    const current = await readUpdateRecoveryValue(this.queries.db)
    if (current === JSON.stringify(snapshot())) return
    await this.queries.createOrJoinTransaction(async () => {
      const previous = await readUpdateRecoveryValue(this.queries.db)
      // Build after acquiring the write lane. Concurrent observers persist the
      // current runtime proof when their turn arrives.
      const next = snapshot()
      const value = JSON.stringify(next)
      if (previous === value) return
      // One change-log commit: the capture fires only when a published
      // target version moved, and the machine records it reaches are
      // appended with the checkpoint (POD-6920).
      await this.records.compare(async () => {
        await writeUpdateRecoveryValue(this.queries.db, value)
      })
    })
  }
}
