import { describe, expect, it } from 'vitest'
import { issueStatusOf } from '../entities/issue-status'
import { isClosed, isExcluded, isFinished } from './issue-lifecycle'
import { isIssueClosed } from './issue-stage'

describe('issue lifecycle facts', () => {
  it.each([
    ['in_progress', undefined, false, false],
    ['in_progress', null, false, false],
    ['in_progress', '', true, true],
    ['review', ' ', true, true],
    ['review', 'shipped', true, true],
    ['done', undefined, true, false],
    ['done', null, true, false],
    ['done', '', true, true],
    ['done', 'cancelled', true, true],
  ] as const)('%s with reason %s: finished=%s, recorded closure=%s', (stage, closedReason, finished, closed) => {
    const row = { stage, closedReason }
    expect(isFinished(row)).toBe(finished)
    expect(isIssueClosed(row)).toBe(finished)
    expect(isClosed(row)).toBe(closed)
    expect(isExcluded(row)).toBe(false)
  })

  it('keeps the status projection coherent with an explicit empty reason', () => {
    expect(issueStatusOf({ stage: 'in_progress', closedReason: '' })).toBe('done')
  })

  it.each([
    [{ stage: 'proposed' }, true], [{ stage: 'shipping' }, true],
    [{ stage: 'done' }, false], [{ archived: true }, true],
    [{ deletedAt: '' }, true], [{ deletedAt: null, archived: false }, false],
    [{}, false],
  ])('worklist exclusion for %j is %s', (row, excluded) => {
    expect(isExcluded(row)).toBe(excluded)
  })
})
