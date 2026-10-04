import { asIssueId } from '@podium/model'
import type { IssueViewModel } from '@podium/client-core/replica'
import { taskStateWord } from '@podium/client-core/viewmodels'
import { describe, expect, it } from 'vitest'
import type { MobileTaskSection, MobileTasksOptions } from '@podium/client-graph/mobile-screens-schema'
import { readPoolTasks } from '../../test/pool-board-fixture'

const readTaskSections = async (issues: IssueViewModel[], options: Partial<MobileTasksOptions>) =>
  (await readPoolTasks(issues, options)).board

/**
 * The defect this file guards is a POPULATION defect: which rows exist on the
 * phone's Tasks tab, and in what order. Nesting itself lives in
 * `packages/client-core/src/viewmodels/issue-board-rows.test.ts`; what is
 * asserted here is that the phone asks that derivation for roots only, then
 * promotes screenable proposals so they are not trapped under an epic.
 */
function issue(over: Partial<IssueViewModel> = {}): IssueViewModel {
  return {
    id: asIssueId('i'),
    repoPath: '/r',
    seq: 1,
    title: 't',
    description: '',
    stage: 'backlog',
    priority: 2,
    type: 'task',
    audience: 'human',
    intentOrigin: 'human',
    isDraftVessel: false,
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
  } as IssueViewModel
}

const rowIds = (sections: MobileTaskSection[]) =>
  sections.flatMap((s) => s.rows.map((r) => r.issue.id))

describe('pool task sections', () => {
  it("lists roots only — an epic's decomposition stays off the tab", async () => {
    const epic = issue({ id: asIssueId('epic'), stage: 'in_progress', type: 'epic', childCount: 2 })
    const kid1 = issue({ id: asIssueId('k1'), parentId: asIssueId('epic'), stage: 'in_progress', seq: 2 })
    const kid2 = issue({ id: asIssueId('k2'), parentId: asIssueId('epic'), stage: 'done', seq: 3 })

    const sections = (await readTaskSections([epic, kid1, kid2], { showDone: true }))
    expect(rowIds(sections)).toEqual(['epic'])
    expect(sections[0]?.rows[0]).toMatchObject({ depth: 0, childCount: 2, expanded: false })
    expect(sections.map((s) => s.stage)).toEqual(['in_progress'])
  })

  it("reveals an expanded parent's children under it, whatever stage they are in", async () => {
    // The defect: the phone passed an expanded set that could never grow, so a
    // sub-task existed on this tab only as a number on its parent while the
    // desktop board could open the same epic in place.
    const epic = issue({ id: asIssueId('epic'), stage: 'in_progress', type: 'epic', childCount: 2 })
    const kid1 = issue({ id: asIssueId('k1'), parentId: asIssueId('epic'), stage: 'backlog', seq: 2 })
    const kid2 = issue({ id: asIssueId('k2'), parentId: asIssueId('epic'), stage: 'review', seq: 3 })

    const sections = (await readTaskSections([epic, kid1, kid2], {
      showDone: false,
      expanded: ['epic'],
    }))

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

  it('hides them again when the parent is collapsed', async () => {
    const epic = issue({ id: asIssueId('epic'), stage: 'in_progress', type: 'epic', childCount: 1 })
    const kid = issue({ id: asIssueId('k1'), parentId: asIssueId('epic'), stage: 'backlog', seq: 2 })
    expect(
      rowIds((await readTaskSections([epic, kid], { showDone: false, expanded: [] }))),
    ).toEqual(['epic'])
  })

  it('keeps a revealed child under its own parent when a promotion re-sorts the lane', async () => {
    // Found in review: the promotion re-ordered the Proposed section ROW by row,
    // so an expanded root's children were sorted away from it and rendered
    // indented under whichever unrelated row landed in front.
    const first = issue({ id: asIssueId('first'), stage: 'proposed', seq: 10 })
    const child = issue({ id: asIssueId('child'), parentId: asIssueId('first'), stage: 'backlog', seq: 40 })
    const second = issue({ id: asIssueId('second'), stage: 'proposed', seq: 30 })
    const epic = issue({ id: asIssueId('epic'), stage: 'in_progress', type: 'epic', childCount: 1 })
    const promoted = issue({ id: asIssueId('promoted'), parentId: asIssueId('epic'), stage: 'proposed', seq: 20 })

    const sections = (await readTaskSections([first, child, second, epic, promoted], {
      showDone: false,
      expanded: ['first'],
    }))
    const proposed = sections.find((s) => s.stage === 'proposed')
    expect(proposed?.rows.map((r) => [r.issue.id, r.depth])).toEqual([
      ['first', 0],
      ['child', 1],
      ['promoted', 0],
      ['second', 0],
    ])
  })

  it('expands a promoted proposal too — its chevron is not a dead control', async () => {
    // The shared derivation only ever emits a root's subtree, and a promoted
    // proposal is not a root: its sub-task count was rendered with nothing
    // behind it.
    const epic = issue({ id: asIssueId('epic'), stage: 'in_progress', type: 'epic', childCount: 1 })
    const promoted = issue({ id: asIssueId('promoted'), parentId: asIssueId('epic'), stage: 'proposed', seq: 2 })
    const under = issue({ id: asIssueId('under'), parentId: asIssueId('promoted'), stage: 'backlog', seq: 3 })

    const collapsed = (await readTaskSections([epic, promoted, under], { showDone: false }))
    expect(collapsed.find((s) => s.stage === 'proposed')?.rows[0]).toMatchObject({
      childCount: 1,
      expanded: false,
    })

    const open = (await readTaskSections([epic, promoted, under], {
      showDone: false,
      expanded: ['promoted'],
    }))
    expect(
      open.find((s) => s.stage === 'proposed')?.rows.map((r) => [r.issue.id, r.depth]),
    ).toEqual([
      ['promoted', 0],
      ['under', 1],
    ])
  })

  it('keeps done sub-tasks out of a reveal while Show done is off', async () => {
    // A child rides in its PARENT's section whatever its own stage, so hiding
    // the Done section is not enough — the filter has to bind the population,
    // or the count on the chevron promises rows it must not show.
    const epic = issue({ id: asIssueId('epic'), stage: 'in_progress', type: 'epic', childCount: 2 })
    const open = issue({ id: asIssueId('open'), parentId: asIssueId('epic'), stage: 'backlog', seq: 2 })
    const finished = issue({ id: asIssueId('finished'), parentId: asIssueId('epic'), stage: 'done', seq: 3 })

    const hidden = (await readTaskSections([epic, open, finished], {
      showDone: false,
      expanded: ['epic'],
    }))
    expect(rowIds(hidden)).toEqual(['epic', 'open'])
    expect(hidden[0]?.rows[0]).toMatchObject({ childCount: 1 })

    const shown = (await readTaskSections([epic, open, finished], {
      showDone: true,
      expanded: ['epic'],
    }))
    expect(rowIds(shown)).toEqual(['epic', 'open', 'finished'])
  })

  it('lists a promoted proposal once, even while its parent is expanded', async () => {
    // Both paths want the same row on screen: the promotion lifts screenable
    // proposals into Proposed, and expansion reveals every child in place. A
    // SectionList keyed by issue id cannot render the row twice, and the
    // proposal must remain a root decision rather than ordinary mission work.
    const epic = issue({ id: asIssueId('epic'), stage: 'in_progress', type: 'epic', childCount: 1 })
    const proposal = issue({ id: asIssueId('prop'), parentId: asIssueId('epic'), stage: 'proposed', seq: 2 })

    const sections = (await readTaskSections([epic, proposal], {
      showDone: false,
      expanded: ['epic'],
    }))
    expect(rowIds(sections)).toEqual(['epic', 'prop'])
    expect(sections.find((section) => section.stage === 'in_progress')?.rows).toEqual([
      expect.objectContaining({
        issue: expect.objectContaining({ id: asIssueId('epic') }),
        depth: 0,
        childCount: 0,
        expanded: false,
      }),
    ])
    expect(sections.find((section) => section.stage === 'proposed')?.rows).toEqual([
      expect.objectContaining({ issue: expect.objectContaining({ id: asIssueId('prop') }), depth: 0 }),
    ])
  })

  it('promotes a proposal parented under an approved epic into Proposed', async () => {
    const epic = issue({ id: asIssueId('epic'), stage: 'in_progress', type: 'epic', childCount: 1 })
    const proposal = issue({
      id: asIssueId('prop'),
      parentId: asIssueId('epic'),
      stage: 'proposed',
      seq: 2,
      priority: 0,
    })
    const peer = issue({ id: asIssueId('peer'), stage: 'proposed', seq: 5, priority: 1 })

    const sections = (await readTaskSections([epic, proposal, peer], { showDone: false }))
    expect(sections.map((s) => s.stage)).toEqual(['in_progress', 'proposed'])
    expect(rowIds(sections)).toEqual(['epic', 'prop', 'peer'])
    const proposed = sections.find((s) => s.stage === 'proposed')
    expect(proposed?.rows.map((r) => [r.issue.id, r.depth])).toEqual([
      ['prop', 0],
      ['peer', 0],
    ])
  })

  it('leaves a proposal nested under another proposal off the list', async () => {
    const root = issue({ id: asIssueId('root'), stage: 'proposed', seq: 1 })
    const child = issue({ id: asIssueId('child'), parentId: asIssueId('root'), stage: 'proposed', seq: 2 })

    const sections = (await readTaskSections([root, child], { showDone: false }))
    expect(rowIds(sections)).toEqual(['root'])
  })

  it('orders a stage by priority then seq, matching DEFAULT_DISPLAY', async () => {
    const rows = (await readTaskSections(
      [
        issue({ id: asIssueId('late'), stage: 'review', priority: 3, seq: 1 }),
        issue({ id: asIssueId('urgent'), stage: 'review', priority: 0, seq: 9 }),
        issue({ id: asIssueId('tie'), stage: 'review', priority: 0, seq: 4 }),
      ],
      { showDone: false },
    ))
    expect(rowIds(rows)).toEqual(['tie', 'urgent', 'late'])
  })

  it('keeps agent-audience decomposition off the top level (showAgentTasks: false)', async () => {
    const parent = issue({ id: asIssueId('p'), stage: 'in_progress', childCount: 1 })
    const internal = issue({ id: asIssueId('agent'), parentId: asIssueId('p'), stage: 'in_progress', audience: 'agent' })
    const loose = issue({ id: asIssueId('loose'), stage: 'in_progress', audience: 'agent' })

    const sections = (await readTaskSections([parent, internal, loose], { showDone: false }))
    // The loose internal task has no visible ancestor and is gone entirely; the
    // nested one exists only as a child, so it stays off this list.
    expect(rowIds(sections)).toEqual(['p'])
  })

  it('drops drafts, archived rows and tombstones, and empty stages', async () => {
    const rows = (await readTaskSections(
      [
        issue({ id: asIssueId('real'), stage: 'backlog' }),
        issue({ id: asIssueId('draft'), stage: 'backlog', isDraftVessel: true }),
        issue({ id: asIssueId('gone'), stage: 'backlog', archived: true }),
        issue({ id: asIssueId('tomb'), stage: 'backlog', deletedAt: '2026-06-02T00:00:00.000Z' }),
      ],
      { showDone: false },
    ))
    expect(rows.map((s) => s.stage)).toEqual(['backlog'])
    expect(rowIds(rows)).toEqual(['real'])
  })

  it('leads with the moving stages and folds done behind the toggle', async () => {
    const all = [
      issue({ id: asIssueId('a'), stage: 'proposed' }),
      issue({ id: asIssueId('b'), stage: 'backlog' }),
      issue({ id: asIssueId('c'), stage: 'planning' }),
      issue({ id: asIssueId('d'), stage: 'in_progress' }),
      issue({ id: asIssueId('e'), stage: 'review' }),
      issue({ id: asIssueId('f'), stage: 'done' }),
    ]
    expect((await readTaskSections(all, { showDone: false })).map((s) => s.stage)).toEqual([
      'in_progress',
      'review',
      'planning',
      'backlog',
      'proposed',
    ])
    expect((await readTaskSections(all, { showDone: true })).map((s) => s.stage)).toEqual([
      'in_progress',
      'review',
      'planning',
      'backlog',
      'proposed',
      'done',
    ])
  })

  it('uses the exact shared desktop membership for native search and facets', async () => {
    const xs = [
      issue({
        id: asIssueId('a'),
        seq: 1234,
        displayRef: 'POD-1234',
        title: 'Login bug',
        priority: 0,
        type: 'bug',
        labels: ['ui'],
      }),
      issue({
        id: asIssueId('b'),
        seq: 7,
        displayRef: 'POD-7',
        title: 'Dark mode',
        priority: 2,
        type: 'feature',
        stage: 'review',
        blocked: true,
        ready: false,
      }),
    ]
    const filters = [{ text: 'pod 1234' }, { priority: 0 }, { status: 'blocked' as const }]
    const expected = [['a'], ['a'], ['b']]
    for (const [index, filter] of filters.entries()) {
      expect(rowIds(await readTaskSections(xs, { showDone: false, filter }))).toEqual(expected[index])
    }
  })

  it('keeps root context when only a decomposition child matches', async () => {
    const parent = issue({
      id: asIssueId('parent'),
      title: 'Release readiness',
      stage: 'in_progress',
      childCount: 1,
    })
    const child = issue({
      id: asIssueId('child'),
      parentId: asIssueId('parent'),
      title: 'Needle-only decomposition',
      stage: 'planning',
      seq: 2,
    })

    const rows = (await readTaskSections([parent, child], {
      showDone: false,
      filter: { text: 'Needle-only' },
    }))
    expect(rowIds(rows)).toEqual(['parent'])
    expect(rows[0]?.rows[0]).toMatchObject({ depth: 0, issue: { id: asIssueId('parent') } })
  })

  it('ranks a root as working when only a grandchild has a confirmed worker', async () => {
    const root = issue({ id: asIssueId('root'), type: 'epic', stage: 'in_progress', childCount: 1 })
    const child = issue({
      id: asIssueId('child'),
      parentId: asIssueId('root'),
      stage: 'planning',
      childCount: 1,
      seq: 2,
    })
    const grandchild = issue({
      id: asIssueId('grandchild'),
      parentId: asIssueId('child'),
      stage: 'in_progress',
      seq: 3,
    })
    const progress = (await readPoolTasks(
      [root, child, grandchild],
      { showDone: false },
      new Map([['grandchild', 1]]),
    )).progressByIssue

    expect(progress.get('root')).toEqual({ total: 2, done: 0, liveAgents: 1 })
    expect(taskStateWord(root, 0, progress.get('root'))).toEqual({
      text: '1 working',
      tone: 'live',
    })

    const progressWithRootWorker = (await readPoolTasks(
      [root, child, grandchild],
      { showDone: false },
      new Map([['root', 1], ['grandchild', 1]]),
    )).progressByIssue
    expect(progressWithRootWorker.get('root')?.liveAgents).toBe(1)
    expect(taskStateWord(root, 1, progressWithRootWorker.get('root'))).toEqual({
      text: '2 working',
      tone: 'live',
    })
  })
})

describe('expanded pool task order', () => {
  it('walks every board task flat, so a nested child still has neighbours', async () => {
    const epic = issue({ id: asIssueId('epic'), stage: 'in_progress', childCount: 1 })
    const kid = issue({ id: asIssueId('kid'), parentId: asIssueId('epic'), stage: 'in_progress', seq: 2 })
    const other = issue({ id: asIssueId('other'), stage: 'review' })
    const order = rowIds(await readTaskSections([epic, kid, other], { expanded: ['epic'] }))
    expect(order).toEqual(['epic', 'kid', 'other'])
  })
})
