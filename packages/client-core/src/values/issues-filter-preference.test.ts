/**
 * THE TASKS FILTERS THAT FOLLOW THE MEMBER (POD-6294; MU-09).
 */
import { describe, expect, it } from 'vitest'
import { type BoardFilterIssue, filterBoardIssues } from './issue-board-filter'
import { readSharedIssuesDisplay } from './issues-display-preference'
import {
  activeFilterCount,
  assigneeFacet,
  DEFAULT_ISSUES_FILTERS,
  readIssuesFilters,
  writeIssuesFilters,
} from './issues-filter-preference'

const display = (value: object) => JSON.stringify({ layout: 'list', ordering: 'updated', ...value })

describe('Show agent tasks moves from Display to Filters', () => {
  it('keeps an existing Display preference until the member saves a filter', () => {
    // A member who had turned it on under Display, before this build.
    const legacy = display({ showAgentTasks: true })
    expect(readIssuesFilters(null, legacy)).toMatchObject({
      assignedTo: 'me',
      showAgentTasks: true,
    })
    // The first write carries it onto the filters row ...
    const saved = writeIssuesFilters({ ...readIssuesFilters(null, legacy), assignedTo: 'all' })
    expect(JSON.parse(saved)).toEqual({ assignedTo: 'all', showAgentTasks: true })
    // ... and from then on the filters row decides, whatever Display says.
    const off = writeIssuesFilters({ ...readIssuesFilters(saved, legacy), showAgentTasks: false })
    expect(readIssuesFilters(off, legacy).showAgentTasks).toBe(false)
    expect(readIssuesFilters(off, display({ showAgentTasks: false })).showAgentTasks).toBe(false)
    expect(
      readIssuesFilters(JSON.stringify({ showAgentTasks: true }), display({})).showAgentTasks,
    ).toBe(true)
  })

  it('never rewrites the Display row (expand-only): an older client still reads its copy', () => {
    const legacy = display({ showAgentTasks: true })
    writeIssuesFilters({ ...readIssuesFilters(null, legacy), showAgentTasks: false })
    expect(readSharedIssuesDisplay(legacy).showAgentTasks).toBe(true)
  })

  it('defaults to your own tasks with agent tasks hidden, and survives a bad row', () => {
    for (const raw of [null, '', 'not json', '[1]', JSON.stringify({ assignedTo: '' })])
      expect(readIssuesFilters(raw, null)).toMatchObject(DEFAULT_ISSUES_FILTERS)
  })

  it('keeps fields a newer build wrote on the row', () => {
    const raw = JSON.stringify({ assignedTo: 'mem_alice', showAgentTasks: false, later: 1 })
    const next = writeIssuesFilters({ ...readIssuesFilters(raw, null), assignedTo: 'me' })
    expect(JSON.parse(next)).toEqual({ assignedTo: 'me', showAgentTasks: false, later: 1 })
  })
})

describe('Assigned to', () => {
  const shared = { shared: true, viewer: 'mem_bob' }
  const tasks = [
    { id: 'a', assignee: 'mem_alice' },
    { id: 'b', assignee: 'mem_bob' },
  ].map((task, seq) => ({
    ...task,
    seq,
    title: task.id,
    repoPath: '/r',
    stage: 'in_progress',
    priority: 2,
    archived: false,
    deletedAt: null,
    closedReason: null,
    ready: true,
    blocked: false,
    deferred: false,
  })) as unknown as (BoardFilterIssue & { id: string })[]
  const listed = (assignee: string | undefined) =>
    filterBoardIssues(tasks, assignee ? { assignee } : {}).map((task) => task.id)

  it('resolves Me to the viewer, All users and a member on a shared instance', () => {
    expect(listed(assigneeFacet('me', shared))).toEqual(['b'])
    expect(listed(assigneeFacet('all', shared))).toEqual(['a', 'b'])
    expect(listed(assigneeFacet('mem_alice', shared))).toEqual(['a'])
  })

  it('narrows nothing on a one-member instance or before the roster loads', () => {
    expect(assigneeFacet('me', { shared: false, viewer: 'mem_bob' })).toBeUndefined()
    expect(assigneeFacet('mem_alice', { shared: false, viewer: undefined })).toBeUndefined()
  })
})

describe('the active-filter count', () => {
  it('counts what differs from Reset (Me, agent tasks off); search is not a filter', () => {
    const reset = { assignedTo: 'me', showAgentTasks: false }
    expect(activeFilterCount({ text: 'x' }, reset, true)).toBe(0)
    expect(activeFilterCount({}, { assignedTo: 'all', showAgentTasks: true }, true)).toBe(2)
    expect(
      activeFilterCount({ priority: 1, archived: true, projectPaths: ['/r'] }, reset, true),
    ).toBe(3)
  })

  it('does not count Assigned to where it is not offered', () => {
    expect(activeFilterCount({}, { assignedTo: 'all', showAgentTasks: false }, false)).toBe(0)
  })
})
