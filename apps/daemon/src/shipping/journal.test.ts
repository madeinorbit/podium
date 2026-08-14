import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asShipAttemptId, asShipOrderId } from '@podium/model'
import {
  shippingJobRequestFingerprint,
  type ShippingJobRequestMessage,
  type ShippingJobResult,
} from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { ShippingExecutionPlane } from './executor'
import { boundShippingResult, ShippingJobJournal, type ShippingJournalEntry } from './journal'

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

const unsignedRequest = (
  input: ShippingJobRequestMessage,
): Omit<ShippingJobRequestMessage, 'requestDigest'> => {
  const { requestDigest: _requestDigest, ...request } = input
  return request
}

const identityRequest = (): ShippingJobRequestMessage =>
  signRequest({
    type: 'shippingJobRequest',
    requestId: 'request-identity',
    action: 'start',
    jobId: 'job-identity',
    orderId: asShipOrderId('order-identity'),
    attemptId: asShipAttemptId('attempt-identity'),
    generation: 1,
    operation: 'preflight',
    repoPath: '/repo',
    sourceBranch: 'issue/identity',
    targetBranch: 'main',
    approvedBaseSha: 'a'.repeat(40),
    approvedHeadSha: 'b'.repeat(40),
    expectedTargetSha: 'a'.repeat(40),
    destination: 'local:main',
    validationProfile: {
      id: 'proof',
      argv: ['git', 'diff', '--quiet'],
      cwd: 'integration-root',
      timeoutMs: 30_000,
      resourceLocks: ['validation:proof'],
    },
  })

const runningResult = (request: ShippingJobRequestMessage): ShippingJobResult => ({
  jobId: request.jobId,
  requestDigest: request.requestDigest,
  orderId: request.orderId,
  attemptId: request.attemptId,
  machineId: asMachineId('machine-1'),
  generation: request.generation,
  operation: request.operation,
  state: 'running',
  classification: 'observed',
  summary: 'started',
  logs: [],
  artifactRefs: [],
  heartbeatedAt: '2026-08-13T10:00:00.000Z',
})

describe('shipping daemon journal', () => {
  it('accepts canonically identical validation profiles with reordered properties', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-shipping-journal-identity-'))
    dirs.push(dir)
    const journal = new ShippingJobJournal(dir)
    const request = identityRequest()
    const result = runningResult(request)
    const reordered = signRequest({
      ...unsignedRequest(request),
      requestId: 'request-identity-retry',
      validationProfile: {
        resourceLocks: [...request.validationProfile.resourceLocks],
        timeoutMs: request.validationProfile.timeoutMs,
        cwd: request.validationProfile.cwd,
        argv: [...request.validationProfile.argv],
        id: request.validationProfile.id,
      },
    })

    const first = journal.begin(request, result)
    expect(journal.begin(reordered, runningResult(reordered))).toEqual(first)
  })

  it('rejects a semantic request drift even when its digest is internally valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-shipping-journal-drift-'))
    dirs.push(dir)
    const journal = new ShippingJobJournal(dir)
    const request = identityRequest()
    journal.begin(request, runningResult(request))
    const drifted = signRequest({
      ...unsignedRequest(request),
      requestId: 'request-identity-drift',
      validationProfile: {
        ...request.validationProfile,
        timeoutMs: request.validationProfile.timeoutMs + 1,
      },
    })

    expect(() => journal.begin(drifted, runningResult(drifted))).toThrow('changed inputs')
  })

  it('rejects a stored request whose declared digest does not match its canonical facts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-shipping-journal-digest-'))
    dirs.push(dir)
    const journal = new ShippingJobJournal(dir)
    const request = identityRequest()
    const result = runningResult(request)
    journal.begin(request, result)
    const path = join(dir, `${createHash('sha256').update(request.jobId).digest('hex')}.json`)
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as ShippingJournalEntry
    persisted.request.requestDigest = 'f'.repeat(64)
    persisted.result.requestDigest = 'f'.repeat(64)
    writeFileSync(path, `${JSON.stringify(persisted)}\n`)

    expect(() => journal.begin(request, result)).toThrow('changed inputs')
  })

  it('durably creates the shipping root before the first journal directory', () => {
    const parent = mkdtempSync(join(tmpdir(), 'podium-shipping-root-'))
    dirs.push(parent)
    const points: string[] = []
    const plane = new ShippingExecutionPlane(
      join(parent, 'shipping'),
      asMachineId('machine-1'),
      undefined,
      undefined,
      (point) => points.push(point),
    )
    expect(points).toEqual(['after-shipping-root-parent-fsync', 'after-parent-directory-fsync'])
    expect(plane.journal.list()).toEqual([])
  })

  it('reopens terminal jobs and bounds diagnostic payloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-shipping-journal-'))
    dirs.push(dir)
    const plane = new ShippingExecutionPlane(dir, asMachineId('machine-1'))
    expect(plane.journal.list()).toEqual([])
    const bounded = boundShippingResult({
      jobId: 'job-1',
      requestDigest: 'a'.repeat(64),
      orderId: 'order-1' as never,
      attemptId: 'attempt-1' as never,
      machineId: asMachineId('machine-1'),
      generation: 1,
      operation: 'preflight',
      state: 'held',
      classification: 'invalid-request',
      summary: 'x'.repeat(10_000),
      logs: Array.from({ length: 100 }, (_, index) => `${index}:${'y'.repeat(4_000)}`),
      artifactRefs: Array.from({ length: 30 }, (_, index) => `artifact-${index}`),
      heartbeatedAt: '2026-08-13T10:00:00.000Z',
      finishedAt: '2026-08-13T10:00:00.000Z',
    })
    expect(bounded.logs).toHaveLength(64)
    expect(bounded.artifactRefs).toHaveLength(16)
    expect(Buffer.byteLength(bounded.summary)).toBeLessThanOrEqual(2_048)

    const request = {
      type: 'shippingJobRequest' as const,
      requestId: 'request-1',
      action: 'start' as const,
      jobId: 'job-1',
      requestDigest: 'a'.repeat(64),
      orderId: asShipOrderId('order-1'),
      attemptId: asShipAttemptId('attempt-1'),
      generation: 1,
      operation: 'preflight' as const,
      repoPath: '/repo',
      sourceBranch: 'issue/1',
      targetBranch: 'main',
      approvedBaseSha: 'a'.repeat(40),
      approvedHeadSha: 'b'.repeat(40),
      expectedTargetSha: 'a'.repeat(40),
      destination: 'local:main',
      validationProfile: {
        id: 'proof',
        argv: ['git', 'diff', '--quiet'],
        cwd: 'integration-root' as const,
        timeoutMs: 30_000,
        resourceLocks: [],
      },
    }
    plane.journal.begin(request, bounded)
    plane.journal.acknowledge('job-1', 1, '2026-08-13T10:01:00.000Z')
    const reopened = new ShippingExecutionPlane(dir, asMachineId('machine-1')).journal.get('job-1')
    expect(reopened).toMatchObject({
      result: { state: 'held' },
      acknowledgedAt: '2026-08-13T10:01:00.000Z',
    })
  })

  it('orders file fsync, rename, and directory fsync and survives each crash boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-shipping-journal-fsync-'))
    dirs.push(dir)
    const request = {
      type: 'shippingJobRequest' as const,
      requestId: 'request-fsync',
      action: 'start' as const,
      jobId: 'job-fsync',
      requestDigest: 'b'.repeat(64),
      orderId: asShipOrderId('order-fsync'),
      attemptId: asShipAttemptId('attempt-fsync'),
      generation: 1,
      operation: 'preflight' as const,
      repoPath: '/repo',
      sourceBranch: 'issue/fsync',
      targetBranch: 'main',
      approvedBaseSha: 'a'.repeat(40),
      approvedHeadSha: 'b'.repeat(40),
      expectedTargetSha: 'a'.repeat(40),
      destination: 'local:main',
      validationProfile: {
        id: 'proof',
        argv: ['git', 'diff', '--quiet'],
        cwd: 'integration-root' as const,
        timeoutMs: 30_000,
        resourceLocks: [],
      },
    }
    const result = boundShippingResult({
      jobId: request.jobId,
      requestDigest: request.requestDigest,
      orderId: request.orderId,
      attemptId: request.attemptId,
      machineId: asMachineId('machine-1'),
      generation: request.generation,
      operation: request.operation,
      state: 'running',
      classification: 'observed',
      summary: 'started',
      logs: [],
      artifactRefs: [],
      heartbeatedAt: '2026-08-13T10:00:00.000Z',
    })
    const points: string[] = []
    const journal = new ShippingJobJournal(dir, (point) => {
      points.push(point)
      if (point === 'after-rename') throw new Error('simulated crash')
    })
    expect(() => journal.begin(request, result)).toThrow('simulated crash')
    expect(points).toEqual(['after-file-fsync', 'after-rename'])
    expect(new ShippingJobJournal(dir).get(request.jobId)).toMatchObject({
      result: { state: 'running' },
    })

    const beforeRename = join(dir, 'before-rename')
    const first = new ShippingJobJournal(beforeRename, (point) => {
      if (point === 'after-file-fsync') throw new Error('simulated pre-rename crash')
    })
    expect(() =>
      first.begin(
        { ...request, jobId: 'job-before-rename' },
        { ...result, jobId: 'job-before-rename' },
      ),
    ).toThrow('simulated pre-rename crash')
    expect(new ShippingJobJournal(beforeRename).get('job-before-rename')).toBeNull()
    expect(readdirSync(beforeRename).some((name) => name.endsWith('.tmp'))).toBe(true)

    const durableDir = join(dir, 'fully-durable')
    const completedPoints: string[] = []
    new ShippingJobJournal(durableDir, (point) => completedPoints.push(point)).begin(
      { ...request, jobId: 'job-fully-durable' },
      { ...result, jobId: 'job-fully-durable' },
    )
    expect(completedPoints).toEqual([
      'after-parent-directory-fsync',
      'after-file-fsync',
      'after-rename',
      'after-directory-fsync',
    ])
    expect(new ShippingJobJournal(durableDir).get('job-fully-durable')).toMatchObject({
      result: { state: 'running' },
    })
  })

  it('rejects journal corruption instead of silently forgetting durable evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-shipping-journal-corrupt-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'corrupt.json'), '{not-json')
    expect(() => new ShippingJobJournal(dir).list()).toThrow()
  })
})
