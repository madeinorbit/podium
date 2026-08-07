/**
 * The presentation grouping POD-591 added to the activity feed.
 *
 * The defect it fixes was visible rather than logical — a live task rendered
 * thirty consecutive rows reading `read  2026-08-07T20:21:24.588Z` — so these
 * assert the two decisions that make that impossible to reproduce: minor runs
 * collapse, and a row's stamp is a clock time rather than an ISO string.
 */
import { describe, expect, it } from 'vitest'
import { type ActivityItem, eventClock, groupActivityFeed, ROLLUP_MIN } from './issue-events'

/** Local noon on a given day — so a test never straddles a UTC day boundary. */
const at = (day: number, hour: number, minute = 0): string =>
  new Date(2026, 6, day, hour, minute, 0).toISOString()

const evt = (id: string, ts: string, text: string, minor = false): ActivityItem => ({
  kind: 'event',
  id,
  ts,
  line: { icon: 'generic', text, ...(minor ? { minor: true } : {}) },
})

const comment = (id: string, ts: string, body: string): ActivityItem => ({
  kind: 'comment',
  id,
  ts,
  author: 'sole',
  body,
})

describe('groupActivityFeed', () => {
  const now = new Date(2026, 6, 10, 12, 0, 0).getTime()

  it('splits entries into local calendar days, oldest first', () => {
    const days = groupActivityFeed(
      [
        evt('a', at(8, 9), 'created'),
        evt('b', at(9, 9), 'moved to Review'),
        evt('c', at(10, 9), 'closed (done)'),
      ],
      now,
    )
    // The two recent days are named; the older one takes a locale date, so it
    // is asserted by its parts rather than by one locale's ordering.
    expect(days.map((d) => d.label).slice(1)).toEqual(['Yesterday', 'Today'])
    expect(days[0]?.label).toMatch(/Jul/)
    expect(days[0]?.label).toMatch(/\b8\b/)
    expect(days.map((d) => d.entries.length)).toEqual([1, 1, 1])
  })

  it('collapses a run of minor events into one rollup', () => {
    const run = Array.from({ length: 6 }, (_, i) => evt(`r${i}`, at(10, 9, i), 'read', true))
    const [day] = groupActivityFeed([evt('x', at(10, 8), 'created'), ...run], now)
    const entries = day?.entries ?? []
    expect(entries).toHaveLength(2)
    expect(entries[0]?.kind).toBe('event')
    const rollup = entries[1]
    expect(rollup?.kind).toBe('rollup')
    if (rollup?.kind !== 'rollup') throw new Error('expected a rollup')
    expect(rollup.count).toBe(6)
    expect(rollup.label).toBe('6 × read')
    // The originals are kept in order, so expanding shows exactly what was hidden.
    expect(rollup.items.map((i) => i.id)).toEqual(run.map((i) => i.id))
    expect(rollup.firstTs).toBe(run[0]?.ts)
    expect(rollup.ts).toBe(run[run.length - 1]?.ts)
  })

  it('leaves a short run inline — collapsing two lines into one hides as much as it saves', () => {
    const short = Array.from({ length: ROLLUP_MIN - 1 }, (_, i) =>
      evt(`s${i}`, at(10, 9, i), 'read', true),
    )
    const [day] = groupActivityFeed(short, now)
    expect(day?.entries.every((e) => e.kind === 'event')).toBe(true)
  })

  it('names a mixed run generically rather than claiming one of its labels', () => {
    const mixed = [
      evt('m0', at(10, 9, 0), 'read', true),
      evt('m1', at(10, 9, 1), 'panel', true),
      evt('m2', at(10, 9, 2), 'read', true),
    ]
    const rollup = groupActivityFeed(mixed, now)[0]?.entries[0]
    if (rollup?.kind !== 'rollup') throw new Error('expected a rollup')
    expect(rollup.label).toBe('3 background events')
  })

  it('a comment breaks a run — a human interjection is never swallowed by churn', () => {
    const entries =
      groupActivityFeed(
        [
          ...Array.from({ length: 4 }, (_, i) => evt(`a${i}`, at(10, 9, i), 'read', true)),
          comment('c1', at(10, 9, 5), 'looks right'),
          ...Array.from({ length: 4 }, (_, i) => evt(`b${i}`, at(10, 9, 6 + i), 'read', true)),
        ],
        now,
      )[0]?.entries ?? []
    expect(entries.map((e) => e.kind)).toEqual(['rollup', 'comment', 'rollup'])
  })

  it('is empty for an empty feed', () => {
    expect(groupActivityFeed([], now)).toEqual([])
  })
})

describe('eventClock', () => {
  it('renders a clock time, never the ISO string the feed used to print', () => {
    const out = eventClock(at(10, 21, 58))
    expect(out).toMatch(/^\d{2}:\d{2}$/)
    expect(out).not.toContain('T')
    expect(out).not.toContain('Z')
  })

  it('passes an unparseable value straight through rather than rendering NaN', () => {
    expect(eventClock('not-a-date')).toBe('not-a-date')
  })
})
