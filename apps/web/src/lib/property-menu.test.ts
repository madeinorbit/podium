import { describe, expect, it } from 'vitest'
import { filterPropertyOptions, groupPropertyOptions } from './property-menu'

describe('filterPropertyOptions', () => {
  const opts = [{ label: 'Backlog' }, { label: 'In Progress' }, { label: 'Review' }]
  it('empty query returns all; matching is case-insensitive substring', () => {
    expect(filterPropertyOptions(opts, '')).toHaveLength(3)
    expect(filterPropertyOptions(opts, ' pro ').map((o) => o.label)).toEqual(['In Progress'])
    // 're' matches "In Progress" (Prog·re·ss) and "Review", but not "Backlog".
    expect(filterPropertyOptions(opts, 'RE')).toHaveLength(2)
  })
})

describe('groupPropertyOptions', () => {
  it('keeps consecutive same-group items together and treats no group as its own run', () => {
    expect(
      groupPropertyOptions([
        { label: 'Auto' },
        { label: 'Opus', group: 'Claude Code' },
        { label: 'Sonnet', group: 'Claude Code' },
        { label: 'GPT-5.5', group: 'Codex' },
      ]),
    ).toEqual([
      { options: [{ label: 'Auto' }] },
      {
        group: 'Claude Code',
        options: [
          { label: 'Opus', group: 'Claude Code' },
          { label: 'Sonnet', group: 'Claude Code' },
        ],
      },
      { group: 'Codex', options: [{ label: 'GPT-5.5', group: 'Codex' }] },
    ])
  })
})
