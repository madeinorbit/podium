import { portfolioActionableCount } from '@podium/client-core/viewmodels'
import type { IssueStage, SessionMeta } from '@podium/model'
import { asIssueId, asSessionId } from '@podium/model'
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

  it('finds an archived task by exact ref without widening ordinary search', () => {
    const archived = issue('archived', 'done', {
      seq: 766,
      displayRef: 'POD-766',
      title: 'Minimap stale-tick crash',
      archived: true,
    })
    const all = [...issues, archived]

    expect(
      explorerRows(all, [], { tab: 'in_progress', query: 'POD-766' }).map((r) => r.id),
    ).toEqual(['archived'])
    expect(
      explorerRows(all, [], { tab: 'in_progress', query: 'pod-766' }).map((r) => r.id),
    ).toEqual(['archived'])
    expect(explorerRows(all, [], { tab: 'in_progress', query: 'POD-76' })).toEqual([])
    expect(explorerRows(all, [], { tab: 'in_progress', query: 'minimap' })).toEqual([])
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

  it('never lists the draft vessel a bare agent lives in', () => {
    // POD-1581: the explorer was the one surface that showed these, and it
    // showed them as a row titled `Draft` with nothing under it.
    const withVessel = [issue('real', 'backlog'), issue('vessel', 'backlog', { draft: true })]
    const rows = explorerRows(withVessel, [], { tab: 'backlog', query: '' })
    expect(rows.map((r) => r.id)).toEqual(['real'])
  })

  it('does not surface a vessel through ordinary search', () => {
    const withVessel = [issue('vessel', 'backlog', { draft: true, title: 'Draft' })]
    expect(explorerRows(withVessel, [], { tab: 'backlog', query: 'Draft' })).toEqual([])
  })

  it('still resolves a whole ref that scope would otherwise hide', () => {
    // Scope is a browsing boundary. Someone typing `POD-1234` off a transcript
    // has already decided which task they want, and this dock is the only
    // ref-jump in the shell — answering "no match" about a task that exists is
    // a broken search, not a narrow one.
    const hidden = [
      issue('internal', 'backlog', { audience: 'agent', displayRef: 'POD-1234' }),
      issue('vessel', 'backlog', { draft: true, displayRef: 'POD-1443' }),
    ]
    expect(
      explorerRows(hidden, [], { tab: 'backlog', query: 'POD-1234' }).map((r) => r.id),
    ).toEqual(['internal'])
    expect(
      explorerRows(hidden, [], { tab: 'backlog', query: 'pod-1443' }).map((r) => r.id),
    ).toEqual(['vessel'])
  })

  it('keeps top-level agent-internal work off the list, as the board does', () => {
    const internal = [
      issue('human', 'backlog'),
      issue('internal', 'backlog', { audience: 'agent' }),
    ]
    const rows = explorerRows(internal, [], { tab: 'backlog', query: '' })
    expect(rows.map((r) => r.id)).toEqual(['human'])
  })

  it('still lists agent-internal decomposition under a visible parent', () => {
    // Scope hides internal work at TOP level only; a sub-issue of real work is
    // real work, and the explorer is flat, so it has to appear as its own row.
    const tree = [
      issue('epic', 'in_progress'),
      issue('sub', 'backlog', { audience: 'agent', parentId: asIssueId('epic') }),
    ]
    const rows = explorerRows(tree, [], { tab: 'backlog', query: '' })
    expect(rows.map((r) => r.id)).toEqual(['sub'])
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

  it('agrees with the portfolio count over the work it lists', () => {
    // Two surfaces re-deriving "needs me" independently is how a badge reading
    // 3 comes to sit above a list of 5. Same predicate, same number — over the
    // population the explorer lists. POD-1581 narrowed that population, and the
    // vessel case below is the one deliberate divergence.
    const issues = [issue('needy', 'backlog'), issue('quiet', 'planning'), issue('shipped', 'done')]
    const counts = explorerCounts(issues, [waiting])
    expect(counts.needs).toBe(portfolioActionableCount(issues, [waiting]))
    expect(counts.needs).toBe(1)
  })

  it('leaves draft vessels out of the numbers too', () => {
    // A tab count that included rows the list refuses to show would read as a
    // filter that is silently dropping work.
    const counts = explorerCounts(
      [
        issue('real', 'backlog'),
        issue('vessel', 'backlog', { draft: true }),
        issue('needy', 'backlog', { draft: true }),
      ],
      [{ ...waiting, issueId: 'needy' } as SessionMeta],
    )
    expect(counts.backlog).toBe(1)
    expect(counts.needs).toBe(0)
  })

  it('opens on the first tab with anything in it', () => {
    const counts = explorerCounts([issue('c', 'proposed')], [])
    expect(defaultTab(counts)).toBe('proposed')
    expect(counts.needs).toBe(0)
  })
})
