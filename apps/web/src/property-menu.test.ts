import { describe, expect, it } from 'vitest'
import { filterPropertyOptions } from './property-menu'

describe('filterPropertyOptions', () => {
  const opts = [{ label: 'Backlog' }, { label: 'In Progress' }, { label: 'Review' }]
  it('empty query returns all; matching is case-insensitive substring', () => {
    expect(filterPropertyOptions(opts, '')).toHaveLength(3)
    expect(filterPropertyOptions(opts, ' pro ').map((o) => o.label)).toEqual(['In Progress'])
    // 're' matches "In Progress" (Prog·re·ss) and "Review", but not "Backlog".
    expect(filterPropertyOptions(opts, 'RE')).toHaveLength(2)
  })
})
