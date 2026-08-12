import type { IssueWire, IssueWireInput } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { taskBoardOrder, taskBoardSections, taskNeighbours } from './task-board'

/**
 * The defect POD-724 fixes is a POPULATION defect, so these cases are about which
 * rows exist and in what order — not about how they look. The nesting emitter
 * itself is covered where it lives now
 * (`packages/client-core/src/viewmodels/issue-board-rows.test.ts`); what is
 * asserted here is that the phone feeds it the desktop's arguments.
 */
function issue(over: Partial<IssueWireInput> = {}): IssueWire {
  return {
    id: 'i',
    repoPath: '/r',
    seq: 1,
    title: 't',
    description: '',
    stage: 'backlog',
    priority: 2,
    type: 'task',
    audience: 'human',
    origin: 'human',
    draft: false,
    archived: false,
    labels: [],
    deps: [],
    dependents: [],
    blockedByNotes: [],
    ready: true,
    blocked: false,
    deferred: false,
    pinned: false,
    needsHuman: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  } as IssueWire
}

const rowIds = (sections: ReturnType<typeof taskBoardSections>) =>
  sections.flatMap((s) => s.rows.map((r) => r.issue.id))

describe('taskBoardSections', () => {
  it('nests children under their parent instead of listing them at top level', () => {
    const epic = issue({ id: 'epic', stage: 'in_progress', type: 'epic', childCount: 2 })
    const kid1 = issue({ id: 'k1', parentId: 'epic', stage: 'in_progress', seq: 2 })
    const kid2 = issue({ id: 'k2', parentId: 'epic', stage: 'done', seq: 3 })

    const collapsed = taskBoardSections([epic, kid1, kid2], new Set(), { showDone: true })
    expect(rowIds(collapsed)).toEqual(['epic'])
    expect(collapsed[0]?.rows[0]).toMatchObject({ depth: 0, childCount: 2, expanded: false })

    const open = taskBoardSections([epic, kid1, kid2], new Set(['epic']), { showDone: true })
    // The done child rides under its in-progress parent — the desktop's rule,
    // with the child's own stage glyph doing the disambiguating.
    expect(open.map((s) => s.stage)).toEqual(['in_progress'])
    expect(open[0]?.rows.map((r) => [r.issue.id, r.depth])).toEqual([
      ['epic', 0],
      ['k1', 1],
      ['k2', 1],
    ])
  })

  it('orders a stage by priority then seq, matching DEFAULT_DISPLAY', () => {
    const rows = taskBoardSections(
      [
        issue({ id: 'late', stage: 'review', priority: 3, seq: 1 }),
        issue({ id: 'urgent', stage: 'review', priority: 0, seq: 9 }),
        issue({ id: 'tie', stage: 'review', priority: 0, seq: 4 }),
      ],
      new Set(),
      { showDone: false },
    )
    expect(rowIds(rows)).toEqual(['tie', 'urgent', 'late'])
  })

  it('keeps agent-audience decomposition off the top level (showAgentTasks: false)', () => {
    const parent = issue({ id: 'p', stage: 'in_progress', childCount: 1 })
    const internal = issue({ id: 'agent', parentId: 'p', stage: 'in_progress', audience: 'agent' })
    const loose = issue({ id: 'loose', stage: 'in_progress', audience: 'agent' })

    const collapsed = taskBoardSections([parent, internal, loose], new Set(), { showDone: false })
    // The loose internal task has no visible ancestor and is gone entirely; the
    // nested one exists but only under its parent.
    expect(rowIds(collapsed)).toEqual(['p'])
    const open = taskBoardSections([parent, internal, loose], new Set(['p']), { showDone: false })
    expect(rowIds(open)).toEqual(['p', 'agent'])
  })

  it('drops drafts, archived rows and tombstones, and empty stages', () => {
    const rows = taskBoardSections(
      [
        issue({ id: 'real', stage: 'backlog' }),
        issue({ id: 'draft', stage: 'backlog', draft: true }),
        issue({ id: 'gone', stage: 'backlog', archived: true }),
        issue({ id: 'tomb', stage: 'backlog', deletedAt: '2026-06-02T00:00:00.000Z' }),
      ],
      new Set(),
      { showDone: false },
    )
    expect(rows.map((s) => s.stage)).toEqual(['backlog'])
    expect(rowIds(rows)).toEqual(['real'])
  })

  it('leads with the moving stages and folds done behind the toggle', () => {
    const all = [
      issue({ id: 'a', stage: 'proposed' }),
      issue({ id: 'b', stage: 'backlog' }),
      issue({ id: 'c', stage: 'planning' }),
      issue({ id: 'd', stage: 'in_progress' }),
      issue({ id: 'e', stage: 'review' }),
      issue({ id: 'f', stage: 'done' }),
    ]
    expect(taskBoardSections(all, new Set(), { showDone: false }).map((s) => s.stage)).toEqual([
      'in_progress',
      'review',
      'planning',
      'backlog',
      'proposed',
    ])
    expect(taskBoardSections(all, new Set(), { showDone: true }).map((s) => s.stage)).toEqual([
      'in_progress',
      'review',
      'planning',
      'backlog',
      'proposed',
      'done',
    ])
  })
})

describe('taskBoardOrder / taskNeighbours', () => {
  it('walks every board task flat, so a nested child still has neighbours', () => {
    const epic = issue({ id: 'epic', stage: 'in_progress', childCount: 1 })
    const kid = issue({ id: 'kid', parentId: 'epic', stage: 'in_progress', seq: 2 })
    const other = issue({ id: 'other', stage: 'review' })
    const order = taskBoardOrder([epic, kid, other])
    expect(order).toContain('kid')
    expect(taskNeighbours(order, 'kid')).toEqual({ prev: 'epic', next: 'other' })
    expect(taskNeighbours(order, order[0] as string).prev).toBeUndefined()
    expect(taskNeighbours(order, 'nope')).toEqual({})
  })
})
