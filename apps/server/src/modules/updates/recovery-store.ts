import { UpdateChannel } from '@podium/model'
import { CONVERGENCE_STATES, UpdateTarget } from '@podium/protocol'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { z } from 'zod'

const RecoveryState = z.object({
  projectedCurrent: z.boolean().optional(),
  channel: UpdateChannel,
  state: z.enum(CONVERGENCE_STATES),
  requiresExecutionConfirmation: z.boolean().optional(),
  version: z.string(),
  grantId: z.string().optional(),
  detail: z.string().optional(),
  percent: z.number().optional(),
  phaseDetail: z.string().optional(),
})
const RecoveryGrant = z.object({
  targetFingerprint: z.string(),
  channel: UpdateChannel,
  grantId: z.string(),
  issuedAt: z.number(),
})
const RecoverySnapshot = z.object({
  format: z.literal(1),
  lastGrantAuthority: z.number(),
  targets: z.array(z.tuple([UpdateChannel, UpdateTarget])),
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
  write(snapshot: UpdateRecoverySnapshot): void
}

/** One atomic coordinator checkpoint in the existing database. No constructor
 * writes: recoveryOnly can restore it from a query-only database. Invalid proof
 * fails closed instead of silently restoring an empty grant map. */
export class UpdateRecoveryStore implements UpdateRecoveryPersistence {
  constructor(private readonly db: SqlDatabase) {}

  read(): UpdateRecoverySnapshot | undefined {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('updates.execution.v1') as { value: string } | undefined
    return row ? RecoverySnapshot.parse(JSON.parse(row.value)) : undefined
  }

  write(snapshot: UpdateRecoverySnapshot): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('updates.execution.v1', JSON.stringify(snapshot))
  }
}
