import { MachineIdField, ShipAttemptIdField, ShipOrderIdField } from '@podium/model'
import { z } from 'zod'

export const ShippingJobAction = z.enum(['start', 'status', 'cancel'])
export type ShippingJobAction = z.infer<typeof ShippingJobAction>

export const ShippingJobOperation = z.enum(['preflight', 'compatibility-land', 'verify'])
export type ShippingJobOperation = z.infer<typeof ShippingJobOperation>

/**
 * One daemon-owned shipping effect. The server supplies immutable facts and an
 * operation name, never a command line. `jobId + generation` is the replay and
 * stale-worker fence across both process boundaries.
 */
export const ShippingJobRequestMessage = z
  .object({
    type: z.literal('shippingJobRequest'),
    requestId: z.string().min(1),
    action: ShippingJobAction,
    jobId: z.string().min(1),
    orderId: ShipOrderIdField,
    attemptId: ShipAttemptIdField,
    generation: z.number().int().nonnegative(),
    operation: ShippingJobOperation,
    repoPath: z.string().min(1),
    sourceBranch: z.string().min(1),
    targetBranch: z.string().min(1),
    approvedBaseSha: z.string().min(1),
    approvedHeadSha: z.string().min(1),
    expectedTargetSha: z.string().min(1),
    destination: z.string().min(1),
  })
  .strict()
export type ShippingJobRequestMessage = z.infer<typeof ShippingJobRequestMessage>

export const ShippingJobState = z.enum(['running', 'succeeded', 'held', 'cancelled'])
export type ShippingJobState = z.infer<typeof ShippingJobState>

export const ShippingJobClassification = z.enum([
  'observed',
  'proved',
  'source-moved',
  'target-moved',
  'dirty-worktree',
  'wrong-target-checkout',
  'unsupported-destination-effect',
  'destination-mismatch',
  'stale-generation',
  'cancelled',
  'invalid-request',
])
export type ShippingJobClassification = z.infer<typeof ShippingJobClassification>

export const ShippingJobResult = z.object({
  jobId: z.string().min(1),
  orderId: ShipOrderIdField,
  attemptId: ShipAttemptIdField,
  machineId: MachineIdField,
  generation: z.number().int().nonnegative(),
  operation: ShippingJobOperation,
  state: ShippingJobState,
  classification: ShippingJobClassification,
  summary: z.string(),
  observedSourceSha: z.string().min(1).optional(),
  observedTargetSha: z.string().min(1).optional(),
  observedDestinationSha: z.string().min(1).optional(),
  logs: z.array(z.string()),
  artifactRefs: z.array(z.string()),
  heartbeatedAt: z.string(),
  finishedAt: z.string().optional(),
})
export type ShippingJobResult = z.infer<typeof ShippingJobResult>

export const ShippingJobResultMessage = ShippingJobResult.extend({
  type: z.literal('shippingJobResult'),
  requestId: z.string().min(1),
})
export type ShippingJobResultMessage = z.infer<typeof ShippingJobResultMessage>
