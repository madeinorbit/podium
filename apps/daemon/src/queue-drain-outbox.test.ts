import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { createQueueDrainOutbox, type DurableQueueDrainReport } from './queue-drain-outbox'

const roots: string[] = []

const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'podium-queue-drain-outbox-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const report = (reportId = 'report-1'): DurableQueueDrainReport => ({
  type: 'runtimeQueueDrainAbandoned',
  reportId,
  sessionId: asSessionId('session-1'),
  turnIds: ['message-1'],
  reason: 'teardown',
})

describe('queue-drain abandonment outbox', () => {
  it('survives a daemon restart and retires only after acknowledgement', () => {
    const dir = temp()
    createQueueDrainOutbox(dir).enqueue(report())

    const reopened = createQueueDrainOutbox(dir)
    expect(reopened.pending()).toEqual([report()])
    expect(reopened.acknowledge('unknown-report')).toBe(false)
    expect(reopened.pending()).toEqual([report()])

    expect(reopened.acknowledge('report-1')).toBe(true)
    expect(createQueueDrainOutbox(dir).pending()).toEqual([])
  })

  it('recovers a complete next generation left in the temp file', () => {
    const dir = temp()
    const outbox = createQueueDrainOutbox(dir)
    outbox.enqueue(report('retired-report'))
    outbox.acknowledge('retired-report')
    writeFileSync(
      join(dir, 'queue-drain-outbox.json.tmp'),
      `${JSON.stringify({ version: 1, reports: [report()] }, null, 2)}\n`,
    )

    expect(createQueueDrainOutbox(dir).pending()).toEqual([report()])
  })

  it('keeps the canonical generation when the temp file is incomplete', () => {
    const dir = temp()
    createQueueDrainOutbox(dir).enqueue(report())
    writeFileSync(join(dir, 'queue-drain-outbox.json.tmp'), '{not-json')

    expect(createQueueDrainOutbox(dir).pending()).toEqual([report()])
  })

  it('fails closed rather than discarding a corrupt durable report file', () => {
    const dir = temp()
    writeFileSync(join(dir, 'queue-drain-outbox.json'), '{not-json')

    expect(() => createQueueDrainOutbox(dir)).toThrow()
  })
})
