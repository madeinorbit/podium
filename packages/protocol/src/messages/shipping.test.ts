import { describe, expect, it } from 'vitest'
import {
  ControlMessage,
  DaemonMessage,
  ShippingTrainExecution,
  ShippingTrainRequest,
  ShippingJobRequestMessage,
  shippingJobRequestMatchesTrain,
  shippingTrainProofsMatch,
  shippingJobRequestFingerprint,
} from '../daemon'

const train = ShippingTrainExecution.parse({
  version: 2 as const,
  capability: 'shipping.train.v2' as const,
  manifest: {
    version: 1 as const,
    id: 'train-1',
    subsetId: 'subset-1',
    repairRound: 0 as const,
    lane: {
      repoId: 'repo-1',
      repoPath: '/repo',
      machineId: 'machine-1',
      laneKey: 'f'.repeat(64),
      laneRevision: 1,
      targetBranch: 'main',
      expectedTargetSha: 'a'.repeat(40),
      destination: 'local:main',
      policyId: 'policy-1',
      validationProfile: {
        id: 'agent',
        argv: ['bun', 'run', 'test'],
        cwd: 'integration-root' as const,
        timeoutMs: 60_000,
        resourceLocks: ['validation:agent'],
      },
      validationProfileDigest: 'e'.repeat(64),
    },
    memberCount: 1,
    leaderOrderId: 'order-1',
    members: [
      {
        orderId: 'order-1',
        issueId: 'issue-1',
        attemptId: 'attempt-1',
        generation: 2,
        machineId: 'machine-1',
        sourceBranch: 'issue/1',
        approvedBaseSha: 'a'.repeat(40),
        approvedHeadSha: 'b'.repeat(40),
        deliveryDependsOn: [],
      },
    ],
  },
  subsetId: 'subset-1',
  memberOrderIds: ['order-1'],
  repairRound: 0,
  candidate: { kind: 'approved' as const },
})

const requestFacts = {
  type: 'shippingJobRequest' as const,
  requestId: 'request-1',
  action: 'start' as const,
  jobId: 'job-1',
  orderId: train.manifest.leaderOrderId,
  attemptId: train.manifest.members[0]!.attemptId,
  generation: 2,
  operation: 'preflight' as const,
  shippingProtocolVersion: 2 as const,
  repoPath: '/repo',
  repoId: train.manifest.lane.repoId,
  sourceBranch: 'issue/1',
  targetBranch: 'main',
  approvedBaseSha: 'a'.repeat(40),
  approvedHeadSha: 'b'.repeat(40),
  expectedTargetSha: 'a'.repeat(40),
  destination: 'local:main',
  policyId: 'policy-1',
  validationProfile: {
    id: 'agent',
    argv: ['bun', 'run', 'test'],
    cwd: 'integration-root' as const,
    timeoutMs: 60_000,
    resourceLocks: ['validation:agent'],
  },
  train,
}
const { type: _type, requestId: _requestId, action: _action, ...fingerprintFacts } = requestFacts
const request = ShippingJobRequestMessage.parse({
  ...requestFacts,
  requestDigest: 'c'.repeat(64),
})

describe('shipping machine protocol', () => {
  it('canonicalizes every immutable request fact without a Node-only hash dependency', () => {
    expect(
      shippingJobRequestFingerprint(
        fingerprintFacts as Parameters<typeof shippingJobRequestFingerprint>[0],
      ),
    ).toBe(
      JSON.stringify({
        jobId: 'job-1',
        orderId: 'order-1',
        attemptId: 'attempt-1',
        generation: 2,
        operation: 'preflight',
        shippingProtocolVersion: 2,
        repoPath: '/repo',
        repoId: 'repo-1',
        sourceBranch: 'issue/1',
        targetBranch: 'main',
        approvedBaseSha: 'a'.repeat(40),
        approvedHeadSha: 'b'.repeat(40),
        expectedTargetSha: 'a'.repeat(40),
        destination: 'local:main',
        policyId: 'policy-1',
        validationProfile: {
          id: 'agent',
          argv: ['bun', 'run', 'test'],
          cwd: 'integration-root',
          timeoutMs: 60_000,
          resourceLocks: ['validation:agent'],
        },
        repair: null,
        train,
        providerRef: null,
      }),
    )
  })

  it('binds an ordered claimed subset and repair identity to the request', () => {
    expect(ShippingTrainExecution.parse(train)).toEqual(train)
    expect(
      ShippingTrainExecution.safeParse({
        ...train,
        memberOrderIds: ['missing-order'],
      }).success,
    ).toBe(false)
    const { capability: _capability, ...olderDaemonTrain } = train
    expect(ShippingTrainExecution.safeParse(olderDaemonTrain).success).toBe(false)
    expect(
      ShippingTrainRequest.safeParse({
        ...train.manifest,
        leaderOrderId: 'order-2',
        members: [
          ...train.manifest.members,
          {
            ...train.manifest.members[0],
            orderId: 'order-2',
            issueId: 'issue-2',
            attemptId: 'attempt-2',
            sourceBranch: 'issue/2',
            deliveryDependsOn: ['order-1'],
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      shippingJobRequestFingerprint({
        ...(fingerprintFacts as Parameters<typeof shippingJobRequestFingerprint>[0]),
        train: {
          ...train,
          repairRound: 1,
          candidate: {
            kind: 'repair',
            contextDigest: 'c'.repeat(64),
            repairRef: 'refs/podium/repairs/attempt-1/1',
            candidateHeadSha: 'd'.repeat(40),
          },
        },
      }),
    ).not.toBe(shippingJobRequestFingerprint(fingerprintFacts as never))
  })

  it('canonicalizes manifest property order and rejects outer leader contradictions', () => {
    const reorderedManifest = {
      members: train.manifest.members,
      leaderOrderId: train.manifest.leaderOrderId,
      lane: train.manifest.lane,
      memberCount: train.manifest.memberCount,
      repairRound: train.manifest.repairRound,
      subsetId: train.manifest.subsetId,
      id: train.manifest.id,
      version: train.manifest.version,
    }
    expect(
      shippingJobRequestFingerprint({
        ...(fingerprintFacts as Parameters<typeof shippingJobRequestFingerprint>[0]),
        train: { ...train, manifest: reorderedManifest },
      }),
    ).toBe(shippingJobRequestFingerprint(fingerprintFacts as never))
    expect(
      shippingJobRequestMatchesTrain(
        ShippingJobRequestMessage.parse({ ...request, orderId: 'other-order' }),
      ),
    ).toBe(false)
    const v1Train = ControlMessage.parse({ ...request, shippingProtocolVersion: 1 })
    if (v1Train.type !== 'shippingJobRequest') throw new Error('expected shipping request')
    expect(shippingJobRequestMatchesTrain(v1Train)).toBe(false)
    const v1Single = ControlMessage.parse({
      ...request,
      shippingProtocolVersion: 1,
      train: undefined,
    })
    if (v1Single.type !== 'shippingJobRequest') throw new Error('expected shipping request')
    expect(shippingJobRequestMatchesTrain(v1Single)).toBe(true)
  })

  it('requires exact ordered member identities and phase-complete verified proofs', () => {
    const verifyRequest = ControlMessage.parse({
      ...request,
      operation: 'verify',
      jobId: 'attempt-1:verify',
    })
    if (verifyRequest.type !== 'shippingJobRequest') throw new Error('expected shipping request')
    const proof = {
      issueId: 'issue-1' as (typeof train.manifest.members)[number]['issueId'],
      orderId: 'order-1' as (typeof train.manifest.members)[number]['orderId'],
      attemptId: 'attempt-1' as (typeof train.manifest.members)[number]['attemptId'],
      generation: 2,
      sourceApprovedSha: 'b'.repeat(40),
      resultCommitSha: 'd'.repeat(40),
      testedIntegrationSha: 'd'.repeat(40),
      landedRefSha: 'd'.repeat(40),
      providerLandedRefSha: 'd'.repeat(40),
      destinationSha: 'd'.repeat(40),
    }
    const result = DaemonMessage.parse({
      type: 'shippingJobResult',
      requestId: 'request-1',
      jobId: verifyRequest.jobId,
      requestDigest: verifyRequest.requestDigest,
      orderId: verifyRequest.orderId,
      attemptId: verifyRequest.attemptId,
      machineId: 'machine-1',
      generation: verifyRequest.generation,
      operation: 'verify',
      state: 'succeeded',
      classification: 'proved',
      summary: 'verified',
      observedDestinationSha: 'd'.repeat(40),
      testedIntegrationSha: 'd'.repeat(40),
      landedRefSha: 'd'.repeat(40),
      validationProfileId: 'agent',
      validationResult: 'passed',
      trainProofs: [proof],
      logs: [],
      artifactRefs: [],
      heartbeatedAt: '2026-08-13T10:00:00.000Z',
      finishedAt: '2026-08-13T10:00:00.000Z',
    })
    if (result.type !== 'shippingJobResult') throw new Error('expected shipping result')
    expect(shippingTrainProofsMatch(verifyRequest, result)).toBe(true)
    expect(shippingTrainProofsMatch(verifyRequest, { ...result, trainProofs: [] })).toBe(false)
    expect(
      shippingTrainProofsMatch(verifyRequest, {
        ...result,
        trainProofs: [{ ...proof, attemptId: 'substituted-attempt' as typeof proof.attemptId }],
      }),
    ).toBe(false)
    const { destinationSha: _destinationSha, ...incompleteProof } = proof
    expect(
      shippingTrainProofsMatch(verifyRequest, {
        ...result,
        trainProofs: [incompleteProof],
      }),
    ).toBe(false)
  })

  it('round-trips the purpose-built request and result frames', () => {
    expect(ControlMessage.parse(request)).toEqual(request)
    expect(
      DaemonMessage.parse({
        type: 'shippingJobResult',
        requestId: 'request-1',
        jobId: 'job-1',
        requestDigest: request.requestDigest,
        orderId: 'order-1',
        attemptId: 'attempt-1',
        machineId: 'machine-1',
        generation: 2,
        operation: 'preflight',
        state: 'succeeded',
        classification: 'observed',
        summary: 'fences match',
        logs: [],
        artifactRefs: [],
        heartbeatedAt: '2026-08-13T10:00:00.000Z',
        finishedAt: '2026-08-13T10:00:00.000Z',
      }).type,
    ).toBe('shippingJobResult')
  })

  it('refuses generic command payloads instead of stripping them', () => {
    expect(ControlMessage.safeParse({ ...request, shell: 'git push --force' }).success).toBe(false)
    expect(ControlMessage.safeParse({ ...request, argv: ['sh', '-c', 'git merge'] }).success).toBe(
      false,
    )
  })
})
