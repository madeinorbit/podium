import { describe, expect, it } from 'vitest'
import {
  contextMenuTargets,
  deferDateFromNow,
  isIssueClosed,
  issueMenuEligibility,
  toggleLabelAcross,
} from './issue-context-menu'
import { makeIssue } from '@/lib/test-issue'

describe('issueMenuEligibility', () => {
  it('gates everything off for an empty target set', () => {
    const e = issueMenuEligibility([])
    expect(Object.values(e).every((v) => v === false)).toBe(true)
  })

  it('enables the full single-issue set for one open issue', () => {
    const e = issueMenuEligibility([makeIssue()])
    expect(e).toEqual({
      canOpen: true,
      canRename: true,
      canSetStage: true,
      canSetPriority: true,
      canAssignAgent: true,
      canSetLabels: true,
      canClose: true,
      canDefer: true,
      canUndefer: false,
      canDuplicate: true,
      canPin: true,
      canRestore: false,
      canDelete: true,
      canArchive: true,
      canUnarchive: false,
      // A read issue offers "mark unread"; only an unread one offers "mark read".
      canMarkRead: false,
      canMarkUnread: true,
    })
  })

  it('offers mark-unread on a read issue and mark-read on an unread one (#138)', () => {
    const read = issueMenuEligibility([makeIssue({ unread: false })])
    expect(read.canMarkUnread).toBe(true)
    expect(read.canMarkRead).toBe(false)
    const unread = issueMenuEligibility([makeIssue({ unread: true })])
    expect(unread.canMarkUnread).toBe(false)
    expect(unread.canMarkRead).toBe(true)
  })

  it('offers archive on an active issue and unarchive on an archived one', () => {
    const active = issueMenuEligibility([makeIssue()])
    expect(active.canArchive).toBe(true)
    expect(active.canUnarchive).toBe(false)
    const archived = issueMenuEligibility([makeIssue({ archived: true })])
    expect(archived.canArchive).toBe(false)
    expect(archived.canUnarchive).toBe(true)
  })

  it('drops close / defer / assign-agent on a closed issue', () => {
    const e = issueMenuEligibility([makeIssue({ closedReason: 'done' })])
    expect(e.canClose).toBe(false)
    expect(e.canDefer).toBe(false)
    expect(e.canAssignAgent).toBe(false)
    // still openable / re-stageable / deletable
    expect(e.canOpen).toBe(true)
    expect(e.canSetStage).toBe(true)
    expect(e.canDelete).toBe(true)
  })

  it('offers undefer only when a defer date is set', () => {
    expect(issueMenuEligibility([makeIssue()]).canUndefer).toBe(false)
    expect(
      issueMenuEligibility([makeIssue({ deferUntil: '2026-07-10', deferred: true })]).canUndefer,
    ).toBe(true)
  })

  it('hides duplicate once the issue already points at a canonical one', () => {
    expect(issueMenuEligibility([makeIssue({ duplicateOf: 'x' })]).canDuplicate).toBe(false)
  })

  it('offers only open and restore for deleted issues', () => {
    const e = issueMenuEligibility([makeIssue({ deletedAt: '2026-07-13T10:00:00.000Z' })])
    expect(e.canOpen).toBe(true)
    expect(e.canRestore).toBe(true)
    expect(e.canDelete).toBe(false)
    expect(e.canRename).toBe(false)
    expect(e.canSetStage).toBe(false)
    expect(e.canArchive).toBe(false)
  })

  it('supports bulk restore only when every selected issue is deleted', () => {
    const deleted = makeIssue({ id: 'gone', deletedAt: '2026-07-13T10:00:00.000Z' })
    expect(issueMenuEligibility([deleted, { ...deleted, id: 'also-gone' }]).canRestore).toBe(true)
    expect(issueMenuEligibility([deleted, makeIssue({ id: 'live' })]).canRestore).toBe(false)
  })
  it('keeps only bulk-capable actions on a multi-selection', () => {
    const e = issueMenuEligibility([makeIssue({ id: 'a' }), makeIssue({ id: 'b' })])
    expect(e.canSetStage).toBe(true)
    expect(e.canSetPriority).toBe(true)
    expect(e.canSetLabels).toBe(true)
    expect(e.canDelete).toBe(true)
    expect(e.canOpen).toBe(false)
    // Rename is single-target (#170).
    expect(e.canRename).toBe(false)
    expect(e.canAssignAgent).toBe(false)
    expect(e.canClose).toBe(false)
    expect(e.canDefer).toBe(false)
    expect(e.canDuplicate).toBe(false)
    expect(e.canPin).toBe(false)
    expect(e.canArchive).toBe(false)
    expect(e.canUnarchive).toBe(false)
    // Read-state actions are single-target too.
    expect(e.canMarkRead).toBe(false)
    expect(e.canMarkUnread).toBe(false)
  })
})

describe('isIssueClosed', () => {
  it('closed ⇔ closedReason present', () => {
    expect(isIssueClosed(makeIssue())).toBe(false)
    expect(isIssueClosed(makeIssue({ closedReason: 'wontfix' }))).toBe(true)
  })
})

describe('contextMenuTargets', () => {
  it('right-click inside the selection keeps it and targets all selected', () => {
    const r = contextMenuTargets({ focusId: 'a', selected: ['a', 'b', 'c'] }, 'b')
    expect(r.keyState).toEqual({ focusId: 'b', selected: ['a', 'b', 'c'] })
    expect(r.targetIds).toEqual(['a', 'b', 'c'])
  })

  it('right-click on an unselected issue re-focuses it and drops the selection', () => {
    const r = contextMenuTargets({ focusId: 'a', selected: ['a', 'b'] }, 'z')
    expect(r.keyState).toEqual({ focusId: 'z', selected: [] })
    expect(r.targetIds).toEqual(['z'])
  })

  it('right-click with no selection targets just the clicked issue', () => {
    const r = contextMenuTargets({ focusId: null, selected: [] }, 'x')
    expect(r.keyState).toEqual({ focusId: 'x', selected: [] })
    expect(r.targetIds).toEqual(['x'])
  })
})

describe('deferDateFromNow', () => {
  it('formats now+days as local YYYY-MM-DD, rolling over month ends', () => {
    // 2026-06-30 12:00 local
    const base = new Date(2026, 5, 30, 12, 0, 0).getTime()
    expect(deferDateFromNow(base, 1)).toBe('2026-07-01')
    expect(deferDateFromNow(base, 7)).toBe('2026-07-07')
  })
})

describe('toggleLabelAcross', () => {
  it('adds the label to targets missing it (mixed selection)', () => {
    const a = makeIssue({ id: 'a', labels: ['x'] })
    const b = makeIssue({ id: 'b', labels: [] })
    expect(toggleLabelAcross([a, b], 'x')).toEqual([{ id: 'b', labels: ['x'] }])
  })

  it('removes the label everywhere when every target has it', () => {
    const a = makeIssue({ id: 'a', labels: ['x', 'y'] })
    const b = makeIssue({ id: 'b', labels: ['x'] })
    expect(toggleLabelAcross([a, b], 'x')).toEqual([
      { id: 'a', labels: ['y'] },
      { id: 'b', labels: [] },
    ])
  })
})
