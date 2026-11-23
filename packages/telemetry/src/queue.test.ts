/**
 * Queue tests. Two properties matter: the file is readable text
 * the user can audit, and it is bounded — an air-gapped install queues forever
 * and must never grow without limit in someone's state dir.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearQueue,
  dropFromQueue,
  enqueueReport,
  MAX_QUEUE_ENTRIES,
  queueLength,
  queuePath,
  readLastSent,
  readQueue,
  recordLastSent,
  telemetryDir,
} from './queue'
import type { UsageReport } from './schema'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-telemetry-queue-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const usage = (machines: UsageReport['machines'] = '1'): UsageReport => ({
  schema: 1,
  installId: '3f9c1a2e-0000-4000-8000-000000000000',
  version: '1.4.2',
  os: 'linux',
  arch: 'x64',
  installAge: '1-7d',
  machines,
  sessions: { 'claude-code': 3 },
  features: { issues: true },
})

describe('enqueue / read', () => {
  it('round-trips a report', () => {
    expect(enqueueReport(dir, usage())).toBe(true)
    expect(readQueue(dir)).toEqual([usage()])
  })

  it('writes readable JSONL — the user can cat exactly what is pending', () => {
    enqueueReport(dir, usage('1'))
    enqueueReport(dir, usage('2-5'))
    const lines = readFileSync(queuePath(dir), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] as string).machines).toBe('1')
    expect(JSON.parse(lines[1] as string).machines).toBe('2-5')
  })

  it('REFUSES a report the schema does not admit — the queue is a gate, not a pipe', () => {
    const hostile = { ...usage(), note: '/home/alice/secret-repo' } as unknown as UsageReport
    expect(enqueueReport(dir, hostile)).toBe(false)
    expect(readQueue(dir)).toEqual([])
  })

  it('skips corrupt lines instead of throwing', () => {
    mkdirSync(telemetryDir(dir), { recursive: true })
    writeFileSync(queuePath(dir), `not json\n${JSON.stringify(usage())}\n{"schema":99}\n`)
    expect(readQueue(dir)).toEqual([usage()])
  })

  it('reads an absent queue as empty', () => {
    expect(readQueue(dir)).toEqual([])
    expect(queueLength(dir)).toBe(0)
  })
})

describe('caps', () => {
  it('keeps the queue bounded, dropping the OLDEST first', () => {
    for (let i = 0; i < MAX_QUEUE_ENTRIES + 10; i++) {
      enqueueReport(dir, { ...usage(), sessions: { 'claude-code': i } })
    }
    const queued = readQueue(dir)
    expect(queued).toHaveLength(MAX_QUEUE_ENTRIES)
    // The newest survived; the oldest were dropped (a stale usage counter is
    // worth less than a fresh one, and dropping the NEW one would wedge the queue).
    expect(queued.at(-1)).toMatchObject({ sessions: { 'claude-code': MAX_QUEUE_ENTRIES + 9 } })
    expect(queued[0]).toMatchObject({ sessions: { 'claude-code': 10 } })
  })
})

describe('drop / clear', () => {
  it('drops a settled prefix', () => {
    enqueueReport(dir, usage('1'))
    enqueueReport(dir, usage('2-5'))
    enqueueReport(dir, usage('6-20'))
    dropFromQueue(dir, 2)
    expect(readQueue(dir)).toEqual([usage('6-20')])
  })
  it('drop(0) is a no-op', () => {
    enqueueReport(dir, usage())
    dropFromQueue(dir, 0)
    expect(queueLength(dir)).toBe(1)
  })
  it('clears', () => {
    enqueueReport(dir, usage())
    clearQueue(dir)
    expect(readQueue(dir)).toEqual([])
  })
})

describe('last-sent', () => {
  it('records what actually went over the wire', () => {
    recordLastSent(dir, usage('2-5'), new Date('2026-07-16T10:00:00Z'))
    expect(readLastSent(dir)).toEqual({ at: '2026-07-16T10:00:00.000Z', report: usage('2-5') })
  })
  it('is absent before anything is sent', () => {
    expect(readLastSent(dir)).toBeUndefined()
  })
  it('ignores a corrupt last-sent file', () => {
    mkdirSync(telemetryDir(dir), { recursive: true })
    writeFileSync(join(telemetryDir(dir), 'last-sent.json'), '{oops')
    expect(readLastSent(dir)).toBeUndefined()
  })
})

describe('IO failure is never user-visible', () => {
  it('swallows an unwritable state dir', () => {
    // A telemetry file we cannot write must not throw into a caller's path.
    const nested = join(dir, 'does-not-exist', '\u0000invalid')
    expect(() => enqueueReport(nested, usage())).not.toThrow()
    expect(() => readQueue(nested)).not.toThrow()
    expect(() => recordLastSent(nested, usage())).not.toThrow()
  })
})
