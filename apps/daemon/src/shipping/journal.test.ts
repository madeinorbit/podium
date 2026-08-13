import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asShipAttemptId, asShipOrderId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { ShippingExecutionPlane } from './executor'
import { boundShippingResult, ShippingJobJournal } from './journal'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('shipping daemon journal', () => {
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
