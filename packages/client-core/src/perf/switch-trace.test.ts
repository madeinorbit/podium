import { asIssueId, asSessionId } from '@podium/model'
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

  it('records chat:first-paint and quiesces at chat:interactable', () => {
    beginSwitch({ sessionId: asSessionId('s1'), issueId: asIssueId('i1') })
    expect(isSwitchTraced(asSessionId('s1'))).toBe(true)
    expect(isSwitchTraced(asSessionId('other'))).toBe(false)

    markSwitch(asSessionId('s1'), 'viewstate:sent')
    markSwitch(asSessionId('s1'), 'transcript:read-start')
    markSwitch(asSessionId('s1'), 'transcript:read-end', { items: 42 })
    expect(reported).toHaveLength(0) // read-end alone doesn't quiesce
    markSwitch(asSessionId('s1'), 'chat:first-paint', { paintedRows: 7 })

    expect(reported).toHaveLength(0) // paint is evidence, not the finish line
    vi.advanceTimersByTime(1)
    markSwitch(asSessionId('s1'), 'chat:interactable', {
      composerEnabled: true,
      composerFocusable: true,
      transcriptCommitted: true,
    })

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
      'chat:interactable',
    ])
    for (const m of t.marks) expect(m.atMs).toBeGreaterThanOrEqual(0)
    expect(t.totalMs).toBe(Math.max(...t.marks.map((m) => m.atMs)))
    expect(t.meta).toEqual({
      items: 42,
      paintedRows: 7,
      composerEnabled: true,
      composerFocusable: true,
      transcriptCommitted: true,
    })
    expect(isSwitchTraced(asSessionId('s1'))).toBe(false)
    expect(getRecentSwitchTraces()).toHaveLength(1)
  })

  it('does not quiesce at paint before chat:interactable', () => {
    beginSwitch({ sessionId: asSessionId('paint-gap') })
    markSwitch(asSessionId('paint-gap'), 'chat:first-paint', { paintedRows: 3 })

    // This is the regression gate: pixels being visible is not the finish line.
    expect(reported).toHaveLength(0)

    vi.advanceTimersByTime(17)
    markSwitch(asSessionId('paint-gap'), 'chat:interactable', {
      composerEnabled: true,
      composerFocusable: true,
      transcriptCommitted: true,
    })

    expect(reported).toHaveLength(1)
    const t = nth(0)
    expect(t.mode).toBe('chat')
    expect(t.marks.map((m) => m.name)).toEqual(['chat:first-paint', 'chat:interactable'])
    expect(t.marks[1]?.atMs).toBeGreaterThan(t.marks[0]?.atMs ?? -1)
  })

  it('quiesces a native switch at term:interactable and flags cold via panel:mount', () => {
    beginSwitch({ sessionId: asSessionId('s2') })
    markSwitch(asSessionId('s2'), 'panel:mount')
    markSwitch(asSessionId('s2'), 'panel:active')
    markSwitch(asSessionId('s2'), 'term:mount')
    markSwitch(asSessionId('s2'), 'term:connection:attached')
    expect(reported).toHaveLength(0)
    markSwitch(asSessionId('s2'), 'term:ready')

    expect(reported).toHaveLength(0) // attach/UI-ready is not keystroke-ready
    markSwitch(asSessionId('s2'), 'term:interactable')

    expect(reported).toHaveLength(1)
    const t = nth(0)
    expect(t.mode).toBe('native')
    expect(t.cold).toBe(true)
    expect(t.issueId).toBeNull()
    expect(t.timedOut).toBe(false)
  })

  it('waits for BOTH sentinels when chat and terminal both showed activity', () => {
    beginSwitch({ sessionId: asSessionId('s3') })
    markSwitch(asSessionId('s3'), 'term:mount')
    markSwitch(asSessionId('s3'), 'transcript:read-start')
    markSwitch(asSessionId('s3'), 'chat:first-paint')
    expect(reported).toHaveLength(0) // term activity seen → term:interactable still owed
    markSwitch(asSessionId('s3'), 'term:ready')
    expect(reported).toHaveLength(0) // both views still owe their interactable marks
    markSwitch(asSessionId('s3'), 'chat:interactable')
    expect(reported).toHaveLength(0)
    markSwitch(asSessionId('s3'), 'term:interactable')
    expect(reported).toHaveLength(1)
    expect(nth(0).mode).toBe('chat') // chat painted wins over term ready
  })

  it('does not let a hidden-terminal active change block a chat toggle', () => {
    beginSwitch({ sessionId: asSessionId('chat-toggle') })
    markSwitch(asSessionId('chat-toggle'), 'term:panel:active-change')
    markSwitch(asSessionId('chat-toggle'), 'chat:first-paint')
    markSwitch(asSessionId('chat-toggle'), 'chat:interactable')

    expect(reported).toHaveLength(1)
    expect(nth(0).mode).toBe('chat')
    expect(nth(0).timedOut).toBe(false)
  })

  it('ignores marks for other sessions and marks with no active trace', () => {
    markSwitch(asSessionId('nobody'), 'chat:first-paint') // no active trace — must not throw
    beginSwitch({ sessionId: asSessionId('s4') })
    markSwitch(asSessionId('other'), 'chat:first-paint')
    markSwitch(asSessionId('other'), 'term:ready')
    expect(reported).toHaveLength(0)
    expect(isSwitchTraced(asSessionId('s4'))).toBe(true)
  })

  it('replaces an in-flight trace, finalizing the old one as timedOut', () => {
    beginSwitch({ sessionId: asSessionId('old') })
    markSwitch(asSessionId('old'), 'viewstate:sent')
    beginSwitch({ sessionId: asSessionId('new') })

    expect(reported).toHaveLength(1)
    expect(nth(0).sessionId).toBe('old')
    expect(nth(0).timedOut).toBe(true)
    expect(nth(0).mode).toBe('unknown')
    expect(isSwitchTraced(asSessionId('new'))).toBe(true)

    markSwitch(asSessionId('new'), 'chat:first-paint')
    markSwitch(asSessionId('new'), 'chat:interactable')
    expect(reported).toHaveLength(2)
    expect(nth(1).timedOut).toBe(false)
  })

  it('finalizes a never-quiescing trace via the 10s timeout', () => {
    beginSwitch({ sessionId: asSessionId('s5') })
    markSwitch(asSessionId('s5'), 'viewstate:sent')
    vi.advanceTimersByTime(9_999)
    expect(reported).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(reported).toHaveLength(1)
    expect(nth(0).timedOut).toBe(true)
    expect(nth(0).mode).toBe('unknown')
    expect(isSwitchTraced(asSessionId('s5'))).toBe(false)
  })

  it('records the once-only sentinels a single time per trace', () => {
    beginSwitch({ sessionId: asSessionId('s6') })
    markSwitch(asSessionId('s6'), 'term:mount') // keep the trace open past first paint
    markSwitch(asSessionId('s6'), 'chat:first-paint')
    markSwitch(asSessionId('s6'), 'chat:first-paint')
    markSwitch(asSessionId('s6'), 'term:ready')
    markSwitch(asSessionId('s6'), 'chat:interactable')
    markSwitch(asSessionId('s6'), 'term:interactable')
    const names = nth(0).marks.map((m) => m.name)
    expect(names.filter((n) => n === 'chat:first-paint')).toHaveLength(1)
  })

  it('bounds the recent ring at 50 traces', () => {
    for (let i = 0; i < 55; i++) {
      beginSwitch({ sessionId: asSessionId(`s${i}`) })
      markSwitch(asSessionId(`s${i}`), 'chat:interactable')
    }
    const ring = getRecentSwitchTraces()
    expect(ring).toHaveLength(50)
    expect(ring.at(-1)?.sessionId).toBe('s54')
    expect(ring[0]?.sessionId).toBe('s5')
  })

  it('exposes the introspection global', () => {
    beginSwitch({ sessionId: asSessionId('s7') })
    markSwitch(asSessionId('s7'), 'term:interactable')
    expect(globalThis.__podiumSwitchTraces?.recent()).toHaveLength(1)
  })

  it('survives a throwing reporter', () => {
    setSwitchTraceReporter(() => {
      throw new Error('boom')
    })
    beginSwitch({ sessionId: asSessionId('s8') })
    expect(() => markSwitch(asSessionId('s8'), 'chat:interactable')).not.toThrow()
    expect(getRecentSwitchTraces()).toHaveLength(1)
  })
})
