import { describe, expect, it } from 'vitest'
import { ControlMessage, DaemonMessage } from './index'

const request = {
  type: 'shippingJobRequest' as const,
  requestId: 'request-1',
  action: 'start' as const,
  jobId: 'job-1',
  orderId: 'order-1',
  attemptId: 'attempt-1',
  generation: 2,
  operation: 'preflight' as const,
  repoPath: '/repo',
  sourceBranch: 'issue/1',
  targetBranch: 'main',
  approvedBaseSha: 'a'.repeat(40),
  approvedHeadSha: 'b'.repeat(40),
  expectedTargetSha: 'a'.repeat(40),
  destination: 'local:main',
  validationProfile: {
    id: 'agent',
    argv: ['bun', 'run', 'test'],
    cwd: 'integration-root' as const,
    timeoutMs: 60_000,
    resourceLocks: ['validation:agent'],
  },
}

describe('shipping machine protocol', () => {
  it('round-trips the purpose-built request and result frames', () => {
    expect(ControlMessage.parse(request)).toEqual(request)
    expect(
      DaemonMessage.parse({
        type: 'shippingJobResult',
        requestId: 'request-1',
        jobId: 'job-1',
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
