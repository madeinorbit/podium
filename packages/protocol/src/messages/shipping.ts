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
  'prepare-merge-group',
  'validate',
  'commit-merge-group',
  'publish',
  'verify',
])
export type ShippingJobOperation = z.infer<typeof ShippingJobOperation>

/** A trusted, named repository policy profile. The command is resolved by the
 * server; no argv or resource name comes from the ship-order command. */
export const ShippingValidationProfile = ShipTrainValidationProfile
export type ShippingValidationProfile = z.infer<typeof ShippingValidationProfile>

export const ShippingTrainExecution = z
  .object({
    version: z.literal(2),
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
    if (
      (execution.candidate.kind === 'approved') !==
      (execution.repairRound === 0)
    ) {
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

/** Raw manifests remain parseable for existing journal entries. New effects
 * use ShippingTrainExecution so subset and repair identity are immutable
 * journal facts; the executor rejects legacy multi-member dispatches. */
export const ShippingTrainRequest = z.union([ShipTrainManifest, ShippingTrainExecution])
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
    shippingProtocolVersion: z.literal(2),
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
    train: ShippingTrainRequest.optional(),
    providerRef: ProviderPullRequestRef.optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (!request.train) return
    const manifest = 'manifest' in request.train ? request.train.manifest : request.train
    const leader = manifest.members.at(-1)
    const equalJson = (left: unknown, right: unknown): boolean =>
      JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
    const contradictions: [boolean, (string | number)[], string][] = [
      [request.orderId !== manifest.leaderOrderId, ['orderId'], 'outer order must be train leader'],
      [request.orderId !== leader?.orderId, ['orderId'], 'outer order must be final member'],
      [request.attemptId !== leader?.attemptId, ['attemptId'], 'outer attempt must be leader custody'],
      [request.generation !== leader?.generation, ['generation'], 'outer generation must be leader custody'],
      [request.sourceBranch !== leader?.sourceBranch, ['sourceBranch'], 'outer source must be leader source'],
      [request.approvedBaseSha !== leader?.approvedBaseSha, ['approvedBaseSha'], 'outer base must match leader'],
      [request.approvedHeadSha !== leader?.approvedHeadSha, ['approvedHeadSha'], 'outer head must match leader'],
      [request.repoId !== manifest.lane.repoId, ['repoId'], 'outer repository must match train lane'],
      [request.targetBranch !== manifest.lane.targetBranch, ['targetBranch'], 'outer target must match train lane'],
      [request.expectedTargetSha !== manifest.lane.expectedTargetSha, ['expectedTargetSha'], 'outer target SHA must match train lane'],
      [canonicalShippingDestination(request.destination, request.targetBranch) !== manifest.lane.destination, ['destination'], 'outer destination must match train lane'],
      [request.policyId !== manifest.lane.policyId, ['policyId'], 'outer policy must match train lane'],
      [!equalJson(request.providerRef, manifest.lane.providerRef), ['providerRef'], 'outer provider must match train lane'],
      [!equalJson(request.validationProfile, manifest.lane.validationProfile), ['validationProfile'], 'outer validation must match train lane'],
    ]
    for (const [contradiction, path, message] of contradictions) {
      if (contradiction) ctx.addIssue({ code: 'custom', path, message })
    }
  })
export type ShippingJobRequestMessage = z.infer<typeof ShippingJobRequestMessage>

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
    destination: input.destination,
    policyId: input.policyId,
    validationProfile: {
      id: input.validationProfile.id,
      argv: [...input.validationProfile.argv],
      cwd: input.validationProfile.cwd,
      timeoutMs: input.validationProfile.timeoutMs,
      resourceLocks: [...input.validationProfile.resourceLocks],
    },
    train: input.train
      ? 'manifest' in input.train
        ? {
            version: input.train.version,
            manifest: JSON.parse(serializeShipTrainManifest(input.train.manifest)),
            subsetId: input.train.subsetId,
            memberOrderIds: [...input.train.memberOrderIds],
            repairRound: input.train.repairRound,
            candidate: input.train.candidate,
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
  if (!request.train) return result.trainProofs === undefined
  const manifest = 'manifest' in request.train ? request.train.manifest : request.train
  const proofs = result.trainProofs
  if (!proofs || proofs.length !== manifest.members.length) return false
  const identitiesMatch = manifest.members.every((member, index) => {
    const proof = proofs[index]
    return (
      proof?.issueId === member.issueId &&
      proof.orderId === member.orderId &&
      proof.attemptId === member.attemptId &&
      proof.generation === member.generation &&
      proof.sourceApprovedSha === member.approvedHeadSha
    )
  })
  if (!identitiesMatch) return false
  if (request.operation === 'preflight') return true
  if (proofs.some((proof) => !proof.resultCommitSha)) return false
  if (request.operation === 'prepare-merge-group') return true
  if (proofs.some((proof) => !proof.testedIntegrationSha)) return false
  if (request.operation === 'validate') return true
  if (proofs.some((proof) => !proof.landedRefSha)) return false
  if (request.operation === 'commit-merge-group') return true
  if (proofs.some((proof) => !proof.providerLandedRefSha)) return false
  if (request.operation === 'publish') return true
  return proofs.every((proof) => Boolean(proof.destinationSha))
}

export const ShippingJobResultMessage = ShippingJobResult.extend({
  type: z.literal('shippingJobResult'),
  requestId: z.string().min(1),
})
export type ShippingJobResultMessage = z.infer<typeof ShippingJobResultMessage>
