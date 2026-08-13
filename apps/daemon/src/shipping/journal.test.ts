import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
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
  })
})
