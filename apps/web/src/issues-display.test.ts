import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DISPLAY,
  orderIssues,
  readIssuesDisplay,
  writeIssuesDisplay,
} from './issues-display'
import { makeIssue as issue } from './test-issue'

describe('readIssuesDisplay', () => {
  it('defaults on null/garbage/partial input', () => {
    expect(readIssuesDisplay(null)).toEqual(DEFAULT_DISPLAY)
    expect(readIssuesDisplay('not json')).toEqual(DEFAULT_DISPLAY)
    const d = readIssuesDisplay(JSON.stringify({ layout: 'list' }))
    expect(d.layout).toBe('list')
    expect(d.ordering).toBe(DEFAULT_DISPLAY.ordering)
    expect(d.badges).toEqual(DEFAULT_DISPLAY.badges)
  })
  it('rejects unknown enum values', () => {
    expect(readIssuesDisplay(JSON.stringify({ layout: 'gantt' })).layout).toBe('board')
  })
  it('round-trips through write', () => {
    const d = { ...DEFAULT_DISPLAY, layout: 'list' as const, ordering: 'priority' as const }
    expect(readIssuesDisplay(writeIssuesDisplay(d))).toEqual(d)
  })
})

describe('orderIssues', () => {
  it('priority: ascending priority, then seq', () => {
    const a = issue({ id: 'a', seq: 2, priority: 2 })
    const b = issue({ id: 'b', seq: 1, priority: 0 })
    const c = issue({ id: 'c', seq: 3, priority: 2 })
    expect(orderIssues([a, c, b], 'priority').map((i) => i.id)).toEqual(['b', 'a', 'c'])
  })
  it('updated: most recently updated first; created likewise', () => {
    const old = issue({ id: 'old', updatedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-02T00:00:00Z' })
    const fresh = issue({ id: 'new', updatedAt: '2026-06-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' })
    expect(orderIssues([old, fresh], 'updated')[0]?.id).toBe('new')
    expect(orderIssues([old, fresh], 'created')[0]?.id).toBe('old')
  })
  it('does not mutate its input', () => {
    const list = [issue({ id: 'a', priority: 3 }), issue({ id: 'b', priority: 0 })]
    orderIssues(list, 'priority')
    expect(list[0]?.id).toBe('a')
  })
})
