import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoopMinute } from './loop-accounting'
import { createLoopMinuteSink, loopMinutePath } from './loop-minute-sink'

function minute(over: Partial<LoopMinute> = {}): LoopMinute {
  return {
    at: '2026-09-10T10:00:00.000Z',
    component: 'server',
    level: 'accounting',
    utilizationPct: 12.5,
    blockedPct: 0,
    stalls: 0,
    stallP50Ms: 0,
    stallP99Ms: 0,
    stallMaxMs: 0,
    heapUsedBytes: 1,
    rssBytes: 2,
    selfCostPct: 0.01,
    ...over,
  }
}

/** Just the two methods the sink uses, so a test can read what it said. */
function fakeLog() {
  const info = vi.fn()
  const warn = vi.fn()
  return { info, warn } as unknown as Parameters<typeof createLoopMinuteSink>[0]['log'] & {
    info: typeof info
    warn: typeof warn
  }
}

describe('createLoopMinuteSink', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-loop-minutes-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates neither the directory nor the file until the first record', () => {
    const perf = join(dir, 'perf')
    const log = fakeLog()
    const sink = createLoopMinuteSink({ dir: perf, component: 'daemon', log })
    expect(existsSync(perf)).toBe(false)

    sink.write(minute({ component: 'daemon' }))
    expect(existsSync(loopMinutePath(perf, 'daemon'))).toBe(true)
    sink.close()
  })

  it('writes one JSON line per record, and only these records', () => {
    const log = fakeLog()
    const sink = createLoopMinuteSink({ dir, component: 'server', log })
    sink.write(minute())
    sink.write(minute({ at: '2026-09-10T10:01:00.000Z', stalls: 3 }))
    sink.close()

    const lines = readFileSync(loopMinutePath(dir, 'server'), 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '')).toEqual(minute())
    expect(JSON.parse(lines[1] ?? '').stalls).toBe(3)
  })

  it('also emits the record through the logger, under one message', () => {
    const log = fakeLog()
    const sink = createLoopMinuteSink({ dir, component: 'server', log })
    sink.write(minute({ stalls: 2 }))
    sink.close()
    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.info.mock.calls[0]?.[0]).toBe('loop minute')
    expect(log.info.mock.calls[0]?.[1]).toMatchObject({ stalls: 2, component: 'server' })
  })

  it('rotates at the size threshold and keeps exactly one archive', () => {
    const log = fakeLog()
    const path = loopMinutePath(dir, 'server')
    const sink = createLoopMinuteSink({ dir, component: 'server', maxBytes: 400, log })
    for (let i = 0; i < 12; i += 1) sink.write(minute({ stalls: i }))
    sink.close()

    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(`${path}.2`)).toBe(false)
    expect(statSync(path).size).toBeLessThanOrEqual(400)
    // The newest record is in the LIVE file; the archive holds what fell out of
    // it last, and everything older than that is GONE — one generation is the
    // whole budget, not a growing tail.
    const live = readFileSync(path, 'utf8').trimEnd().split('\n')
    expect(JSON.parse(live[live.length - 1] ?? '').stalls).toBe(11)
    const archived = readFileSync(`${path}.1`, 'utf8')
    expect(archived).toContain('"stalls":10')
    expect(archived).not.toContain('"stalls":0')
  })

  it('adopts the size already on disk, so a restart cannot double the budget', () => {
    const log = fakeLog()
    const path = loopMinutePath(dir, 'server')
    writeFileSync(path, 'x'.repeat(390))
    const sink = createLoopMinuteSink({ dir, component: 'server', maxBytes: 400, log })
    sink.write(minute())
    sink.close()
    // The first record did not fit beside what was there, so it rotated first.
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(statSync(`${path}.1`).size).toBe(390)
  })

  it('degrades to the log alone when the file cannot be written', () => {
    const log = fakeLog()
    // A file where the directory must go: mkdir fails, so the sink cannot open.
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, '')
    const sink = createLoopMinuteSink({ dir: blocked, component: 'server', log })
    sink.write(minute())
    expect(sink.degraded).toBe(true)
    expect(log.warn).toHaveBeenCalledTimes(1)

    // Still records, and does not re-probe the filesystem.
    sink.write(minute({ stalls: 9 }))
    expect(log.info).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledTimes(1)
    sink.close()
  })
})
