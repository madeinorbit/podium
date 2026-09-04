import type { IssueNavigationModel } from '@podium/client-core/viewmodels'
import { asIssueId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { workMenuActionIds } from './work-menu'

const issue = (patch: Partial<IssueNavigationModel> = {}): IssueNavigationModel =>
  ({
    id: asIssueId('task'),
    seq: 12,
    repoPath: '/repo',
    title: 'Mobile menu parity',
    description: '',
    stage: 'in_progress',
    priority: 2,
    type: 'task',
    labels: [],
    parentId: null,
    archived: false,
    pinned: false,
    unread: false,
    closedReason: null,
    deletedAt: null,
    deferUntil: undefined,
    worktreePath: null,
    ...patch,
  }) as unknown as IssueNavigationModel

const moves = { placement: true }

/**
 * The 2026-08-27 device review CUT this menu down. Open/Peek (duplicates of the
 * row tap), Set priority, Run now, Labels, Move down, Pin, Snooze and Archive
 * are all gone from the long-press; these tests pin the trimmed vocabulary so
 * the desktop projection does not quietly grow back.
 */
describe('Work long-press menu projection', () => {
  it('keeps Closed to recovery only', () => {
    expect(workMenuActionIds(issue({ closedReason: 'done' }), 'closed', moves)).toEqual([
      'bringBack',
    ])
  })

  it('keeps Snoozed to unsnooze only', () => {
    expect(workMenuActionIds(issue({ deferUntil: 'next-message' }), 'snoozed', moves)).toEqual([
      'undefer',
    ])
  })

  it('offers exactly the trimmed live menu when every capability is present', () => {
    expect(workMenuActionIds(issue(), 'live', moves)).toEqual([
      'rename',
      'read',
      'status',
      'color',
      'placement',
      'delete',
    ])
  })

  it('never resurrects the options the device review removed', () => {
    const removed = [
      'open',
      'peek',
      'priority',
      'agent',
      'labels',
      'moveDown',
      'moveTop',
      'moveUp',
      'pin',
      'archive',
      'defer',
    ]
    for (const lane of ['live', 'snoozed', 'closed'] as const) {
      const ids: string[] = workMenuActionIds(issue(), lane, moves)
      expect(ids.filter((id) => removed.includes(id))).toEqual([])
    }
  })

  it('drops the gated rows when their gates fail', () => {
    expect(
      workMenuActionIds(issue({ parentId: asIssueId('parent') }), 'live', {
        placement: false,
      }),
    ).toEqual(['rename', 'read', 'status', 'delete'])
  })

  it('offers nothing on a deleted row', () => {
    expect(workMenuActionIds(issue({ deletedAt: '2026-08-27T00:00:00Z' }), 'live', moves)).toEqual(
      [],
    )
  })
})
