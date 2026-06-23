import { describe, expect, it } from 'vitest'
import {
  agentLabel,
  formatReset,
  paceHint,
  paceLabel,
  percentTone,
  quotaPace,
  statusNote,
  windowElapsedPercent,
  windowPace,
} from './quota'

const now = Date.parse('2026-06-19T18:00:00.000Z')

describe('formatReset', () => {
  it('renders m / h m / d h, and edge cases', () => {
    expect(formatReset(new Date(now + 40 * 60_000).toISOString(), now)).toBe('resets in 40m')
    expect(formatReset(new Date(now + 134 * 60_000).toISOString(), now)).toBe('resets in 2h 14m')
    expect(formatReset(new Date(now + (28 * 60 + 5) * 60_000).toISOString(), now)).toBe('resets in 1d 4h')
    expect(formatReset(new Date(now - 5_000).toISOString(), now)).toBe('resetting…')
    expect(formatReset('', now)).toBe('')
  })
})

describe('percentTone', () => {
  it('buckets at 75 and 90', () => {
    expect(percentTone(74)).toBe('ok')
    expect(percentTone(75)).toBe('warn')
    expect(percentTone(90)).toBe('warn')
    expect(percentTone(90.1)).toBe('crit')
  })
})

describe('agentLabel / statusNote', () => {
  it('labels known agents and notes non-ok statuses', () => {
    expect(agentLabel('claude-code')).toBe('Claude Code')
    expect(agentLabel('codex')).toBe('Codex')
    expect(statusNote({ agent: 'codex', status: 'unauthenticated', windows: [], fetchedAt: '' })).toBe('Not signed in')
    expect(statusNote({ agent: 'codex', status: 'ok', windows: [], fetchedAt: '' })).toBe('')
  })
})

describe('windowElapsedPercent', () => {
  it('derives elapsed share from reset time and window length', () => {
    const resetsAt = new Date(now + 150 * 60_000).toISOString() // 2.5h left in 5h window
    expect(windowElapsedPercent(resetsAt, 300, now)).toBeCloseTo(50, 1)
    expect(windowElapsedPercent('', 300, now)).toBeNull()
    expect(windowElapsedPercent(resetsAt, 0, now)).toBeNull()
  })
})

describe('quotaPace / windowPace', () => {
  it('classifies comfortable, on-pace, and hot windows', () => {
    expect(quotaPace(30, 50)).toBe('comfortable')
    expect(quotaPace(48, 50)).toBe('on-pace')
    expect(quotaPace(52, 50)).toBe('on-pace')
    expect(quotaPace(70, 50)).toBe('hot')
    expect(quotaPace(10, 0)).toBeNull()
  })

  it('labels and hints pace for UI copy', () => {
    expect(paceLabel('comfortable')).toBe('Headroom')
    expect(paceLabel('on-pace')).toBe('On pace')
    expect(paceLabel('hot')).toBe("Won't last")
    expect(paceHint('hot', 70, 50)).toContain('70%')
    expect(paceHint('hot', 70, 50)).toContain('50%')
  })

  it('composes window pace from wire fields', () => {
    const pace = windowPace(
      {
        key: '5h',
        label: '5-hour',
        usedPercent: 70,
        resetsAt: new Date(now + 150 * 60_000).toISOString(),
        windowMinutes: 300,
      },
      now,
    )
    expect(pace).toBe('hot')
  })
})
