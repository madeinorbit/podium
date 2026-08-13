import { z } from 'zod'
import {
  DeliveryReceiptIdField,
  IssueIdField,
  RepoIdField,
  ShipHoldIdField,
  ShipOrderIdField,
} from './ids'

/** Hold vocabulary shared by the durable shipping records and their compact
 * replicated row. Keeping it here lets feed consumers avoid the full shipping
 * execution journal and delivery receipt schemas. */
export const ShipHoldCode = z.union([
  z.enum([
    'approval-stale',
    'dependency-blocked',
    'validation-failed',
    'landing-conflict',
    'destination-mismatch',
    'machine-unavailable',
    'policy-refused',
  ]),
  z.string().regex(/^policy:[a-z0-9][a-z0-9._-]*$/),
])
export type ShipHoldCode = z.infer<typeof ShipHoldCode>

export const ShipHoldAction = z.union([
  z.enum(['retry', 'return-to-issue', 'open-repair']),
  z.string().regex(/^policy:[a-z0-9][a-z0-9._-]*$/),
])
export type ShipHoldAction = z.infer<typeof ShipHoldAction>

export const ShipOrderHumanState = z.enum(['waiting', 'in_progress', 'needs_you', 'shipped'])
export type ShipOrderHumanState = z.infer<typeof ShipOrderHumanState>

/** The replicated state deliberately excludes the authority-only cancelled
 * state: cancelled orders leave the feed rather than becoming a retained row. */
export const ReplicatedShipOrderState = z.enum([
  'queued',
  'preflight',
  'composing',
  'validating',
  'repairing',
  'landing',
  'publishing',
  'verifying',
  'shipped',
  'held',
])
export type ReplicatedShipOrderState = z.infer<typeof ReplicatedShipOrderState>

export const ShipOrderActivity = z.enum([
  'waiting',
  'checking',
  'composing',
  'validating',
  'repairing',
  'landing',
  'publishing',
  'verifying',
  'held',
  'shipped',
])
export type ShipOrderActivity = z.infer<typeof ShipOrderActivity>

/** Compact replicated order row. It is keyed by order id and joined locally by
 * issueId; it never nests into IssueAggregate/IssueProjection. */
export const ShipOrderProjection = z.object({
  id: ShipOrderIdField,
  issueId: IssueIdField,
  repoId: RepoIdField,
  targetBranch: z.string().min(1),
  destination: z.string().min(1),
  state: ReplicatedShipOrderState,
  humanState: ShipOrderHumanState,
  activity: ShipOrderActivity,
  queuedAt: z.string(),
  stateChangedAt: z.string(),
  queueRank: z.number().int().positive().optional(),
  hold: z
    .object({
      id: ShipHoldIdField,
      generation: z.number().int().positive(),
      reasonCode: ShipHoldCode,
      headline: z.string().min(1),
      actions: z.array(ShipHoldAction).min(1),
    })
    .optional(),
  receiptId: DeliveryReceiptIdField.optional(),
})
export type ShipOrderProjection = z.infer<typeof ShipOrderProjection>
