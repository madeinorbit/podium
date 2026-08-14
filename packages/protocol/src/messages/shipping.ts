import {
  MachineIdField,
  ProviderPullRequestRef,
  ShipAttemptIdField,
  ShipOrderIdField,
  ShipTrainManifest,
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
export const ShippingValidationProfile = z
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
export type ShippingValidationProfile = z.infer<typeof ShippingValidationProfile>

export const ShippingTrainExecution = z
  .object({
    version: z.literal(1),
    manifest: ShipTrainManifest,
    subsetId: z.string().min(1),
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
    repoPath: z.string().min(1),
    sourceBranch: z.string().min(1),
    targetBranch: z.string().min(1),
    approvedBaseSha: z.string().min(1),
    approvedHeadSha: z.string().min(1),
    expectedTargetSha: z.string().min(1),
    destination: z.string().min(1),
    validationProfile: ShippingValidationProfile,
    train: ShippingTrainRequest.optional(),
    providerRef: ProviderPullRequestRef.optional(),
  })
  .strict()
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
    repoPath: input.repoPath,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
    approvedBaseSha: input.approvedBaseSha,
    approvedHeadSha: input.approvedHeadSha,
    expectedTargetSha: input.expectedTargetSha,
    destination: input.destination,
    validationProfile: {
      id: input.validationProfile.id,
      argv: [...input.validationProfile.argv],
      cwd: input.validationProfile.cwd,
      timeoutMs: input.validationProfile.timeoutMs,
      resourceLocks: [...input.validationProfile.resourceLocks],
    },
    train: input.train ?? null,
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
      z.object({
        orderId: ShipOrderIdField,
        approvedHeadSha: z.string().min(1),
        landedRefSha: z.string().min(1),
      }),
    )
    .optional(),
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
