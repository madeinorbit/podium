import { UpdateChannel } from '@podium/model'
import { CONVERGENCE_STATES, UpdateGrantMessage, UpdateTarget } from '@podium/protocol'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { meta } from '../../migrations/schema'
import type { StoreDrizzle, StoreQueries } from '../../store/executor/sync-drizzle'
import { prepared } from '../../store/executor/sync-drizzle'
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

const checkpoint = prepared((db: StoreDrizzle) =>
  db.select({ value: meta.value }).from(meta).where(eq(meta.key, 'updates.execution.v1')).prepare(),
)
const saveCheckpoint = prepared((db: StoreDrizzle) =>
  db
    .insert(meta)
    .values({ key: 'updates.execution.v1', value: sql.placeholder('value') })
    .onConflictDoUpdate({ target: meta.key, set: { value: sql.placeholder('value') } })
    .prepare(),
)

/** The checkpoint and any changed machine display records commit together. */
export class UpdateRecoveryStore {
  constructor(
    private readonly queries: StoreQueries,
    private readonly records = new MachineRecordWrites(),
    private readonly machineIds: () => Promise<readonly string[]> = async () => [],
  ) {}

  async read(): Promise<UpdateRecoverySnapshot | undefined> {
    const row = await checkpoint(this.queries.rootDb).get()
    return row ? RecoverySnapshot.parse(JSON.parse(row.value)) : undefined
  }

  async write(snapshot: () => UpdateRecoverySnapshot): Promise<void> {
    // Fleet reads and ticks often leave execution proof unchanged. Compare on
    // the read lane first, so those calls never queue a write transaction.
    const current = await checkpoint(this.queries.rootDb).get()
    if (current?.value === JSON.stringify(snapshot())) return
    await this.queries.createOrJoinTransaction(async () => {
      const row = await checkpoint(this.queries.rootDb).get()
      // Build after acquiring the write lane. Concurrent observers persist the
      // current runtime proof when their turn arrives.
      const next = snapshot()
      const value = JSON.stringify(next)
      if (row?.value === value) return
      const previous = row ? RecoverySnapshot.parse(JSON.parse(row.value)) : undefined
      const before = new Map(
        previous?.targets.map(([channel, target]) => [channel, target.version]),
      )
      const after = new Map(next.targets.map(([channel, target]) => [channel, target.version]))
      const moved =
        before.size !== after.size ||
        [...after].some(([channel, version]) => before.get(channel) !== version)
      const write = async () => {
        await saveCheckpoint(this.queries.rootDb).run({ value })
      }
      if (moved) await this.records.compare({ display: this.machineIds }, write)
      else await write()
    })
  }
}
