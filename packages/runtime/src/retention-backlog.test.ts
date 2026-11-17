import { describe, expect, it } from 'vitest'
import { REPEAT_WARN_MS, RetentionBacklog, STALL_RUNS } from './retention-backlog'

function harness() {
  const lines: {
    level: 'debug' | 'info' | 'warn'
    message: string
    fields?: Record<string, unknown>
  }[] = []
  let now = 0
  const gauge = new RetentionBacklog(
    {
      debug: (message, fields) =>
        lines.push({ level: 'debug', message, ...(fields ? { fields } : {}) }),
      info: (message, fields) =>
        lines.push({ level: 'info', message, ...(fields ? { fields } : {}) }),
      warn: (message, fields) =>
        lines.push({ level: 'warn', message, ...(fields ? { fields } : {}) }),
    },
    () => now,
  )
  return {
    gauge,
    warnings: () => lines.filter((line) => line.level === 'warn'),
    infos: () => lines.filter((line) => line.level === 'info'),
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('the prune-lag gauge (POD-7035)', () => {
  it('stays quiet while a backlog shrinks, however slowly', () => {
    const { gauge, warnings } = harness()
    for (const left of [1000, 999, 998, 997, 996]) gauge.report('job', left)
    expect(warnings()).toEqual([])
    expect(gauge.stalled('job')).toBe(false)
    expect(gauge.snapshot()).toEqual({ job: 996 })
  })

  it(`warns once a backlog has not shrunk across ${STALL_RUNS} runs`, () => {
    const { gauge, warnings } = harness()
    gauge.report('job', 5)
    gauge.report('job', 5)
    expect(warnings()).toEqual([])
    gauge.report('job', 6, { deleted: 0 })
    expect(gauge.stalled('job')).toBe(true)
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]?.fields).toMatchObject({
      job: 'job',
      pastCutoff: 6,
      deleted: 0,
      recent: [5, 5, 6],
    })
  })

  it('repeats the warning at most once an hour while the stall lasts, and says when it ends', () => {
    const { gauge, warnings, infos, advance } = harness()
    for (let i = 0; i < 3; i += 1) gauge.report('job', 7)
    for (let i = 0; i < 10; i += 1) {
      advance(60_000)
      gauge.report('job', 7)
    }
    expect(warnings()).toHaveLength(1)
    advance(REPEAT_WARN_MS)
    gauge.report('job', 7)
    expect(warnings()).toHaveLength(2)
    gauge.report('job', 6)
    expect(gauge.stalled('job')).toBe(false)
    expect(infos().map((line) => line.message)).toEqual(['retention backlog draining again'])
  })

  it('a zero backlog is never a stall, and ends one', () => {
    const { gauge, warnings, infos } = harness()
    for (let i = 0; i < 5; i += 1) gauge.report('idle', 0)
    expect(warnings()).toEqual([])
    for (let i = 0; i < 3; i += 1) gauge.report('job', 3)
    gauge.report('job', 0)
    expect(gauge.stalled('job')).toBe(false)
    expect(infos().map((line) => line.message)).toEqual(['retention backlog drained'])
  })

  it('keeps each job apart', () => {
    const { gauge } = harness()
    for (let i = 0; i < 3; i += 1) {
      gauge.report('stuck', 4)
      gauge.report('draining', 10 - i)
    }
    expect(gauge.stalled('stuck')).toBe(true)
    expect(gauge.stalled('draining')).toBe(false)
  })
})
