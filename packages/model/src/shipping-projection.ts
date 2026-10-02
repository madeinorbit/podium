import { z } from 'zod'
import {
  DeliveryReceiptIdField,
  IssueIdField,
  joinKeyParts,
  type RepoId,
  RepoIdField,
  ShipHoldIdField,
  ShipOrderIdField,
  splitKeyParts,
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
 * issueId; it never nests into IssueAggregate/IssueProjection. Queue rank lives
 * on ShipLaneProjection (POD-4974 O4). Legacy queueRank, train and waitEstimate
 * fields remain optional for older wire rows and offline caches; current
 * servers never publish them. */
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
  /** Compatibility only: current projections omit rank; clients read the lane. */
  queueRank: z.number().int().positive().optional(),
  /** Compatibility only: current projections omit this unused field. */
  train: z
    .object({
      id: z.string().min(1),
      index: z.number().int().positive(),
      size: z.number().int().positive(),
    })
    .refine((train) => train.index <= train.size, {
      message: 'train member index must not exceed its size',
    })
    .optional(),
  /** Compatibility only: current projections omit this unused field. */
  waitEstimate: z
    .object({
      lowerBoundMs: z.number().int().nonnegative(),
      upperBoundMs: z.number().int().nonnegative(),
      sampleSize: z.number().int().positive(),
      basis: z.literal('lane-history'),
    })
    .refine((estimate) => estimate.upperBoundMs >= estimate.lowerBoundMs, {
      message: 'wait estimate upper bound must not precede its lower bound',
    })
    .optional(),
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

const SHIP_LANE_SEP = ':'

/** The id of one delivery lane's row: its repository and CANONICAL destination,
 * the same pair the scheduler groups by. Stable for the lane's whole life, unlike
 * a train id, which hashes the current members. */
export const shipLaneId = (repoId: RepoId, destination: string): string => {
  if (repoId === '' || destination === '') throw new Error('ship lane id parts must not be empty')
  return joinKeyParts(SHIP_LANE_SEP, [repoId, destination])
}

/** Inverse of {@link shipLaneId}; throws on a malformed id. */
export const parseShipLaneId = (id: string): { repoId: RepoId; destination: string } => {
  const [repoId, destination] = splitKeyParts(SHIP_LANE_SEP, id, 2) as [string, string]
  if (repoId === '' || destination === '')
    throw new Error(`malformed ship lane id: ${JSON.stringify(id)}`)
  return { repoId: repoId as RepoId, destination }
}

/** One delivery lane's queue in the scheduler's order (POD-4974 O2, ADR 4 D7.4).
 *
 * A server-maintained entity because the client cannot compute rank: it lacks
 * the dependency and native-stack edges and the train-compatibility facts. The
 * server recomputes a lane only when a commit touches it, from the scheduler's
 * own input. An order's rank is its train's position here, starting at 1; a
 * blocked queued order has no rank. Visible to anyone who may read at least one
 * order in the lane. */
export const ShipLaneProjection = z.object({
  id: z.string().min(1),
  repoId: RepoIdField,
  destination: z.string().min(1),
  trains: z.array(z.object({ orderIds: z.array(ShipOrderIdField).min(1) })),
  blockedOrderIds: z.array(ShipOrderIdField),
})
export type ShipLaneProjection = z.infer<typeof ShipLaneProjection>
