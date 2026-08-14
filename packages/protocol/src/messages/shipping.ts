import {
  canonicalShippingDestination,
  IssueIdField,
  MachineIdField,
  ProviderPullRequestRef,
  RepoIdField,
  serializeShipTrainManifest,
  ShipAttemptIdField,
  ShipOrderIdField,
  ShipTrainManifest,
  ShipTrainSubsetIdField,
  ShipTrainValidationProfile,
} from '@podium/model'
import { z } from 'zod'

export const ShippingJobAction = z.enum(['start', 'status', 'cancel', 'acknowledge'])
export type ShippingJobAction = z.infer<typeof ShippingJobAction>

export const ShippingJobOperation = z.enum([
  'preflight',
  'apply-repair',
  'prepare-merge-group',
  'validate',
  'commit-merge-group',
  'publish',
  'verify',
])
export type ShippingJobOperation = z.infer<typeof ShippingJobOperation>

export const ShippingRepairCandidate = z
  .object({
    round: z.number().int().positive(),
    repairRef: z.string().min(1),
    candidateHeadSha: z.string().min(1),
  })
  .strict()
export type ShippingRepairCandidate = z.infer<typeof ShippingRepairCandidate>

/** A trusted, named repository policy profile. The command is resolved by the
 * server; no argv or resource name comes from the ship-order command. */
export const ShippingValidationProfile = ShipTrainValidationProfile
export type ShippingValidationProfile = z.infer<typeof ShippingValidationProfile>

export const SHIPPING_TRAIN_CAPABILITY = 'shipping.train.v2' as const

export const ShippingTrainExecution = z
  .object({
    version: z.literal(2),
    capability: z.literal(SHIPPING_TRAIN_CAPABILITY),
    manifest: ShipTrainManifest,
    subsetId: ShipTrainSubsetIdField,
    memberOrderIds: z.array(ShipOrderIdField).min(1),
    repairRound: z.number().int().nonnegative(),
    candidate: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('approved') }).strict(),
      z
        .object({
          kind: z.literal('repair'),
          repairRef: z.string().min(1),
          candidateHeadSha: z.string().min(1),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((execution, ctx) => {
    if ((execution.candidate.kind === 'approved') !== (execution.repairRound === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['candidate'],
        message: 'approved candidates are repair round zero; repaired candidates are later rounds',
      })
    }
    if (new Set(execution.memberOrderIds).size !== execution.memberOrderIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['memberOrderIds'],
        message: 'execution subset members must be unique',
      })
    }
    const manifestIndexes = new Map(
      execution.manifest.members.map((member, index) => [member.orderId, index] as const),
    )
    let previousIndex = -1
    for (const [index, orderId] of execution.memberOrderIds.entries()) {
      const manifestIndex = manifestIndexes.get(orderId)
      if (manifestIndex === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['memberOrderIds', index],
          message: 'execution subset member is absent from the claimed manifest',
        })
      } else if (manifestIndex <= previousIndex) {
        ctx.addIssue({
          code: 'custom',
          path: ['memberOrderIds', index],
          message: 'execution subset must preserve canonical manifest order',
        })
      } else {
        previousIndex = manifestIndex
      }
    }
  })
export type ShippingTrainExecution = z.infer<typeof ShippingTrainExecution>

/** Canonical preimage for subsetId. Hash these bytes with SHA-256 and prefix
 * the hex digest with `subset:`; candidate key order is never caller-defined. */
export const shippingTrainSubsetFingerprint = (execution: {
  manifest: { id: string }
  memberOrderIds: z.infer<typeof ShipOrderIdField>[]
  repairRound: number
  candidate: z.infer<typeof ShippingTrainExecution>['candidate']
}): string =>
  JSON.stringify({
    manifestId: execution.manifest.id,
    memberOrderIds: [...execution.memberOrderIds],
    repairRound: execution.repairRound,
    candidate:
      execution.candidate.kind === 'approved'
        ? { kind: 'approved' }
        : {
            kind: 'repair',
            repairRef: execution.candidate.repairRef,
            candidateHeadSha: execution.candidate.candidateHeadSha,
          },
  })

/** Raw manifests remain parseable for existing journal entries. New effects
 * use ShippingTrainExecution so subset and repair identity are immutable
 * journal facts; the executor rejects legacy multi-member dispatches. */
const LegacySingleOrderTrain = ShipTrainManifest.refine(
  (manifest) => manifest.members.length === 1,
  {
    message: 'raw train manifests are legacy single-order requests only',
  },
)
export const ShippingTrainRequest = z.union([LegacySingleOrderTrain, ShippingTrainExecution])
export type ShippingTrainRequest = z.infer<typeof ShippingTrainRequest>

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
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    orderId: ShipOrderIdField,
    attemptId: ShipAttemptIdField,
    generation: z.number().int().nonnegative(),
    operation: ShippingJobOperation,
    shippingProtocolVersion: z.union([z.literal(1), z.literal(2)]),
    repoPath: z.string().min(1),
    repoId: RepoIdField,
    sourceBranch: z.string().min(1),
    targetBranch: z.string().min(1),
    approvedBaseSha: z.string().min(1),
    approvedHeadSha: z.string().min(1),
    expectedTargetSha: z.string().min(1),
    destination: z.string().min(1),
    policyId: z.string().min(1),
    validationProfile: ShippingValidationProfile,
    repair: ShippingRepairCandidate.optional(),
    train: ShippingTrainRequest.optional(),
    providerRef: ProviderPullRequestRef.optional(),
  })
  .strict()
export type ShippingJobRequestMessage = z.infer<typeof ShippingJobRequestMessage>

/** Cross-field authority fence kept separate from the object-shaped wire
 * schema so this message remains usable in discriminated unions and `.omit`. */
export const shippingJobRequestMatchesTrain = (request: ShippingJobRequestMessage): boolean => {
  if (!request.train) return true
  if ('manifest' in request.train && request.shippingProtocolVersion !== 2) return false
  const manifest = 'manifest' in request.train ? request.train.manifest : request.train
  const leader = manifest.members.at(-1)
  if (!leader) return false
  const equalJson = (left: unknown, right: unknown): boolean =>
    JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
  const trainRepair =
    'manifest' in request.train && request.train.candidate.kind === 'repair'
      ? {
          round: request.train.repairRound,
          repairRef: request.train.candidate.repairRef,
          candidateHeadSha: request.train.candidate.candidateHeadSha,
        }
      : undefined
  return (
    request.orderId === manifest.leaderOrderId &&
    request.orderId === leader.orderId &&
    request.attemptId === leader.attemptId &&
    request.generation === leader.generation &&
    request.sourceBranch === leader.sourceBranch &&
    request.approvedBaseSha === leader.approvedBaseSha &&
    request.approvedHeadSha === leader.approvedHeadSha &&
    request.repoId === manifest.lane.repoId &&
    request.repoPath === manifest.lane.repoPath &&
    request.targetBranch === manifest.lane.targetBranch &&
    request.expectedTargetSha === manifest.lane.expectedTargetSha &&
    canonicalShippingDestination(request.destination, request.targetBranch) ===
      manifest.lane.destination &&
    request.policyId === manifest.lane.policyId &&
    equalJson(request.providerRef, manifest.lane.providerRef) &&
    equalJson(request.validationProfile, manifest.lane.validationProfile) &&
    equalJson(request.repair, trainRepair)
  )
}

/** Canonical bytes hashed by server and daemon. Transport correlation/action
 * are excluded; every immutable effect input is included. */
export function shippingJobRequestFingerprint(
  input: Omit<ShippingJobRequestMessage, 'type' | 'requestId' | 'action' | 'requestDigest'>,
): string {
  return JSON.stringify({
    jobId: input.jobId,
    orderId: input.orderId,
    attemptId: input.attemptId,
    generation: input.generation,
    operation: input.operation,
    shippingProtocolVersion: input.shippingProtocolVersion,
    repoPath: input.repoPath,
    repoId: input.repoId,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    approvedBaseSha: input.approvedBaseSha,
    approvedHeadSha: input.approvedHeadSha,
    expectedTargetSha: input.expectedTargetSha,
    destination: canonicalShippingDestination(input.destination, input.targetBranch),
    policyId: input.policyId,
    validationProfile: {
      id: input.validationProfile.id,
      argv: [...input.validationProfile.argv],
      cwd: input.validationProfile.cwd,
      timeoutMs: input.validationProfile.timeoutMs,
      resourceLocks: [...input.validationProfile.resourceLocks].sort(),
    },
    repair: input.repair
      ? {
          round: input.repair.round,
          repairRef: input.repair.repairRef,
          candidateHeadSha: input.repair.candidateHeadSha,
        }
      : null,
    train: input.train
      ? 'manifest' in input.train
        ? {
            version: input.train.version,
            capability: input.train.capability,
            manifest: JSON.parse(serializeShipTrainManifest(input.train.manifest)),
            subsetId: input.train.subsetId,
            memberOrderIds: [...input.train.memberOrderIds],
            repairRound: input.train.repairRound,
            candidate:
              input.train.candidate.kind === 'approved'
                ? { kind: 'approved' }
                : {
                    kind: 'repair',
                    repairRef: input.train.candidate.repairRef,
                    candidateHeadSha: input.train.candidate.candidateHeadSha,
                  },
          }
        : JSON.parse(serializeShipTrainManifest(input.train))
      : null,
    providerRef: input.providerRef
      ? {
          provider: input.providerRef.provider,
          id: input.providerRef.id,
          url: input.providerRef.url ?? null,
        }
      : null,
  })
}

/** Opaque evidence identity for one daemon materialization. The digest binds
 * repository custody, order/attempt/generation, manifest/subset (when any),
 * machine, operation and the complete immutable effect request without
 * exposing the daemon-native path. */
export function shippingEvidenceFingerprint(
  request: ShippingJobRequestMessage,
  machineId: z.infer<typeof MachineIdField>,
  ordinal: number,
): string {
  const train = request.train && 'manifest' in request.train ? request.train : undefined
  return JSON.stringify({
    version: 1,
    machineId,
    repoId: request.repoId,
    repoPath: request.repoPath,
    orderId: request.orderId,
    attemptId: request.attemptId,
    generation: request.generation,
    manifestId: train?.manifest.id ?? null,
    subsetId: train?.subsetId ?? null,
    operation: request.operation,
    requestDigest: request.requestDigest,
    ordinal,
  })
}

export const ShippingJobState = z.enum(['running', 'succeeded', 'held', 'cancelled'])
export type ShippingJobState = z.infer<typeof ShippingJobState>

export const ShippingJobClassification = z.enum([
  'observed',
  'proved',
  'source-moved',
  'target-moved',
  'dirty-worktree',
  'wrong-target-checkout',
  'merge-conflict',
  'validation-failed',
  'publish-rejected',
  'provider-failed',
  'unsupported-destination-effect',
  'destination-mismatch',
  'stale-generation',
  'cancelled',
  'invalid-request',
])
export type ShippingJobClassification = z.infer<typeof ShippingJobClassification>

export const ShippingJobResult = z.object({
  jobId: z.string().min(1),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
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
  testedIntegrationSha: z.string().min(1).optional(),
  landedRefSha: z.string().min(1).optional(),
  validationProfileId: z.string().min(1).optional(),
  validationResult: z.enum(['passed', 'failed']).optional(),
  trainProofs: z
    .array(
      z
        .object({
          issueId: IssueIdField,
          orderId: ShipOrderIdField,
          attemptId: ShipAttemptIdField,
          generation: z.number().int().positive(),
          sourceApprovedSha: z.string().min(1),
          resultCommitSha: z.string().min(1).optional(),
          testedIntegrationSha: z.string().min(1).optional(),
          landedRefSha: z.string().min(1).optional(),
          providerLandedRefSha: z.string().min(1).optional(),
          destinationSha: z.string().min(1).optional(),
        })
        .strict(),
    )
    .optional(),
  logs: z.array(z.string()),
  artifactRefs: z.array(z.string()),
  heartbeatedAt: z.string(),
  finishedAt: z.string().optional(),
})
export type ShippingJobResult = z.infer<typeof ShippingJobResult>

/** Exact request/result membership equality plus phase-appropriate proof
 * completeness. Receipt settlement calls this on a verified result. */
export const shippingTrainProofsMatch = (
  request: ShippingJobRequestMessage,
  result: ShippingJobResult,
): boolean => {
  if (
    result.jobId !== request.jobId ||
    result.requestDigest !== request.requestDigest ||
    result.orderId !== request.orderId ||
    result.attemptId !== request.attemptId ||
    result.generation !== request.generation ||
    result.operation !== request.operation
  ) {
    return false
  }
  if (request.operation === 'apply-repair') {
    return (
      result.trainProofs === undefined &&
      Boolean(request.repair) &&
      result.testedIntegrationSha === request.repair?.candidateHeadSha
    )
  }
  if (!request.train) return result.trainProofs === undefined
  const manifest = 'manifest' in request.train ? request.train.manifest : request.train
  const provedMembers =
    'manifest' in request.train
      ? request.train.memberOrderIds.map((orderId) =>
          manifest.members.find((member) => member.orderId === orderId),
        )
      : manifest.members
  const proofs = result.trainProofs
  if (
    provedMembers.some((member) => !member) ||
    !proofs ||
    proofs.length !== provedMembers.length
  ) {
    return false
  }
  const identitiesMatch = provedMembers.every((member, index) => {
    const proof = proofs[index]
    return (
      proof?.issueId === member!.issueId &&
      proof.orderId === member!.orderId &&
      proof.attemptId === member!.attemptId &&
      proof.generation === member!.generation &&
      proof.sourceApprovedSha === member!.approvedHeadSha
    )
  })
  if (!identitiesMatch) return false
  if (request.operation === 'preflight') return true
  if (proofs.some((proof) => !proof.resultCommitSha)) return false
  if (request.operation === 'prepare-merge-group') {
    return 'manifest' in request.train && request.train.candidate.kind === 'repair'
      ? result.testedIntegrationSha === request.train.candidate.candidateHeadSha
      : proofs.at(-1)?.resultCommitSha === result.testedIntegrationSha
  }
  if (
    !result.testedIntegrationSha ||
    proofs.some((proof) => proof.testedIntegrationSha !== result.testedIntegrationSha)
  ) {
    return false
  }
  if (request.operation === 'validate') {
    return (
      result.validationProfileId === request.validationProfile.id &&
      result.validationResult === 'passed'
    )
  }
  if (
    result.validationProfileId !== request.validationProfile.id ||
    result.validationResult !== 'passed'
  ) {
    return false
  }
  if (request.operation === 'commit-merge-group') {
    return (
      Boolean(result.landedRefSha) &&
      proofs.every((proof) => proof.landedRefSha === result.landedRefSha)
    )
  }
  const landedRefs = new Set(proofs.map((proof) => proof.landedRefSha))
  if (landedRefs.size !== 1 || landedRefs.has(undefined)) return false
  if (
    !result.landedRefSha ||
    proofs.some((proof) => proof.providerLandedRefSha !== result.landedRefSha)
  ) {
    return false
  }
  if (request.operation === 'publish') return true
  return (
    Boolean(result.observedDestinationSha) &&
    proofs.every((proof) => proof.destinationSha === result.observedDestinationSha)
  )
}

export const ShippingJobResultMessage = ShippingJobResult.extend({
  type: z.literal('shippingJobResult'),
  requestId: z.string().min(1),
})
export type ShippingJobResultMessage = z.infer<typeof ShippingJobResultMessage>
