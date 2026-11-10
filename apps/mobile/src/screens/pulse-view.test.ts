import { type AccountQuotaGroup, type CapacityView, usageSummary } from '@podium/client-core/values'
import type { CostModelTotalWire, TaskCostRowWire, UsageBucketWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  attributedLabel,
  daySpanLabel,
  formatPercent,
  modelRows,
  projectSubtitle,
  pulseHero,
  quotaRows,
  quotaVerdict,
  topTasks,
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

describe('quotaRows', () => {
  const reset = new Date(now + 9 * 3_600_000).toISOString()
  const group = (
    agent: string,
    usedPercent: number,
    over: Partial<AccountQuotaGroup> = {},
  ): AccountQuotaGroup =>
    ({
      key: agent,
      agent,
      machineNames: ['m'],
      status: 'ok',
      windows: [
        { key: 'week', label: 'Weekly', usedPercent, resetsAt: reset, windowMinutes: 7 * 1440 },
      ],
      fetchedAt: new Date(now).toISOString(),
      ...over,
    }) as AccountQuotaGroup

  it('orders tightest first, marks a used-up window out, and keeps unreadable pools last', () => {
    const rows = quotaRows(
      [
        group('claude-code', 71),
        group('gemini', 0, { status: 'error', error: 'boom', windows: [] }),
        group('codex', 100),
      ],
      now,
    )
    expect(rows.map((r) => r.agent)).toEqual(['codex', 'claude-code', 'gemini'])
    expect(rows[0]).toMatchObject({ out: true, paceText: 'Used up', usedPercent: 100 })
    expect(rows[0]?.title).toMatch(/· Weekly$/)
    expect(rows[1]).toMatchObject({ out: false, resetText: 'Resets in 9h 0m' })
    expect(rows[1]?.elapsedPercent).toBeGreaterThan(90)
    expect(rows[2]).toMatchObject({ usedPercent: null, out: false })
  })
})

const opus = (over: Partial<CostModelTotalWire> = {}): CostModelTotalWire => ({
  model: 'claude-opus-5',
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  messages: 1,
  ...over,
})

const taskRow = (seq: number, windowMTok: number, ownMTok = 50): TaskCostRowWire =>
  ({
    issueId: `iss_${seq}`,
    seq,
    displayRef: `POD-${seq}`,
    title: `Task ${seq}`,
    stage: 'in_progress',
    models: [opus({ inputTokens: ownMTok * 1_000_000 })],
    messages: 10,
    windowModels: windowMTok > 0 ? [opus({ inputTokens: windowMTok * 1_000_000 })] : [],
    windowMessages: 5,
    // A huge rollup must not affect the ranking: that would count children twice.
    rollupModels: [opus({ inputTokens: 900_000_000 })],
    rollupMessages: 100,
    sessionCount: 1,
    floor: 'none',
    harnesses: ['claude-code'],
    uncostedSessionCount: 0,
  }) as TaskCostRowWire

describe('topTasks', () => {
  it('ranks by own seven-day cost, drops idle tasks and keeps five', () => {
    const rows = [1, 2, 3, 4, 5, 6].map((seq) => taskRow(seq, seq))
    rows.push(taskRow(7, 0, 999))
    const top = topTasks(rows)
    expect(top.map((t) => t.seq)).toEqual([6, 5, 4, 3, 2])
    expect(top[0]?.windowCostUsd).toBeCloseTo(30)
  })

  it('is empty while cold', () => {
    expect(topTasks(null)).toEqual([])
  })
})

describe('modelRows', () => {
  it('shares are of the week total and bars are against the dearest model', () => {
    const summary = usageSummary(
      [bucket(1), bucket(2), bucket(2, { model: 'claude-sonnet-5', inputTokens: 1_000_000 })],
      now,
    )
    const rows = modelRows(summary)
    expect(rows[0]).toMatchObject({
      model: 'claude-opus-5',
      provider: 'Anthropic',
      barPercent: 100,
    })
    expect(rows.reduce((n, r) => n + r.sharePercent, 0)).toBeCloseTo(100)
    expect(rows[1]?.barPercent).toBeLessThan(100)
  })
})

describe('formatPercent', () => {
  it('never prints a non-zero share as 0%', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(0.3)).toBe('<1%')
    expect(formatPercent(48.4)).toBe('48%')
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
    expect(attributedLabel({ rows: [], attributedUsd: 10, attributedPercent: 82.4 })).toBe(
      '82% attributed',
    )
    expect(attributedLabel({ rows: [], attributedUsd: 0, attributedPercent: null })).toBeUndefined()
    expect(attributedLabel(null)).toBeUndefined()
  })
})
