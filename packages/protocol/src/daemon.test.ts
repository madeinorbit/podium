import { describe, expect, it } from 'vitest'
import * as commonProtocol from './index'
import {
  ControlMessage,
  DaemonMessage,
  ShippingJobRequestMessage,
  encodeDaemonMessage,
  parseControlMessage,
  parseDaemonMessage,
  shippingJobRequestFingerprint,
} from './daemon'

describe('daemon-only protocol entry', () => {
  it('keeps daemon and shipping runtime exports out of the common browser barrel', () => {
    expect(commonProtocol).not.toHaveProperty('ControlMessage')
    expect(commonProtocol).not.toHaveProperty('DaemonMessage')
    expect(commonProtocol).not.toHaveProperty('parseControlMessage')
    expect(commonProtocol).not.toHaveProperty('parseDaemonMessage')
    expect(commonProtocol).not.toHaveProperty('ShippingJobRequestMessage')
    expect(commonProtocol).not.toHaveProperty('ShippingJobResult')
    expect(commonProtocol).not.toHaveProperty('shippingJobRequestFingerprint')
  })

  it('owns daemon/control parsing and shipping request fingerprinting', () => {
    const request = ShippingJobRequestMessage.parse({
      type: 'shippingJobRequest',
      requestId: 'request-1',
      action: 'start',
      jobId: 'job-1',
      requestDigest: 'a'.repeat(64),
      orderId: 'order-1',
      attemptId: 'attempt-1',
      generation: 1,
      operation: 'preflight',
      repoPath: '/repo',
      sourceBranch: 'feature',
      targetBranch: 'main',
      approvedBaseSha: 'base',
      approvedHeadSha: 'head',
      expectedTargetSha: 'target',
      destination: 'local:main',
      validationProfile: {
        id: 'default',
        argv: ['bun', 'run', 'test'],
        cwd: 'integration-root',
        timeoutMs: 60_000,
        resourceLocks: [],
      },
    })
    const facts = ShippingJobRequestMessage.omit({
      type: true,
      requestId: true,
      action: true,
      requestDigest: true,
    }).parse(request)

    expect(parseControlMessage(encodeDaemonMessage(request))).toEqual(request)
    expect(shippingJobRequestFingerprint(facts)).toContain('"jobId":"job-1"')

    const result = {
      type: 'shippingJobResult' as const,
      requestId: 'request-1',
      jobId: 'job-1',
      requestDigest: 'a'.repeat(64),
      orderId: 'order-1',
      attemptId: 'attempt-1',
      machineId: 'machine-1',
      generation: 1,
      operation: 'preflight' as const,
      state: 'succeeded' as const,
      classification: 'observed' as const,
      summary: 'observed',
      logs: [],
      artifactRefs: [],
      heartbeatedAt: '2026-08-13T00:00:00.000Z',
    }
    const parsedResult = DaemonMessage.parse(result)
    expect(parsedResult).toEqual(result)
    expect(parseDaemonMessage(encodeDaemonMessage(parsedResult))).toEqual(result)
    expect(ControlMessage.parse(request)).toEqual(request)
  })
})
