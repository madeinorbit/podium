import { describe, expect, it } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { DEFAULT_DISPLAY } from './issues-display'
import { deriveIssuesViewModel } from './issues-view-model'

const display = (over: Partial<typeof DEFAULT_DISPLAY> = {}) => ({
  ...DEFAULT_DISPLAY,
  ...over,
  badges: { ...DEFAULT_DISPLAY.badges, ...over.badges },
})

describe('deriveIssuesViewModel', () => {
  it('keeps scope-wide counts while the board/list use the active filter', () => {
    const root = makeIssue({ id: 'root', stage: 'backlog', type: 'epic', childCount: 1 })
    const child = makeIssue({ id: 'child', parentId: 'root', stage: 'review' })
    const other = makeIssue({ id: 'other', stage: 'in_progress' })
    const archived = makeIssue({ id: 'archived', archived: true, stage: 'review' })

    const model = deriveIssuesViewModel({
      issues: [root, child, other, archived],
      display: display(),
      filter: { stage: 'review' },
      expanded: new Set(),
      isMobile: false,
      openIssueId: null,
    })

    expect(model.scope.map((issue) => issue.id)).toEqual(['root', 'child', 'other'])
    expect(model.active.map((issue) => issue.id)).toEqual(['child'])
    expect(model.boardIssues.map((issue) => issue.id)).toEqual(['child'])
    expect(model.stageCounts.get('root')).toEqual([{ stage: 'review', count: 1 }])
    expect(model.epicProgress.get('child')).toBeNull()
    expect(model.epicProgress.has('root')).toBe(false)
  })

  it('shares hierarchy, list order, board columns, and deep-link navigation', () => {
    const root = makeIssue({ id: 'root', stage: 'backlog', type: 'epic' })
    const child = makeIssue({ id: 'child', parentId: 'root', stage: 'review' })
    const other = makeIssue({ id: 'other', stage: 'done' })

    const model = deriveIssuesViewModel({
      issues: [root, child, other],
      display: display(),
      filter: {},
      expanded: new Set(),
      isMobile: false,
      openIssueId: 'child',
    })

    expect(model.boardIssues.map((issue) => issue.id)).toEqual(['root', 'other'])
    expect(model.nav).toEqual({
      kind: 'columns',
      columns: [[], ['root'], [], [], [], ['other']],
    })
    expect(model.listIds).toEqual(['root', 'other'])
    expect(model.orderedIdsForOpen).toEqual(['root', 'child', 'other'])
    expect(model.epicProgress.get('root')).toEqual({ total: 1, done: 0, liveAgents: 0 })
  })

  it('uses list navigation on mobile without changing the board display preference', () => {
    const a = makeIssue({ id: 'a', stage: 'review' })
    const model = deriveIssuesViewModel({
      issues: [a],
      display: display({ layout: 'board' }),
      filter: {},
      expanded: new Set(),
      isMobile: true,
      openIssueId: null,
    })
    expect(model.layout).toBe('list')
    expect(model.nav).toEqual({ kind: 'rows', ids: ['a'] })
  })
})
