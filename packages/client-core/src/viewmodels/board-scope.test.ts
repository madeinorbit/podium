import type { IssueWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { boardIssues, filterBoardScope } from './board-scope'

function issue(over: Partial<IssueWire> = {}): IssueWire {
  return {
    id: 'issue',
    repoPath: '/r/a',
    seq: 1,
    title: 'Issue',
    description: '',
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'codex',
    blockedBy: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-23T10:00:00.000Z',
    archived: false,
    needsHuman: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    origin: 'human',
    audience: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    unread: false,
    ...over,
  } as IssueWire
}

const ids = (list: IssueWire[]): string[] => list.map((i) => i.id)

describe('boardIssues (the one board population, POD-338)', () => {
  it('drops DRAFT session vessels — the phone board showed them, the desktop never did', () => {
    const rows = [
      issue({ id: 'real' }),
      issue({ id: 'draft-a', draft: true, title: 'Draft' }),
      issue({ id: 'draft-b', draft: true, title: 'Draft' }),
    ]
    expect(ids(boardIssues(rows))).toEqual(['real'])
  })

  it('drops archived and tombstoned rows', () => {
    const rows = [
      issue({ id: 'live' }),
      issue({ id: 'gone', archived: true }),
      issue({ id: 'deleted', deletedAt: '2026-07-20T00:00:00.000Z' }),
    ]
    expect(ids(boardIssues(rows))).toEqual(['live'])
  })

  it('keeps agent-audience decomposition off the top level unless it hangs off visible work', () => {
    const rows = [
      issue({ id: 'parent' }),
      issue({ id: 'child', audience: 'agent', parentId: 'parent' }),
      issue({ id: 'orphan', audience: 'agent' }),
    ]
    expect(ids(boardIssues(rows))).toEqual(['parent', 'child'])
    expect(ids(boardIssues(rows, true))).toEqual(['parent', 'child', 'orphan'])
  })

  it('a deleted draft stays reachable through the tombstone filter', () => {
    const rows = [issue({ id: 'd', draft: true, deletedAt: '2026-07-20T00:00:00.000Z' })]
    // filterBoardScope keeps it (Show deleted can reveal it); boardIssues, which
    // is the live population, does not.
    expect(ids(filterBoardScope(rows, false))).toEqual(['d'])
    expect(ids(boardIssues(rows))).toEqual([])
  })
})
