import { type CapacityView, usageSummary } from '@podium/client-core/values'
import type { UsageBucketWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  attributedLabel,
  daySpanLabel,
  projectSubtitle,
  pulseHero,
  quotaVerdict,
} from './pulse-view'

// Mid-afternoon local time on a Monday, so today has future hours left.
const now = new Date(2026, 10, 9, 14, 30).getTime()
const hourAgo = (h: number) => new Date(Math.floor(now / 3_600_000) * 3_600_000 - h * 3_600_000)

const bucket = (hoursAgo: number, over: Partial<UsageBucketWire> = {}): UsageBucketWire => ({
  hour: hourAgo(hoursAgo).toISOString(),
  model: 'claude-opus-5',
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  messages: 2,
  ...over,
})

describe('pulseHero', () => {
  const summary = usageSummary([bucket(0), bucket(3), bucket(10), bucket(30)], now)

  it('plots every hour of the week with the rest of today as future slots', () => {
    const hero = pulseHero(summary, 'week')
    expect(hero.slots).toHaveLength(7 * 24)
    expect(hero.slots.at(-1)?.future).toBe(true)
    expect(hero.slots.filter((s) => s.future)).toHaveLength(24 - 15)
    expect(hero.costUsd).toBeCloseTo(summary.week.estCostUsd)
    expect(hero.days.map((d) => d.weekday)).toEqual([
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
      'Mon',
    ])
    expect(hero.days.reduce((n, d) => n + d.costUsd, 0)).toBeCloseTo(summary.week.estCostUsd)
  })

  it('makes the five-hour bars sum to the five-hour figure', () => {
    const hero = pulseHero(summary, 'fiveHour')
    expect(hero.slots).toHaveLength(5)
    expect(hero.slots.every((s) => !s.future)).toBe(true)
    expect(hero.days).toEqual([])
    const sum = hero.slots.reduce((n, s) => n + s.costUsd, 0)
    expect(sum).toBeCloseTo(summary.fiveHour.estCostUsd)
    expect(hero.costUsd).toBeGreaterThan(0)
  })

  it('names the week span in days and month', () => {
    expect(daySpanLabel(summary)).toBe('3–9 Nov')
  })
})

describe('quotaVerdict', () => {
  const view = (over: Partial<CapacityView>): CapacityView =>
    ({
      tone: 'ok',
      headline: 'Room to run',
      constraint: 'quota',
      spentPools: [],
      ...over,
    }) as CapacityView

  it('shows the shared headline, quiet while nothing is out', () => {
    expect(quotaVerdict(view({}))).toEqual({ text: 'Room to run', signal: false })
  })

  it('tints the line when a provider is out or the fleet runs close', () => {
    const out = view({
      headline: 'Codex is out',
      spentPools: [{} as CapacityView['spentPools'][0]],
    })
    expect(quotaVerdict(out)).toEqual({ text: 'Codex is out', signal: true })
    expect(quotaVerdict(view({ tone: 'warn', headline: 'Running close' }))?.signal).toBe(true)
  })

  it('shows nothing before there is a reading', () => {
    expect(quotaVerdict(view({ constraint: 'unknown', headline: 'Nothing to report' }))).toBeNull()
  })
})

describe('Top projects copy', () => {
  const project = { project: 'podium', costUsd: 612, sharePercent: 48, barPercent: 100 }
  it('names the task count and the top model', () => {
    expect(projectSubtitle({ ...project, taskCount: 14, topModel: 'claude-opus-5' })).toBe(
      '14 tasks · claude-opus-5 most',
    )
    expect(projectSubtitle({ ...project, taskCount: 1, topModel: null })).toBe('1 task')
  })

  it('reads the attributed share, and nothing before an answer', () => {
    // The desktop's share rule (formatShare): one decimal, capped at the total.
    expect(
      attributedLabel({
        rows: [],
        attributedUsd: 82.4,
        attributedPercent: 82.4,
        windowTotalUsd: 100,
      }),
    ).toBe('82.4% attributed')
    expect(
      attributedLabel({ rows: [], attributedUsd: 0, attributedPercent: null, windowTotalUsd: 0 }),
    ).toBeUndefined()
    expect(attributedLabel(null)).toBeUndefined()
  })
})
