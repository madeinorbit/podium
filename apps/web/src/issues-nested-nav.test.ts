import type { IssueWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { flattenRowGroups, issueRowsByStage } from './issue-hierarchy'
import { type IssuesKeyState, type IssuesNav, issuesKeyReduce } from './issues-keys'

/**
 * Nested-state coverage for the keyboard/selection glue (#85 review): the key
 * reducer is fed navs built exactly the way IssuesView builds them (from
 * `issueRowsByStage`), so these tests pin the interaction between expansion /
 * flatten state and focus, selection, and the bulk-op visibility filter.
 */

function issue(over: Partial<IssueWire> = {}): IssueWire {
  return {
    id: 'i',
    repoPath: '/home/u/acme',
    seq: 1,
    title: 'Fix login',
    description: '',
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedBy: [],
    priority: 2,
    type: 'task',
    pinned: false,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    archived: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    origin: 'human' as const,
    draft: false,
    ...over,
  } as IssueWire
}

const parent = issue({ id: 'p', stage: 'backlog', childCount: 2, seq: 1 })
const c1 = issue({ id: 'c1', parentId: 'p', stage: 'backlog', seq: 2 })
const c2 = issue({ id: 'c2', parentId: 'p', stage: 'in_progress', seq: 3 })
const lone = issue({ id: 'l', stage: 'planning', seq: 4 })
const all = [parent, c1, c2, lone]

/** Build the rows nav exactly like IssuesView's list layout does. */
function rowsNav(flatten: boolean, expanded: string[]): IssuesNav {
  return {
    kind: 'rows',
    ids: flattenRowGroups(
      issueRowsByStage(all, 'priority', { flatten, expanded: new Set(expanded) }),
    ),
  }
}

describe('keyboard nav over nested rows', () => {
  it('j/k walk THROUGH expanded children in visual order', () => {
    const nav = rowsNav(false, ['p'])
    let s: IssuesKeyState = { focusId: null, selected: [] }
    s = issuesKeyReduce(s, { kind: 'next' }, nav) // → p
    expect(s.focusId).toBe('p')
    s = issuesKeyReduce(s, { kind: 'next' }, nav) // → first child
    expect(s.focusId).toBe('c1')
    s = issuesKeyReduce(s, { kind: 'next' }, nav) // → second child
    expect(s.focusId).toBe('c2')
    s = issuesKeyReduce(s, { kind: 'next' }, nav) // → next root
    expect(s.focusId).toBe('l')
    s = issuesKeyReduce(s, { kind: 'prev' }, nav) // back into the children
    expect(s.focusId).toBe('c2')
  })

  it('j/k skip hidden children when the parent is collapsed', () => {
    const nav = rowsNav(false, [])
    let s: IssuesKeyState = { focusId: 'p', selected: [] }
    s = issuesKeyReduce(s, { kind: 'next' }, nav)
    expect(s.focusId).toBe('l')
  })

  it('collapsing the parent normalizes a child focus instead of pointing at a hidden row', () => {
    // Focus a child while expanded...
    let s: IssuesKeyState = { focusId: 'c1', selected: [] }
    // ...then the parent collapses; the next action sees the collapsed nav.
    s = issuesKeyReduce(s, { kind: 'next' }, rowsNav(false, []))
    // Vanished focus resets to null, so `next` lands on the first visible row.
    expect(s.focusId).toBe('p')
  })
})

describe('selection vs expansion/flatten (the bulk-op visibility filter)', () => {
  /** IssuesView's presentIds filter: bulk ops act only on visible selected ids. */
  function visibleSelected(selected: string[], nav: IssuesNav): string[] {
    const present = new Set(nav.kind === 'rows' ? nav.ids : nav.columns.flat())
    return selected.filter((id) => present.has(id))
  }

  it('x-selected child → collapse → the bulk-op set excludes the hidden child', () => {
    const expandedNav = rowsNav(false, ['p'])
    let s: IssuesKeyState = { focusId: 'c1', selected: [] }
    s = issuesKeyReduce(s, { kind: 'toggleSelect' }, expandedNav)
    expect(s.selected).toEqual(['c1'])
    // Parent collapses: the raw selection still holds the id, but the visible
    // filter (what BulkBar and the mutations run over) drops it.
    expect(visibleSelected(s.selected, rowsNav(false, []))).toEqual([])
    // Re-expanding brings it back — nothing was destructively cleared.
    expect(visibleSelected(s.selected, rowsNav(false, ['p']))).toEqual(['c1'])
  })

  it('flatten-toggle mid-selection: child selected flat stays selected only while visible', () => {
    const flatNav = rowsNav(true, [])
    let s: IssuesKeyState = { focusId: 'c2', selected: [] }
    s = issuesKeyReduce(s, { kind: 'toggleSelect' }, flatNav)
    expect(visibleSelected(s.selected, flatNav)).toEqual(['c2'])
    // Un-flatten (collapsed): the child is hidden → excluded from bulk ops.
    const nestedNav = rowsNav(false, [])
    expect(visibleSelected(s.selected, nestedNav)).toEqual([])
    // And the reducer normalizes the now-hidden focus on the next action.
    s = issuesKeyReduce(s, { kind: 'next' }, nestedNav)
    expect(s.focusId).toBe('p')
  })

  it('board nav (roots-only columns) never exposes children to selection', () => {
    const columns: IssuesNav = {
      kind: 'columns',
      columns: [['p'], ['l']], // backlog + planning lanes, roots only
    }
    let s: IssuesKeyState = { focusId: 'c1', selected: ['c1', 'p'] }
    expect(visibleSelected(s.selected, columns)).toEqual(['p'])
    s = issuesKeyReduce(s, { kind: 'next' }, columns)
    expect(s.focusId).toBe('p') // hidden focus normalized → first visible
  })
})
