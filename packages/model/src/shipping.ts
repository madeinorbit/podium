import { z } from 'zod'
import { Attribution } from './fields/attribution'
import {
  DeliveryReceiptIdField,
  IssueIdField,
  MachineIdField,
  RepoIdField,
  ShipAttemptIdField,
  ShipHoldIdField,
  ShipOrderIdField,
  ShipStepIdField,
} from './ids'

export const ShipOrderState = z.enum([
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
  'cancelled',
])
export type ShipOrderState = z.infer<typeof ShipOrderState>

export const TERMINAL_SHIP_ORDER_STATES = [
  'shipped',
  'cancelled',
] as const satisfies readonly ShipOrderState[]
export type TerminalShipOrderState = (typeof TERMINAL_SHIP_ORDER_STATES)[number]
export const isTerminalShipOrderState = (state: ShipOrderState): state is TerminalShipOrderState =>
  (TERMINAL_SHIP_ORDER_STATES as readonly string[]).includes(state)

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

export const DescendantTip = z.object({
  issueId: IssueIdField,
  approvedHeadSha: z.string().min(1),
})
export type DescendantTip = z.infer<typeof DescendantTip>

export const ProviderPullRequestRef = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  url: z.string().min(1).optional(),
})
export type ProviderPullRequestRef = z.infer<typeof ProviderPullRequestRef>

export const ShipAttemptOutcome = z.enum(['succeeded', 'failed', 'cancelled'])
export type ShipAttemptOutcome = z.infer<typeof ShipAttemptOutcome>

export const ShipValidationResult = z.enum(['passed', 'failed'])
export type ShipValidationResult = z.infer<typeof ShipValidationResult>

/** Durable delivery intent. Queue rank is intentionally absent: it is a
 * read-time fact within one `(repoId, destination)` lane. */
export const ShipOrder = z
  .object({
    id: ShipOrderIdField,
    issueId: IssueIdField,
    descendantManifest: z.array(DescendantTip),
    repoId: RepoIdField,
    targetBranch: z.string().min(1),
    destination: z.string().min(1),
    approvedBaseSha: z.string().min(1),
    approvedHeadSha: z.string().min(1),
    deliveryDependsOn: z.array(ShipOrderIdField),
    providerRef: ProviderPullRequestRef.optional(),
    requestedBy: Attribution,
    requestedAt: z.string(),
    policyId: z.string().min(1),
    closeMode: z.enum(['after-destination', 'leave-open']),
    state: ShipOrderState,
    stateChangedAt: z.string(),
    holdCode: ShipHoldCode.optional(),
  })
  .superRefine((order, ctx) => {
    if ((order.state === 'held') !== (order.holdCode !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['holdCode'],
        message: 'holdCode is required exactly while the order is held',
      })
    }
  })
export type ShipOrder = z.infer<typeof ShipOrder>

const LEGAL_SHIP_ORDER_TRANSITIONS = {
  queued: ['preflight', 'held', 'cancelled'],
  preflight: ['composing', 'held', 'cancelled'],
  composing: ['validating', 'held', 'cancelled'],
  validating: ['repairing', 'landing', 'held', 'cancelled'],
  repairing: ['validating', 'held', 'cancelled'],
  landing: ['publishing', 'verifying', 'held'],
  publishing: ['verifying', 'held'],
  verifying: ['shipped', 'held'],
  held: ['queued', 'repairing', 'cancelled'],
  shipped: [],
  cancelled: [],
} as const satisfies Record<ShipOrderState, readonly ShipOrderState[]>

export const legalShipOrderNextStates = (state: ShipOrderState): readonly ShipOrderState[] =>
  LEGAL_SHIP_ORDER_TRANSITIONS[state]

export const isLegalShipOrderTransition = (from: ShipOrderState, to: ShipOrderState): boolean =>
  legalShipOrderNextStates(from).some((state) => state === to)

/** One leased execution attempt. The four SHA facts are deliberately separate:
 * approval, tested composition, landed ref, and verified destination are not
 * interchangeable evidence. */
export const ShipAttempt = z
  .object({
    id: ShipAttemptIdField,
    orderId: ShipOrderIdField,
    expectedSourceBaseSha: z.string().min(1),
    approvedHeadSha: z.string().min(1),
    expectedTargetSha: z.string().min(1),
    machineId: MachineIdField,
    leaseGeneration: z.number().int().nonnegative(),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    outcome: ShipAttemptOutcome.optional(),
    submittedHeadSha: z.string().min(1),
    testedIntegrationSha: z.string().min(1).optional(),
    landedRefSha: z.string().min(1).optional(),
    destinationSha: z.string().min(1).optional(),
    validationProfileId: z.string().min(1).optional(),
    validationResult: ShipValidationResult.optional(),
  })
  .superRefine((attempt, ctx) => {
    if ((attempt.finishedAt !== undefined) !== (attempt.outcome !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'finishedAt and outcome must be present together',
      })
    }
    if ((attempt.validationProfileId !== undefined) !== (attempt.validationResult !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationProfileId'],
        message: 'validation profile and result must be present together',
      })
    }
  })
export type ShipAttempt = z.infer<typeof ShipAttempt>

export const ShipStepState = z.enum(['planned', 'running', 'succeeded', 'failed', 'cancelled'])
export type ShipStepState = z.infer<typeof ShipStepState>
export const TERMINAL_SHIP_STEP_STATES = ['succeeded', 'failed', 'cancelled'] as const
export const isTerminalShipStepState = (state: ShipStepState): boolean =>
  (TERMINAL_SHIP_STEP_STATES as readonly string[]).includes(state)

export const ShipStepInputFence = z.object({
  sourceBaseSha: z.string().min(1),
  approvedHeadSha: z.string().min(1),
  targetSha: z.string().min(1),
})
export type ShipStepInputFence = z.infer<typeof ShipStepInputFence>

/** One append-only step-journal event. Events sharing `effectKey` describe the
 * planned → running → terminal lifecycle without mutating earlier evidence. */
export const ShipStep = z
  .object({
    id: ShipStepIdField,
    orderId: ShipOrderIdField,
    attemptId: ShipAttemptIdField,
    effectKey: z.string().min(1),
    idempotencyKey: z.string().min(1),
    generation: z.number().int().nonnegative(),
    inputFence: ShipStepInputFence,
    kind: z.string().min(1),
    state: ShipStepState,
    outcome: z.string().min(1).optional(),
    summary: z.string(),
    artifactRef: z.string().min(1).optional(),
    recordedAt: z.string(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
  })
  .superRefine((step, ctx) => {
    const terminal = isTerminalShipStepState(step.state)
    if (step.state === 'planned' && (step.startedAt || step.finishedAt || step.outcome)) {
      ctx.addIssue({ code: 'custom', path: ['state'], message: 'planned steps have not started' })
    }
    if (step.state === 'running' && (!step.startedAt || step.finishedAt || step.outcome)) {
      ctx.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'running steps require startedAt and no terminal fields',
      })
    }
    if (terminal && (!step.startedAt || !step.finishedAt || !step.outcome)) {
      ctx.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'terminal steps require startedAt, finishedAt, and outcome',
      })
    }
  })
export type ShipStep = z.infer<typeof ShipStep>

export const ShipHold = z
  .object({
    id: ShipHoldIdField,
    orderId: ShipOrderIdField,
    generation: z.number().int().positive(),
    reasonCode: ShipHoldCode,
    headline: z.string().min(1),
    detail: z.string(),
    evidenceRefs: z.array(z.string().min(1)),
    actions: z.array(ShipHoldAction).min(1),
    raisedAt: z.string(),
    resolvedAt: z.string().optional(),
    resolution: ShipHoldAction.optional(),
  })
  .superRefine((hold, ctx) => {
    if ((hold.resolvedAt !== undefined) !== (hold.resolution !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['resolvedAt'],
        message: 'resolvedAt and resolution must be present together',
      })
    }
  })
export type ShipHold = z.infer<typeof ShipHold>

export const legalHoldResolutionStates = (
  action: ShipHoldAction,
): readonly Extract<ShipOrderState, 'queued' | 'repairing' | 'cancelled'>[] => {
  if (action === 'retry') return ['queued']
  if (action === 'open-repair') return ['repairing']
  if (action === 'return-to-issue') return ['cancelled']
  return ['queued', 'repairing', 'cancelled']
}

/** Immutable proof belonging to exactly one verified order. There is no global
 * or issue-level latest receipt: consumers follow this row's orderId. */
export const DeliveryReceipt = z.object({
  id: DeliveryReceiptIdField,
  orderId: ShipOrderIdField,
  approvedBaseSha: z.string().min(1),
  approvedHeadSha: z.string().min(1),
  testedIntegrationSha: z.string().min(1),
  landedRefSha: z.string().min(1),
  destinationSha: z.string().min(1),
  validationProfileId: z.string().min(1),
  validationResult: z.literal('passed'),
  destination: z.string().min(1),
  completedAt: z.string(),
})
export type DeliveryReceipt = z.infer<typeof DeliveryReceipt>

export const ShipOrderHumanState = z.enum(['waiting', 'in_progress', 'needs_you', 'shipped'])
export type ShipOrderHumanState = z.infer<typeof ShipOrderHumanState>

export const ReplicatedShipOrderState = ShipOrderState.exclude(['cancelled'])
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
