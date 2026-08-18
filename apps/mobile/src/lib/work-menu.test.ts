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

const moves = { placement: true, moveTop: true, moveUp: true, moveDown: true }

describe('Work long-press menu projection', () => {
  it('keeps Closed to recovery and archive, even when the live menu has every capability', () => {
    expect(workMenuActionIds(issue({ closedReason: 'done' }), 'closed', moves)).toEqual([
      'bringBack',
      'archive',
    ])
  })

  it('keeps Snoozed to unsnooze and archive', () => {
    expect(workMenuActionIds(issue({ deferUntil: 'next-message' }), 'snoozed', moves)).toEqual([
      'undefer',
      'archive',
    ])
  })

  it('projects the desktop live menu plus the phone-only peek and reorder affordances', () => {
    expect(workMenuActionIds(issue(), 'live', moves)).toEqual([
      'open',
      'peek',
      'rename',
      'read',
      'status',
      'priority',
      'agent',
      'labels',
      'color',
      'placement',
      'defer',
      'pin',
      'moveTop',
      'moveUp',
      'moveDown',
      'archive',
      'delete',
    ])
  })

  it('drops open-only and top-level-only actions when their desktop gates fail', () => {
    expect(
      workMenuActionIds(
        issue({ parentId: asIssueId('parent'), closedReason: 'cancelled', deferUntil: undefined }),
        'live',
        { placement: false, moveTop: false, moveUp: false, moveDown: false },
      ),
    ).toEqual([
      'open',
      'peek',
      'rename',
      'read',
      'status',
      'priority',
      'labels',
      'pin',
      'archive',
      'delete',
    ])
  })
})
