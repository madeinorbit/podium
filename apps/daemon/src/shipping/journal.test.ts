import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asShipAttemptId, asShipOrderId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { ShippingExecutionPlane } from './executor'
import { boundShippingResult } from './journal'

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
})
