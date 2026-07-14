import { describe, expect, it } from 'vitest'
import {
  assertScheduleFloor,
  isValidCron,
  MIN_SCHEDULE_INTERVAL_MS,
  minIntervalMs,
  nextAfter,
  nextRunAfter,
  parseCron,
  respectsScheduleFloor,
} from './cron'

/** Local-time constructor — the parser evaluates cron in SERVER-LOCAL time, so the
 *  tests must build their instants the same way (a UTC literal would make every
 *  assertion depend on the machine's TZ). */
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date =>
  new Date(y, mo - 1, d, h, mi, s)

const next = (expr: string, from: Date): string | null =>
  nextRunAfter(expr, from)?.toString() ?? null

describe('parseCron', () => {
  it('parses the expressions the composer emits', () => {
    expect(parseCron('0 * * * *').minutes).toEqual([0]) // hourly
    expect(parseCron('0 9 * * *').hours).toEqual([9]) // daily 09:00
    expect(parseCron('30 4 * * 0').daysOfWeek).toEqual([0]) // weekly Sunday 04:30
    expect(parseCron('*/30 * * * *').minutes).toEqual([0, 30]) // custom
  })

  it('parses lists, ranges, steps and step-over-range', () => {
    expect(parseCron('1,5,9 * * * *').minutes).toEqual([1, 5, 9])
    expect(parseCron('0 9-12 * * *').hours).toEqual([9, 10, 11, 12])
    expect(parseCron('0 */6 * * *').hours).toEqual([0, 6, 12, 18])
    expect(parseCron('0 8-18/4 * * *').hours).toEqual([8, 12, 16])
    // A bare value with a step reads as "from n to the field max, every s" (vixie).
    expect(parseCron('0 9/5 * * *').hours).toEqual([9, 14, 19])
  })

  it('normalizes weekday 7 to Sunday and de-duplicates', () => {
    expect(parseCron('0 0 * * 7').daysOfWeek).toEqual([0])
    expect(parseCron('0 0 * * 0,7').daysOfWeek).toEqual([0])
  })

  it('records which of day-of-month / day-of-week is restricted', () => {
    const spec = parseCron('0 0 1 * 1')
    expect(spec.domRestricted).toBe(true)
    expect(spec.dowRestricted).toBe(true)
    expect(parseCron('0 0 * * *').domRestricted).toBe(false)
  })

  it('rejects garbage with a message the composer can show', () => {
    expect(() => parseCron('')).toThrow(/5 fields/)
    expect(() => parseCron('0 9 * *')).toThrow(/5 fields/)
    expect(() => parseCron('0 9 * * * *')).toThrow(/5 fields/)
    expect(() => parseCron('60 * * * *')).toThrow(/minute out of range/)
    expect(() => parseCron('0 24 * * *')).toThrow(/hour out of range/)
    expect(() => parseCron('0 0 0 * *')).toThrow(/day-of-month out of range/)
    expect(() => parseCron('0 0 * 13 *')).toThrow(/month out of range/)
    expect(() => parseCron('0 0 * * 8')).toThrow(/day-of-week out of range/)
    expect(() => parseCron('0 0 * * mon')).toThrow(/invalid day-of-week/)
    expect(() => parseCron('*/0 * * * *')).toThrow(/invalid step/)
    expect(() => parseCron('9-5 * * * *')).toThrow(/out of range/)
    expect(isValidCron('0 9 * * *')).toBe(true)
    expect(isValidCron('nonsense')).toBe(false)
  })
})

describe('nextAfter', () => {
  it('is strictly after the given instant — never the same minute', () => {
    // Standing exactly ON an occurrence must yield the NEXT one, or a fired
    // automation would re-fire on the same minute forever.
    expect(next('0 9 * * *', at(2026, 7, 14, 9, 0, 0))).toBe(at(2026, 7, 15, 9, 0).toString())
    // Mid-minute at 09:00:30 is still "past" the 09:00 occurrence.
    expect(next('0 9 * * *', at(2026, 7, 14, 9, 0, 30))).toBe(at(2026, 7, 15, 9, 0).toString())
    // A second before it, the same day's occurrence is still ahead.
    expect(next('0 9 * * *', at(2026, 7, 14, 8, 59, 59))).toBe(at(2026, 7, 14, 9, 0).toString())
  })

  it('finds the next hourly / daily / weekly occurrence', () => {
    expect(next('0 * * * *', at(2026, 7, 14, 9, 15))).toBe(at(2026, 7, 14, 10, 0).toString())
    expect(next('0 9 * * *', at(2026, 7, 14, 10, 0))).toBe(at(2026, 7, 15, 9, 0).toString())
    // 2026-07-14 is a Tuesday; the next Sunday is the 19th.
    expect(next('30 4 * * 0', at(2026, 7, 14, 12, 0))).toBe(at(2026, 7, 19, 4, 30).toString())
  })

  it('rolls over month and year boundaries', () => {
    expect(next('0 0 1 * *', at(2026, 7, 14, 12, 0))).toBe(at(2026, 8, 1, 0, 0).toString())
    expect(next('0 0 1 1 *', at(2026, 7, 14, 12, 0))).toBe(at(2027, 1, 1, 0, 0).toString())
  })

  it('honors the classic OR rule when BOTH day-of-month and weekday are restricted', () => {
    // "the 1st, and every Monday". 2026-07-14 is a Tuesday → the next Monday (20th)
    // comes before the next 1st (August).
    expect(next('0 0 1 * 1', at(2026, 7, 14, 12, 0))).toBe(at(2026, 7, 20, 0, 0).toString())
    // With only day-of-month restricted, weekdays are irrelevant.
    expect(next('0 0 1 * *', at(2026, 7, 14, 12, 0))).toBe(at(2026, 8, 1, 0, 0).toString())
  })

  it('finds a leap day within the search horizon', () => {
    // 2028 is the next leap year — well inside the 4-year horizon.
    expect(next('0 0 29 2 *', at(2026, 7, 14, 12, 0))).toBe(at(2028, 2, 29, 0, 0).toString())
  })

  it('returns null for an expression that can never fire', () => {
    expect(nextAfter(parseCron('0 0 30 2 *'), at(2026, 7, 14))).toBeNull() // February 30th
  })
})

describe('the 5-minute rate floor (#470)', () => {
  const from = at(2026, 7, 14, 12, 0)
  const gap = (expr: string, ref: Date = from): number | null => minIntervalMs(parseCron(expr), ref)

  it('rejects a schedule that fires more often than once every 5 minutes', () => {
    // The footgun itself: an empty custom-cron box used to fall back to this, and
    // every fire spawns a REAL agent session — 1440 of them a day.
    expect(respectsScheduleFloor('* * * * *', from)).toBe(false)
    expect(gap('* * * * *')).toBe(60_000)
    expect(() => assertScheduleFloor('* * * * *', from)).toThrow(/too frequent/)

    expect(respectsScheduleFloor('*/2 * * * *', from)).toBe(false)
    expect(respectsScheduleFloor('*/4 * * * *', from)).toBe(false)
    // Two fires a minute apart, once a day: the AVERAGE rate is tiny, but two agent
    // sessions land 60s apart — the floor is about the gap, not the average.
    expect(respectsScheduleFloor('0,1 9 * * *', from)).toBe(false)
    // Across the midnight wrap: 23:59 then 00:00 is a 1-minute gap.
    expect(respectsScheduleFloor('59 23 * * *', from)).toBe(true) // once a day, fine
    expect(respectsScheduleFloor('0,59 0,23 * * *', from)).toBe(false) // 23:59 → 00:00
  })

  it('accepts a schedule at or above the floor', () => {
    expect(respectsScheduleFloor('*/5 * * * *', from)).toBe(true)
    expect(gap('*/5 * * * *')).toBe(MIN_SCHEDULE_INTERVAL_MS) // exactly 5 min = allowed
    expect(() => assertScheduleFloor('*/5 * * * *', from)).not.toThrow()

    expect(respectsScheduleFloor('*/15 * * * *', from)).toBe(true)
    // Every expression the composer's own frequency picker can build.
    expect(respectsScheduleFloor('0 * * * *', from)).toBe(true) // hourly
    expect(respectsScheduleFloor('0 9 * * *', from)).toBe(true) // daily
    expect(respectsScheduleFloor('30 4 * * 0', from)).toBe(true) // weekly
  })

  it('is independent of the wall-clock instant it is checked at', () => {
    // Anchoring the walk at `now` rather than at the first occurrence would let
    // `0,1 9 * * *` read as a 24-hour gap from 09:00:30 and a 1-minute gap from
    // 08:00 — a validator whose verdict depends on the second it ran.
    for (const ref of [
      at(2026, 7, 14, 8, 0),
      at(2026, 7, 14, 9, 0, 30),
      at(2026, 7, 14, 9, 1, 0),
      at(2026, 7, 14, 23, 59),
    ]) {
      expect(respectsScheduleFloor('0,1 9 * * *', ref)).toBe(false)
      expect(respectsScheduleFloor('*/5 * * * *', ref)).toBe(true)
    }
  })

  it('treats a sparse or never-firing schedule as no gap to violate', () => {
    expect(gap('0 0 1 1 *')).toBeNull() // annual: one fire in the scan horizon
    expect(gap('0 0 30 2 *')).toBeNull() // February 30th: never fires
    expect(respectsScheduleFloor('0 0 30 2 *', from)).toBe(true)
  })

  it('lets an unparseable expression through — the parse error is the one to show', () => {
    // zod runs both refines; the floor check must not add a second, confusing
    // message on top of "invalid cron expression".
    expect(respectsScheduleFloor('nonsense', from)).toBe(true)
    expect(respectsScheduleFloor('', from)).toBe(true)
  })
})
