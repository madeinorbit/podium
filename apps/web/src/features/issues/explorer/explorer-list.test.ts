import { portfolioActionableCount } from '@podium/client-core/viewmodels'
import type { IssueStage, SessionMeta } from '@podium/model'
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { IssueViewModel } from '@/app/store'
import { defaultTab, explorerCounts, explorerRows, matchesQuery } from './explorer-list'

function issue(id: string, stage: IssueStage, patch: Partial<IssueViewModel> = {}): IssueViewModel {
  return {
    id,
    seq: Number(id.replace(/\D/g, '')) || 1,
    title: `Task ${id}`,
    stage,
    repoPath: '/repo',
    updatedAt: '2026-08-01T00:00:00.000Z',
    archived: false,
    ...patch,
  } as IssueViewModel
}

const waiting = {
  sessionId: asSessionId('s-waiting'),
  issueId: 'needy',
  archived: false,
  agentState: { phase: 'needs_user' },
} as unknown as SessionMeta

describe('explorer rows', () => {
  const issues = [
    issue('a', 'in_progress', { updatedAt: '2026-08-03T00:00:00.000Z' }),
    issue('b', 'in_progress', { updatedAt: '2026-08-05T00:00:00.000Z' }),
    issue('c', 'proposed'),
    issue('gone', 'in_progress', { archived: true }),
  ]

  it('lists one stage at a time, newest activity first', () => {
    const rows = explorerRows(issues, [], { tab: 'in_progress', query: '' })
    expect(rows.map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('never lists archived or deleted work', () => {
    const rows = explorerRows(issues, [], { tab: 'in_progress', query: '' })
    expect(rows.some((r) => r.id === 'gone')).toBe(false)
  })

  it('lets a live query override the tab and search every stage', () => {
    // Someone typing a ref wants that task, not that task if it happens to sit
    // in the bucket they last clicked.
    const rows = explorerRows(issues, [], { tab: 'in_progress', query: 'Task c' })
    expect(rows.map((r) => r.id)).toEqual(['c'])
  })

  it('matches on ref and title only', () => {
    const target = issue('x', 'backlog', { seq: 512, title: 'Merge lock lease expiry' })
    expect(matchesQuery(target, 'lease')).toBe(true)
    expect(matchesQuery(target, '512')).toBe(true)
    expect(matchesQuery(target, '')).toBe(true)
    expect(matchesQuery(target, 'nothing like it')).toBe(false)
  })

  it('collects what is asking something of the operator under one tab', () => {
    const needy = [issue('needy', 'backlog'), issue('quiet', 'backlog')]
    const rows = explorerRows(needy, [waiting], { tab: 'needs', query: '' })
    expect(rows.map((r) => r.id)).toEqual(['needy'])
  })
})

describe('explorer counts', () => {
  it('counts every stage over the listable set', () => {
    const counts = explorerCounts(
      [
        issue('a', 'in_progress'),
        issue('b', 'review'),
        issue('c', 'review'),
        issue('gone', 'review', { archived: true }),
      ],
      [],
    )
    expect(counts.in_progress).toBe(1)
    expect(counts.review).toBe(2)
    expect(counts.proposed).toBe(0)
  })

  it('agrees with the rail badge about how many tasks need you', () => {
    // Two surfaces re-deriving "needs me" independently is how a badge reading
    // 3 comes to sit above a list of 5. Same predicate, same number.
    const issues = [issue('needy', 'backlog'), issue('quiet', 'planning'), issue('shipped', 'done')]
    const counts = explorerCounts(issues, [waiting])
    expect(counts.needs).toBe(portfolioActionableCount(issues, [waiting]))
    expect(counts.needs).toBe(1)
  })

  it('opens on the first tab with anything in it', () => {
    const counts = explorerCounts([issue('c', 'proposed')], [])
    expect(defaultTab(counts)).toBe('proposed')
    expect(counts.needs).toBe(0)
  })
})
