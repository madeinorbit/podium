import type { ClientSwitchTrace } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginSwitch,
  getRecentSwitchTraces,
  isSwitchTraced,
  markSwitch,
  resetSwitchTraces,
  setSwitchTraceReporter,
} from './switch-trace'

describe('switch-trace collector [POD-701]', () => {
  let reported: ClientSwitchTrace[]

  beforeEach(() => {
    vi.useFakeTimers()
    resetSwitchTraces()
    reported = []
    setSwitchTraceReporter((t) => reported.push(t))
  })

  /** First/nth reported trace, asserted present (avoids non-null assertions). */
  const nth = (i: number): ClientSwitchTrace => {
    const t = reported[i]
    if (!t) throw new Error(`no trace reported at index ${i}`)
    return t
  }

  afterEach(() => {
    setSwitchTraceReporter(null)
    resetSwitchTraces()
    vi.useRealTimers()
  })

  it('quiesces a chat switch at chat:first-paint and reports mode/meta/marks', () => {
    beginSwitch({ sessionId: 's1', issueId: 'i1' })
    expect(isSwitchTraced('s1')).toBe(true)
    expect(isSwitchTraced('other')).toBe(false)

    markSwitch('s1', 'viewstate:sent')
    markSwitch('s1', 'transcript:read-start')
    markSwitch('s1', 'transcript:read-end', { items: 42 })
    expect(reported).toHaveLength(0) // read-end alone doesn't quiesce
    markSwitch('s1', 'chat:first-paint', { paintedRows: 7 })

    expect(reported).toHaveLength(1)
    const t = nth(0)
    expect(t.sessionId).toBe('s1')
    expect(t.issueId).toBe('i1')
    expect(t.mode).toBe('chat')
    expect(t.cold).toBe(false)
    expect(t.timedOut).toBe(false)
    expect(t.marks.map((m) => m.name)).toEqual([
      'viewstate:sent',
      'transcript:read-start',
      'transcript:read-end',
      'chat:first-paint',
    ])
    for (const m of t.marks) expect(m.atMs).toBeGreaterThanOrEqual(0)
    expect(t.totalMs).toBe(Math.max(...t.marks.map((m) => m.atMs)))
    expect(t.meta).toEqual({ items: 42, paintedRows: 7 })
    expect(isSwitchTraced('s1')).toBe(false)
    expect(getRecentSwitchTraces()).toHaveLength(1)
  })

  it('quiesces a native switch at term:ready and flags cold via panel:mount', () => {
    beginSwitch({ sessionId: 's2' })
    markSwitch('s2', 'panel:mount')
    markSwitch('s2', 'panel:active')
    markSwitch('s2', 'term:mount')
    markSwitch('s2', 'term:connection:attached')
    expect(reported).toHaveLength(0)
    markSwitch('s2', 'term:ready')

    expect(reported).toHaveLength(1)
    const t = nth(0)
    expect(t.mode).toBe('native')
    expect(t.cold).toBe(true)
    expect(t.issueId).toBeNull()
    expect(t.timedOut).toBe(false)
  })

  it('waits for BOTH sentinels when chat and terminal both showed activity', () => {
    beginSwitch({ sessionId: 's3' })
    markSwitch('s3', 'term:mount')
    markSwitch('s3', 'transcript:read-start')
    markSwitch('s3', 'chat:first-paint')
    expect(reported).toHaveLength(0) // term activity seen → term:ready still owed
    markSwitch('s3', 'term:ready')
    expect(reported).toHaveLength(1)
    expect(nth(0).mode).toBe('chat') // chat painted wins over term ready
  })

  it('ignores marks for other sessions and marks with no active trace', () => {
    markSwitch('nobody', 'chat:first-paint') // no active trace — must not throw
    beginSwitch({ sessionId: 's4' })
    markSwitch('other', 'chat:first-paint')
    markSwitch('other', 'term:ready')
    expect(reported).toHaveLength(0)
    expect(isSwitchTraced('s4')).toBe(true)
  })

  it('replaces an in-flight trace, finalizing the old one as timedOut', () => {
    beginSwitch({ sessionId: 'old' })
    markSwitch('old', 'viewstate:sent')
    beginSwitch({ sessionId: 'new' })

    expect(reported).toHaveLength(1)
    expect(nth(0).sessionId).toBe('old')
    expect(nth(0).timedOut).toBe(true)
    expect(nth(0).mode).toBe('unknown')
    expect(isSwitchTraced('new')).toBe(true)

    markSwitch('new', 'chat:first-paint')
    expect(reported).toHaveLength(2)
    expect(nth(1).timedOut).toBe(false)
  })

  it('finalizes a never-quiescing trace via the 10s timeout', () => {
    beginSwitch({ sessionId: 's5' })
    markSwitch('s5', 'viewstate:sent')
    vi.advanceTimersByTime(9_999)
    expect(reported).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(reported).toHaveLength(1)
    expect(nth(0).timedOut).toBe(true)
    expect(nth(0).mode).toBe('unknown')
    expect(isSwitchTraced('s5')).toBe(false)
  })

  it('records the once-only sentinels a single time per trace', () => {
    beginSwitch({ sessionId: 's6' })
    markSwitch('s6', 'term:mount') // keep the trace open past first paint
    markSwitch('s6', 'chat:first-paint')
    markSwitch('s6', 'chat:first-paint')
    markSwitch('s6', 'term:ready')
    const names = nth(0).marks.map((m) => m.name)
    expect(names.filter((n) => n === 'chat:first-paint')).toHaveLength(1)
  })

  it('bounds the recent ring at 50 traces', () => {
    for (let i = 0; i < 55; i++) {
      beginSwitch({ sessionId: `s${i}` })
      markSwitch(`s${i}`, 'chat:first-paint')
    }
    const ring = getRecentSwitchTraces()
    expect(ring).toHaveLength(50)
    expect(ring.at(-1)?.sessionId).toBe('s54')
    expect(ring[0]?.sessionId).toBe('s5')
  })

  it('exposes the introspection global', () => {
    beginSwitch({ sessionId: 's7' })
    markSwitch('s7', 'term:ready')
    expect(globalThis.__podiumSwitchTraces?.recent()).toHaveLength(1)
  })

  it('survives a throwing reporter', () => {
    setSwitchTraceReporter(() => {
      throw new Error('boom')
    })
    beginSwitch({ sessionId: 's8' })
    expect(() => markSwitch('s8', 'chat:first-paint')).not.toThrow()
    expect(getRecentSwitchTraces()).toHaveLength(1)
  })
})
