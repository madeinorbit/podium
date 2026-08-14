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
  ShipTrainIdField,
  ShipTrainSubsetIdField,
} from './ids'
import { ShipHoldAction, ShipHoldCode } from './shipping-projection'

export {
  ReplicatedShipOrderState,
  ShipHoldAction,
  ShipHoldCode,
  ShipOrderActivity,
  ShipOrderHumanState,
  ShipOrderProjection,
} from './shipping-projection'

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

export const DescendantTip = z.object({
  issueId: IssueIdField,
  approvedHeadSha: z.string().min(1),
})
export type DescendantTip = z.infer<typeof DescendantTip>

export const ProviderPullRequestRef = z
  .object({
    provider: z.string().min(1),
    id: z.string().min(1),
    url: z.string().min(1).optional(),
  })
  .strict()
export type ProviderPullRequestRef = z.infer<typeof ProviderPullRequestRef>

export const ShipTrainValidationProfile = z
  .object({
    id: z.string().min(1),
    argv: z.array(z.string().min(1)).min(1),
    cwd: z.literal('integration-root'),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(60 * 60 * 1000),
    resourceLocks: z.array(z.string().min(1)),
  })
  .strict()
export type ShipTrainValidationProfile = z.infer<typeof ShipTrainValidationProfile>

export const canonicalShippingDestination = (
  destination: string,
  targetBranch: string,
): string => {
  if (
    destination === targetBranch ||
    destination === `local:${targetBranch}` ||
    destination === `refs/heads/${targetBranch}`
  ) {
    return `local:${targetBranch}`
  }
  const remote = /^(?:remote|git):([A-Za-z0-9][A-Za-z0-9._-]*)\/(.+)$/.exec(destination)
  return remote ? `git:${remote[1]}/${remote[2]}` : destination
}

export const ShipTrainLane = z
  .object({
    repoId: RepoIdField,
    repoPath: z.string().min(1),
    machineId: MachineIdField,
    targetBranch: z.string().min(1),
    expectedTargetSha: z.string().min(1),
    destination: z.string().min(1),
    providerRef: ProviderPullRequestRef.optional(),
    policyId: z.string().min(1),
    validationProfile: ShipTrainValidationProfile,
    validationProfileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((lane, ctx) => {
    if (lane.destination !== canonicalShippingDestination(lane.destination, lane.targetBranch)) {
      ctx.addIssue({
        code: 'custom',
        path: ['destination'],
        message: 'train destination must use its canonical lane spelling',
      })
    }
    if ([...lane.validationProfile.resourceLocks].sort().join('\0') !== lane.validationProfile.resourceLocks.join('\0')) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationProfile', 'resourceLocks'],
        message: 'train validation resource locks must be canonically sorted',
      })
    }
    if (
      new Set(lane.validationProfile.resourceLocks).size !==
      lane.validationProfile.resourceLocks.length
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['validationProfile', 'resourceLocks'],
        message: 'train validation resource locks must be unique',
      })
    }
  })
export type ShipTrainLane = z.infer<typeof ShipTrainLane>

export const ShipTrainMember = z
  .object({
    orderId: ShipOrderIdField,
    issueId: IssueIdField,
    attemptId: ShipAttemptIdField,
    generation: z.number().int().positive(),
    machineId: MachineIdField,
    sourceBranch: z.string().min(1),
    approvedBaseSha: z.string().min(1),
    approvedHeadSha: z.string().min(1),
    deliveryDependsOn: z.array(ShipOrderIdField),
  })
  .strict()
export type ShipTrainMember = z.infer<typeof ShipTrainMember>

export const ShipTrainManifest = z
  .object({
    version: z.literal(1),
    id: ShipTrainIdField,
    subsetId: ShipTrainSubsetIdField,
    repairRound: z.literal(0),
    lane: ShipTrainLane,
    leaderOrderId: ShipOrderIdField,
    members: z.array(ShipTrainMember).min(1),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.members.at(-1)?.orderId !== manifest.leaderOrderId) {
      ctx.addIssue({
        code: 'custom',
        path: ['leaderOrderId'],
        message: 'train leader must be the final ordered member',
      })
    }
    if (new Set(manifest.members.map((member) => member.orderId)).size !== manifest.members.length) {
      ctx.addIssue({ code: 'custom', path: ['members'], message: 'train members must be unique' })
    }
    if (
      new Set(manifest.members.map((member) => member.attemptId)).size !== manifest.members.length
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['members'],
        message: 'train attempt custody must be unique',
      })
    }
    if (new Set(manifest.members.map((member) => member.issueId)).size !== manifest.members.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['members'],
        message: 'train member issues must be unique',
      })
    }
    if (
      new Set(manifest.members.map((member) => member.sourceBranch)).size !==
      manifest.members.length
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['members'],
        message: 'train member source branches must be unique',
      })
    }
    if (new Set(manifest.members.map((member) => member.machineId)).size !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['members'],
        message: 'train members must share one machine custody owner',
      })
    }
    const indexByOrder = new Map(
      manifest.members.map((member, index) => [member.orderId, index] as const),
    )
    for (const [index, member] of manifest.members.entries()) {
      if (member.approvedBaseSha !== manifest.lane.expectedTargetSha) {
        ctx.addIssue({
          code: 'custom',
          path: ['members', index, 'approvedBaseSha'],
          message: 'train member approval base must match the frozen target',
        })
      }
      if (new Set(member.deliveryDependsOn).size !== member.deliveryDependsOn.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['members', index, 'deliveryDependsOn'],
          message: 'train member dependencies must be unique',
        })
      }
      if (
        [...member.deliveryDependsOn].sort().join('\0') !== member.deliveryDependsOn.join('\0')
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['members', index, 'deliveryDependsOn'],
          message: 'train member dependencies must be canonically sorted',
        })
      }
      for (const dependency of member.deliveryDependsOn) {
        const dependencyIndex = indexByOrder.get(dependency)
        if (dependencyIndex !== undefined && dependencyIndex >= index) {
          ctx.addIssue({
            code: 'custom',
            path: ['members', index, 'deliveryDependsOn'],
            message: 'train member dependencies must precede their dependent',
          })
        }
      }
      if (index > 0 && !member.deliveryDependsOn.includes(manifest.members[index - 1]!.orderId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['members', index, 'deliveryDependsOn'],
          message: 'each train member must directly follow its canonical predecessor',
        })
      }
      if (member.machineId !== manifest.lane.machineId) {
        ctx.addIssue({
          code: 'custom',
          path: ['members', index, 'machineId'],
          message: 'train member custody must match the lane machine',
        })
      }
    }
  })
export type ShipTrainManifest = z.infer<typeof ShipTrainManifest>

/** Stable canonical bytes for durable equality and hashing. Input object key
 * order is deliberately ignored; array order remains semantic. */
export const serializeShipTrainManifest = (input: ShipTrainManifest): string => {
  const manifest = ShipTrainManifest.parse(input)
  return JSON.stringify({
    version: manifest.version,
    id: manifest.id,
    subsetId: manifest.subsetId,
    repairRound: manifest.repairRound,
    lane: {
      repoId: manifest.lane.repoId,
      repoPath: manifest.lane.repoPath,
      machineId: manifest.lane.machineId,
      targetBranch: manifest.lane.targetBranch,
      expectedTargetSha: manifest.lane.expectedTargetSha,
      destination: manifest.lane.destination,
      ...(manifest.lane.providerRef
        ? {
            providerRef: {
              provider: manifest.lane.providerRef.provider,
              id: manifest.lane.providerRef.id,
              ...(manifest.lane.providerRef.url ? { url: manifest.lane.providerRef.url } : {}),
            },
          }
        : {}),
      policyId: manifest.lane.policyId,
      validationProfile: {
        id: manifest.lane.validationProfile.id,
        argv: [...manifest.lane.validationProfile.argv],
        cwd: manifest.lane.validationProfile.cwd,
        timeoutMs: manifest.lane.validationProfile.timeoutMs,
        resourceLocks: [...manifest.lane.validationProfile.resourceLocks],
      },
      validationProfileDigest: manifest.lane.validationProfileDigest,
    },
    leaderOrderId: manifest.leaderOrderId,
    members: manifest.members.map((member) => ({
      orderId: member.orderId,
      issueId: member.issueId,
      attemptId: member.attemptId,
      generation: member.generation,
      machineId: member.machineId,
      sourceBranch: member.sourceBranch,
      approvedBaseSha: member.approvedBaseSha,
      approvedHeadSha: member.approvedHeadSha,
      deliveryDependsOn: [...member.deliveryDependsOn],
    })),
  })
}

const descendantTipKey = (tip: DescendantTip): string => `${tip.issueId}\0${tip.approvedHeadSha}`

export const descendantTipsMatch = (
  left: readonly DescendantTip[],
  right: readonly DescendantTip[],
): boolean => {
  if (left.length !== right.length) return false
  const a = left.map(descendantTipKey).sort()
  const b = right.map(descendantTipKey).sort()
  return a.every((key, index) => key === b[index])
}

/** Admission proof that an approved root tip currently contains exactly these
 * descendant integrations. Distinct from DeliveryReceipt, which is post-land
 * destination proof. */
export const RootIntegrationReceipt = z.object({
  rootIssueId: IssueIdField,
  approvedHeadSha: z.string().min(1),
  descendants: z.array(DescendantTip),
})
export type RootIntegrationReceipt = z.infer<typeof RootIntegrationReceipt>

export const integrationReceiptMatchesOrder = (
  receipt: RootIntegrationReceipt,
  input: {
    issueId: string
    approvedHeadSha: string
    descendantManifest: readonly DescendantTip[]
  },
): boolean =>
  receipt.rootIssueId === input.issueId &&
  receipt.approvedHeadSha === input.approvedHeadSha &&
  descendantTipsMatch(receipt.descendants, input.descendantManifest)

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
    evidenceManifestRef: z.string().min(1).optional(),
    currentIntegrationReceipt: RootIntegrationReceipt.optional(),
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
    if (order.descendantManifest.length > 0 && order.currentIntegrationReceipt === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['currentIntegrationReceipt'],
        message: 'currentIntegrationReceipt is required when descendantManifest is non-empty',
      })
    }
    if (
      order.currentIntegrationReceipt !== undefined &&
      !integrationReceiptMatchesOrder(order.currentIntegrationReceipt, order)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['currentIntegrationReceipt'],
        message: 'currentIntegrationReceipt must bind approvedHeadSha to the descendant manifest',
      })
    }
  })
export type ShipOrder = z.infer<typeof ShipOrder>

const LEGAL_SHIP_ORDER_TRANSITIONS = {
  queued: ['preflight', 'held', 'cancelled'],
  preflight: ['composing', 'held', 'cancelled'],
  composing: ['validating', 'repairing', 'held', 'cancelled'],
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
