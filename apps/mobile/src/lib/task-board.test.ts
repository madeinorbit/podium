import type { IssueWire, IssueWireInput } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { taskBoardOrder, taskBoardSections, taskNeighbours } from './task-board'

/**
 * The defect this file guards is a POPULATION defect: which rows exist on the
 * phone's Tasks tab, and in what order. Nesting itself lives in
 * `packages/client-core/src/viewmodels/issue-board-rows.test.ts`; what is
 * asserted here is that the phone asks that derivation for roots only, then
 * promotes screenable proposals so they are not trapped under an epic.
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
  it("lists roots only — an epic's decomposition stays off the tab", () => {
    const epic = issue({ id: 'epic', stage: 'in_progress', type: 'epic', childCount: 2 })
    const kid1 = issue({ id: 'k1', parentId: 'epic', stage: 'in_progress', seq: 2 })
    const kid2 = issue({ id: 'k2', parentId: 'epic', stage: 'done', seq: 3 })

    const sections = taskBoardSections([epic, kid1, kid2], { showDone: true })
    expect(rowIds(sections)).toEqual(['epic'])
    expect(sections[0]?.rows[0]).toMatchObject({ depth: 0, childCount: 2, expanded: false })
    expect(sections.map((s) => s.stage)).toEqual(['in_progress'])
  })

  it("reveals an expanded parent's children under it, whatever stage they are in", () => {
    // The defect: the phone passed an expanded set that could never grow, so a
    // sub-task existed on this tab only as a number on its parent while the
    // desktop board could open the same epic in place.
    const epic = issue({ id: 'epic', stage: 'in_progress', type: 'epic', childCount: 2 })
    const kid1 = issue({ id: 'k1', parentId: 'epic', stage: 'backlog', seq: 2 })
    const kid2 = issue({ id: 'k2', parentId: 'epic', stage: 'review', seq: 3 })

    const sections = taskBoardSections([epic, kid1, kid2], {
      showDone: false,
      expanded: new Set(['epic']),
    })

    // Both children ride in the PARENT's section — their own stage is the row's
    // glyph, not its lane — and they arrive indented.
    expect(sections.map((s) => s.stage)).toEqual(['in_progress'])
    expect(sections[0]?.rows.map((r) => [r.issue.id, r.depth])).toEqual([
      ['epic', 0],
      ['k1', 1],
      ['k2', 1],
    ])
    expect(sections[0]?.rows[0]).toMatchObject({ expanded: true, childCount: 2 })
  })

  it('hides them again when the parent is collapsed', () => {
    const epic = issue({ id: 'epic', stage: 'in_progress', type: 'epic', childCount: 1 })
    const kid = issue({ id: 'k1', parentId: 'epic', stage: 'backlog', seq: 2 })
    expect(
      rowIds(taskBoardSections([epic, kid], { showDone: false, expanded: new Set() })),
    ).toEqual(['epic'])
  })

  it('keeps a revealed child under its own parent when a promotion re-sorts the lane', () => {
    // Found in review: the promotion re-ordered the Proposed section ROW by row,
    // so an expanded root's children were sorted away from it and rendered
    // indented under whichever unrelated row landed in front.
    const first = issue({ id: 'first', stage: 'proposed', seq: 10 })
    const child = issue({ id: 'child', parentId: 'first', stage: 'backlog', seq: 40 })
    const second = issue({ id: 'second', stage: 'proposed', seq: 30 })
    const epic = issue({ id: 'epic', stage: 'in_progress', type: 'epic', childCount: 1 })
    const promoted = issue({ id: 'promoted', parentId: 'epic', stage: 'proposed', seq: 20 })

    const sections = taskBoardSections([first, child, second, epic, promoted], {
      showDone: false,
      expanded: new Set(['first']),
    })
    const proposed = sections.find((s) => s.stage === 'proposed')
    expect(proposed?.rows.map((r) => [r.issue.id, r.depth])).toEqual([
      ['first', 0],
      ['child', 1],
      ['promoted', 0],
      ['second', 0],
    ])
  })

  it('expands a promoted proposal too — its chevron is not a dead control', () => {
    // The shared derivation only ever emits a root's subtree, and a promoted
    // proposal is not a root: its sub-task count was rendered with nothing
    // behind it.
    const epic = issue({ id: 'epic', stage: 'in_progress', type: 'epic', childCount: 1 })
    const promoted = issue({ id: 'promoted', parentId: 'epic', stage: 'proposed', seq: 2 })
    const under = issue({ id: 'under', parentId: 'promoted', stage: 'backlog', seq: 3 })

    const collapsed = taskBoardSections([epic, promoted, under], { showDone: false })
    expect(collapsed.find((s) => s.stage === 'proposed')?.rows[0]).toMatchObject({
      childCount: 1,
      expanded: false,
    })

    const open = taskBoardSections([epic, promoted, under], {
      showDone: false,
      expanded: new Set(['promoted']),
    })
    expect(
      open.find((s) => s.stage === 'proposed')?.rows.map((r) => [r.issue.id, r.depth]),
    ).toEqual([
      ['promoted', 0],
      ['under', 1],
    ])
  })

  it('keeps done sub-tasks out of a reveal while Show done is off', () => {
    // A child rides in its PARENT's section whatever its own stage, so hiding
    // the Done section is not enough — the filter has to bind the population,
    // or the count on the chevron promises rows it must not show.
    const epic = issue({ id: 'epic', stage: 'in_progress', type: 'epic', childCount: 2 })
    const open = issue({ id: 'open', parentId: 'epic', stage: 'backlog', seq: 2 })
    const finished = issue({ id: 'finished', parentId: 'epic', stage: 'done', seq: 3 })

    const hidden = taskBoardSections([epic, open, finished], {
      showDone: false,
      expanded: new Set(['epic']),
    })
    expect(rowIds(hidden)).toEqual(['epic', 'open'])
    expect(hidden[0]?.rows[0]).toMatchObject({ childCount: 1 })

    const shown = taskBoardSections([epic, open, finished], {
      showDone: true,
      expanded: new Set(['epic']),
    })
    expect(rowIds(shown)).toEqual(['epic', 'open', 'finished'])
  })

  it('lists a promoted proposal once, even while its parent is expanded', () => {
    // Both paths want the same row on screen: the promotion lifts screenable
    // proposals into Proposed, and expansion reveals every child in place. A
    // SectionList keyed by issue id cannot render the row twice.
    const epic = issue({ id: 'epic', stage: 'in_progress', type: 'epic', childCount: 1 })
    const proposal = issue({ id: 'prop', parentId: 'epic', stage: 'proposed', seq: 2 })

    const ids = rowIds(
      taskBoardSections([epic, proposal], { showDone: false, expanded: new Set(['epic']) }),
    )
    expect(ids).toEqual(['epic', 'prop'])
  })

  it('promotes a proposal parented under an approved epic into Proposed', () => {
    const epic = issue({ id: 'epic', stage: 'in_progress', type: 'epic', childCount: 1 })
    const proposal = issue({
      id: 'prop',
      parentId: 'epic',
      stage: 'proposed',
      seq: 2,
      priority: 0,
    })
    const peer = issue({ id: 'peer', stage: 'proposed', seq: 5, priority: 1 })

    const sections = taskBoardSections([epic, proposal, peer], { showDone: false })
    expect(sections.map((s) => s.stage)).toEqual(['in_progress', 'proposed'])
    expect(rowIds(sections)).toEqual(['epic', 'prop', 'peer'])
    const proposed = sections.find((s) => s.stage === 'proposed')
    expect(proposed?.rows.map((r) => [r.issue.id, r.depth])).toEqual([
      ['prop', 0],
      ['peer', 0],
    ])
  })

  it('leaves a proposal nested under another proposal off the list', () => {
    const root = issue({ id: 'root', stage: 'proposed', seq: 1 })
    const child = issue({ id: 'child', parentId: 'root', stage: 'proposed', seq: 2 })

    const sections = taskBoardSections([root, child], { showDone: false })
    expect(rowIds(sections)).toEqual(['root'])
  })

  it('orders a stage by priority then seq, matching DEFAULT_DISPLAY', () => {
    const rows = taskBoardSections(
      [
        issue({ id: 'late', stage: 'review', priority: 3, seq: 1 }),
        issue({ id: 'urgent', stage: 'review', priority: 0, seq: 9 }),
        issue({ id: 'tie', stage: 'review', priority: 0, seq: 4 }),
      ],
      { showDone: false },
    )
    expect(rowIds(rows)).toEqual(['tie', 'urgent', 'late'])
  })

  it('keeps agent-audience decomposition off the top level (showAgentTasks: false)', () => {
    const parent = issue({ id: 'p', stage: 'in_progress', childCount: 1 })
    const internal = issue({ id: 'agent', parentId: 'p', stage: 'in_progress', audience: 'agent' })
    const loose = issue({ id: 'loose', stage: 'in_progress', audience: 'agent' })

    const sections = taskBoardSections([parent, internal, loose], { showDone: false })
    // The loose internal task has no visible ancestor and is gone entirely; the
    // nested one exists only as a child, so it stays off this list.
    expect(rowIds(sections)).toEqual(['p'])
  })

  it('drops drafts, archived rows and tombstones, and empty stages', () => {
    const rows = taskBoardSections(
      [
        issue({ id: 'real', stage: 'backlog' }),
        issue({ id: 'draft', stage: 'backlog', draft: true }),
        issue({ id: 'gone', stage: 'backlog', archived: true }),
        issue({ id: 'tomb', stage: 'backlog', deletedAt: '2026-06-02T00:00:00.000Z' }),
      ],
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
    expect(taskBoardSections(all, { showDone: false }).map((s) => s.stage)).toEqual([
      'in_progress',
      'review',
      'planning',
      'backlog',
      'proposed',
    ])
    expect(taskBoardSections(all, { showDone: true }).map((s) => s.stage)).toEqual([
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
