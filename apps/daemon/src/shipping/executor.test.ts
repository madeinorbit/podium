import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asShipAttemptId, asShipOrderId } from '@podium/model'
import {
  shippingJobRequestFingerprint,
  shippingEvidenceFingerprint,
  type ShippingJobRequestMessage,
  type ShippingJobResult,
} from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { ShippingExecutionPlane } from './executor'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const signRequest = (
  input: Omit<ShippingJobRequestMessage, 'requestDigest'>,
): ShippingJobRequestMessage => {
  const { type: _type, requestId: _requestId, action: _action, ...facts } = input
  return {
    ...input,
    requestDigest: createHash('sha256').update(shippingJobRequestFingerprint(facts)).digest('hex'),
  }
}

const startRequest = (): ShippingJobRequestMessage =>
  signRequest({
    type: 'shippingJobRequest',
    requestId: 'request-start',
    action: 'start',
    jobId: 'attempt-identity:preflight',
    orderId: asShipOrderId('order-identity'),
    attemptId: asShipAttemptId('attempt-identity'),
    generation: 1,
    operation: 'preflight',
    shippingProtocolVersion: 2,
    repoPath: '/repo',
    repoId: 'repo-shipping' as ShippingJobRequestMessage['repoId'],
    sourceBranch: 'issue/identity',
    targetBranch: 'main',
    approvedBaseSha: 'a'.repeat(40),
    approvedHeadSha: 'b'.repeat(40),
    expectedTargetSha: 'a'.repeat(40),
    destination: 'local:main',
    policyId: 'proof-policy',
    validationProfile: {
      id: 'proof',
      argv: ['git', 'diff', '--quiet'],
      cwd: 'integration-root',
      timeoutMs: 30_000,
      resourceLocks: ['validation:proof'],
    },
  })

const resultFor = (
  request: ShippingJobRequestMessage,
  state: ShippingJobResult['state'],
): ShippingJobResult => ({
  jobId: request.jobId,
  requestDigest: request.requestDigest,
  orderId: request.orderId,
  attemptId: request.attemptId,
  machineId: asMachineId('machine-1'),
  generation: request.generation,
  operation: request.operation,
  state,
  classification: 'observed',
  summary: state === 'running' ? 'started' : 'finished',
  logs: [],
  artifactRefs: [],
  heartbeatedAt: '2026-08-13T10:00:00.000Z',
  ...(state === 'running' ? {} : { finishedAt: '2026-08-13T10:00:00.000Z' }),
})

const reorderedControlRequest = (
  request: ShippingJobRequestMessage,
  action: 'status' | 'cancel' | 'acknowledge',
): ShippingJobRequestMessage => {
  const { requestDigest: _requestDigest, ...unsigned } = request
  return signRequest({
    ...unsigned,
    requestId: `request-${action}`,
    action,
    validationProfile: {
      resourceLocks: [...request.validationProfile.resourceLocks],
      timeoutMs: request.validationProfile.timeoutMs,
      cwd: request.validationProfile.cwd,
      argv: [...request.validationProfile.argv],
      id: request.validationProfile.id,
    },
  })
}

const seededPlane = (
  state: ShippingJobResult['state'],
): { plane: ShippingExecutionPlane; request: ShippingJobRequestMessage } => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-shipping-executor-identity-'))
  dirs.push(dir)
  const plane = new ShippingExecutionPlane(dir, asMachineId('machine-1'))
  const request = startRequest()
  plane.journal.begin(request, resultFor(request, state))
  return { plane, request }
}

describe('shipping executor journal request identity', () => {
  it('accepts reordered validation-profile properties for status', () => {
    const { plane, request } = seededPlane('succeeded')
    expect(plane.handle(reorderedControlRequest(request, 'status'))).toMatchObject({
      state: 'succeeded',
      classification: 'observed',
    })
  })

  it('accepts reordered validation-profile properties for cancellation', () => {
    const { plane, request } = seededPlane('running')
    expect(plane.handle(reorderedControlRequest(request, 'cancel'))).toMatchObject({
      state: 'cancelled',
      classification: 'cancelled',
    })
  })

  it('accepts reordered validation-profile properties for acknowledgement', () => {
    const { plane, request } = seededPlane('succeeded')
    expect(plane.handle(reorderedControlRequest(request, 'acknowledge'))).toMatchObject({
      state: 'succeeded',
      classification: 'observed',
    })
    expect(plane.journal.get(request.jobId)?.acknowledgedAt).toBeDefined()
  })

  it('rejects a semantic request drift with its own valid digest', () => {
    const { plane, request } = seededPlane('succeeded')
    const control = reorderedControlRequest(request, 'status')
    const { requestDigest: _requestDigest, ...unsigned } = control
    const drifted = signRequest({
      ...unsigned,
      validationProfile: {
        ...control.validationProfile,
        timeoutMs: control.validationProfile.timeoutMs + 1,
      },
    })

    expect(plane.handle(drifted)).toMatchObject({
      state: 'held',
      classification: 'invalid-request',
      summary: 'shipping status input collision',
    })
  })

  it('rejects a forged request digest', () => {
    const { plane, request } = seededPlane('succeeded')
    const control = reorderedControlRequest(request, 'status')

    expect(plane.handle({ ...control, requestDigest: 'f'.repeat(64) })).toMatchObject({
      state: 'held',
      classification: 'invalid-request',
      summary: 'shipping request digest mismatch',
    })
  })
})

describe('shipping evidence authority', () => {
  const evidenceRef = (request: ShippingJobRequestMessage): string =>
    `artifact://shipping/${createHash('sha256')
      .update(shippingEvidenceFingerprint(request, asMachineId('machine-1'), 0))
      .digest('hex')}`

  it('resolves an opaque log only for its exact effect authority', () => {
    const { plane, request } = seededPlane('succeeded')
    const logPath = join(
      (plane as unknown as { logsDir: string }).logsDir,
      `${createHash('sha256').update(request.jobId).digest('hex')}.log`,
    )
    writeFileSync(logPath, 'validation evidence\n')
    const ref = evidenceRef(request)

    expect(plane.resolveEvidence(request, ref)).toBe(logPath)
    expect(plane.readEvidence(request, ref, 10)).toBe('validation')

    const { requestDigest: _digest, ...unsigned } = request
    const crossOrder = signRequest({
      ...unsigned,
      orderId: asShipOrderId('another-order'),
    })
    const staleGeneration = signRequest({
      ...unsigned,
      generation: request.generation + 1,
    })
    expect(plane.resolveEvidence(crossOrder, ref)).toBeNull()
    expect(plane.resolveEvidence(staleGeneration, ref)).toBeNull()
    expect(plane.readEvidence(crossOrder, ref, 1024)).toBeNull()
  })
})
