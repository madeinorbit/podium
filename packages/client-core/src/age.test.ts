import {
  clockStore,
  deadlineClock,
  nowForAge,
  refreshClocks,
  setClockWakeSource,
} from '@podium/mobx-helpers'
import { autorun } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cardAge, cardAgeNextChangeAt, relativeTime, relativeTimeNextChangeAt } from './age'

afterEach(() => {
  setClockWakeSource(undefined)
  vi.useRealTimers()
})

const since = 12_345
const stamp = new Date(since).toISOString()

interface AgeCase {
  name: string
  format: typeof relativeTime
  nextChangeAt: typeof relativeTimeNextChangeAt
  boundaries: readonly (readonly [number, string, string])[]
}

describe.each<AgeCase>([
  {
    name: 'whole-unit card ages',
    format: cardAge,
    nextChangeAt: cardAgeNextChangeAt,
    boundaries: [
      [60_000, 'now', '1m'],
      [120_000, '1m', '2m'],
      [3_600_000, '59m', '1h'],
      [7_200_000, '1h', '2h'],
      [86_400_000, '23h', '1d'],
      [172_800_000, '1d', '2d'],
      [604_800_000, '6d', '1w'],
      [371 * 86_400_000, '52w', '1y'],
      [730 * 86_400_000, '1y', '2y'],
    ] as const,
  },
  {
    name: 'rounded relative ages',
    format: relativeTime,
    nextChangeAt: relativeTimeNextChangeAt,
    boundaries: [
      [59_500, 'just now', '1m ago'],
      [89_500, '1m ago', '2m ago'],
      [3_569_500, '59m ago', '1h ago'],
      [5_369_500, '1h ago', '2h ago'],
      [84_569_500, '23h ago', '1d ago'],
      [127_769_500, '1d ago', '2d ago'],
    ] as const,
  },
])('$name', ({ format, nextChangeAt, boundaries }) => {
  it.each(
    boundaries,
  )('flips at age %i ms from %s to %s at an arbitrary phase', (age, before, after) => {
    vi.useFakeTimers()
    const boundary = since + age
    vi.setSystemTime(boundary - 1000)
    const draws: string[] = []
    const stop = autorun(() => draws.push(format(stamp, nowForAge(stamp, nextChangeAt))))
    try {
      expect(nextChangeAt(since, Date.now())).toBe(boundary)
      expect(draws).toEqual([before])
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(999)
      expect(draws).toEqual([before])
      vi.advanceTimersByTime(1)
      expect(draws).toEqual([before, after])
      const unchanged = nextChangeAt(since, Date.now()) - Date.now() - 1
      vi.advanceTimersByTime(Math.min(unchanged, 3_600_000))
      expect(draws).toEqual([before, after])
    } finally {
      stop()
    }
    expect(vi.getTimerCount()).toBe(0)
  })
})

it('shares one soonest-deadline timer across many labels with independent phases', () => {
  vi.useFakeTimers()
  vi.setSystemTime(42_101)
  const starts = [20_987, 10_123, ...Array.from({ length: 100 }, () => 20_987)]
  const draws = starts.map(() => [] as string[])
  const stops = starts.map((start, i) =>
    autorun(() => {
      draws[i]?.push(cardAge(new Date(start).toISOString(), nowForAge(start, cardAgeNextChangeAt)))
    }),
  )
  try {
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(70_122 - Date.now())
    expect(draws.every((values) => values.length === 1)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(draws[0]).toEqual(['now'])
    expect(draws[1]).toEqual(['now', '1m'])
    expect(draws.slice(2).every((values) => values.length === 1)).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(80_987 - Date.now())
    expect(draws[0]).toEqual(['now', '1m'])
    expect(draws[1]).toEqual(['now', '1m'])
    expect(draws.slice(2).every((values) => values.join() === 'now,1m')).toBe(true)
    vi.advanceTimersByTime(130_122 - Date.now())
    expect(draws.every((values) => values.length === 2)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(draws[1]).toEqual(['now', '1m', '2m'])
    expect(vi.getTimerCount()).toBe(1)
  } finally {
    for (const stop of stops) stop()
  }
  expect(vi.getTimerCount()).toBe(0)
})

it('creates no demand for imperative reads or disabled/unsubscribed React stores inside observers', () => {
  vi.useFakeTimers()
  vi.setSystemTime(42_101)
  const stop = autorun(() => {
    clockStore(() => nowForAge(since, relativeTimeNextChangeAt), false).subscribe(vi.fn())()
    clockStore(() => nowForAge(since, cardAgeNextChangeAt))
  })
  try {
    for (let i = 0; i < 100; i++) nowForAge(i, relativeTimeNextChangeAt)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(120_000)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    stop()
  }
})

it('catches up missed age boundaries immediately after an app wakes', () => {
  vi.useFakeTimers()
  vi.setSystemTime(since + 10_000)
  let active = true
  let wake: (() => void) | undefined
  setClockWakeSource({
    isActive: () => active,
    subscribe: (notify) => {
      wake = notify
      return () => {
        wake = undefined
      }
    },
  })
  const draws: string[] = []
  const stop = autorun(() => draws.push(cardAge(stamp, nowForAge(since, cardAgeNextChangeAt))))
  try {
    active = false
    wake?.()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(170_000)
    expect(draws).toEqual(['now'])
    active = true
    wake?.()
    expect(draws).toEqual(['now', '3m'])
    expect(vi.getTimerCount()).toBe(1)
  } finally {
    stop()
  }
  expect(vi.getTimerCount()).toBe(0)
})

it('retries a boundary crossed between sampling time and registering its deadline', () => {
  vi.useFakeTimers()
  vi.setSystemTime(since + 59_499)
  let crossed = false
  const nextChangeAt = (start: number, at: number) => {
    const next = relativeTimeNextChangeAt(start, at)
    if (!crossed) {
      crossed = true
      vi.setSystemTime(next)
    }
    return next
  }
  const draws: string[] = []
  const stop = autorun(() => draws.push(relativeTime(stamp, nowForAge(since, nextChangeAt))))
  try {
    expect(draws).toEqual(['1m ago'])
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(29_999)
    expect(draws).toEqual(['1m ago'])
    vi.advanceTimersByTime(1)
    expect(draws).toEqual(['1m ago', '2m ago'])
  } finally {
    stop()
  }
  expect(vi.getTimerCount()).toBe(0)
})

it('corrects independently phased ages on rewind before their first deadline fires', () => {
  vi.useFakeTimers()
  vi.setSystemTime(since + 120_000)
  // Start the scheduler before these samples so its last advance alone cannot
  // detect the correction. The latest observed time must be the rewind baseline.
  deadlineClock.advance(since)
  const detach = vi.fn()
  setClockWakeSource({ isActive: () => true, subscribe: () => detach })
  const first: string[] = [],
    second: string[] = []
  const other = since - 30_000
  const a = autorun(() =>
    first.push(relativeTime(stamp, nowForAge(since, relativeTimeNextChangeAt))),
  )
  const b = autorun(() =>
    second.push(
      relativeTime(new Date(other).toISOString(), nowForAge(other, relativeTimeNextChangeAt)),
    ),
  )
  try {
    expect(first).toEqual(['2m ago'])
    expect(second).toEqual(['3m ago'])
    expect(vi.getTimerCount()).toBe(1)
    vi.setSystemTime(since)
    refreshClocks()
    expect(first).toEqual(['2m ago', 'just now'])
    expect(second).toEqual(['3m ago', 'just now'])
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(29_499)
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(first).toHaveLength(2)
    expect(second).toEqual(['3m ago', 'just now', '1m ago'])
    vi.advanceTimersByTime(30_000)
    expect(first).toEqual(['2m ago', 'just now', '1m ago'])
    expect(second).toEqual(['3m ago', 'just now', '1m ago', '2m ago'])
    expect(vi.getTimerCount()).toBe(1)
  } finally {
    a()
    b()
  }
  expect(vi.getTimerCount()).toBe(0)
  expect(detach).toHaveBeenCalledTimes(1)
})

it('preserves the former formatter answers across negative ages and all units', () => {
  function formerRelative(at: number) {
    const s = Math.max(0, Math.round((at - since) / 1000))
    if (s < 60) return 'just now'
    const m = Math.round(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.round(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.round(h / 24)}d ago`
  }
  function formerCard(at: number) {
    const s = Math.max(0, Math.floor((at - since) / 1000))
    if (s < 60) return 'now'
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h`
    const d = Math.floor(h / 24)
    if (d < 7) return `${d}d`
    const w = Math.floor(d / 7)
    if (w < 53) return `${w}w`
    return `${Math.floor(d / 365)}y`
  }
  for (const age of [
    -1000,
    0,
    59_499,
    59_500,
    60_000,
    89_499,
    89_500,
    120_000,
    3_569_499,
    3_569_500,
    3_600_000,
    5_369_500,
    84_569_500,
    86_400_000,
    127_769_500,
    7 * 86_400_000,
    365 * 86_400_000,
    371 * 86_400_000,
    730 * 86_400_000,
  ]) {
    expect(relativeTime(stamp, since + age)).toBe(formerRelative(since + age))
    expect(cardAge(stamp, since + age)).toBe(formerCard(since + age))
  }
  for (const format of [relativeTime, cardAge]) expect(format('', Date.now())).toBe('')
  for (const next of [relativeTimeNextChangeAt, cardAgeNextChangeAt])
    expect(next(NaN, Date.now())).toBe(Infinity)
})
