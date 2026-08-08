import { describe, expect, it } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import {
  DRAG_THRESHOLD_PX,
  dropTargetStage,
  passedDragThreshold,
  plannedDropIndex,
} from './kanban-dnd'

describe('dropTargetStage', () => {
  it('accepts valid stages, rejects junk', () => {
    expect(dropTargetStage('in_progress')).toBe('in_progress')
    expect(dropTargetStage('done')).toBe('done')
    expect(dropTargetStage('nonsense')).toBeNull()
    expect(dropTargetStage('')).toBeNull()
  })
})

describe('passedDragThreshold', () => {
  it('holds a press below the threshold so a click still opens the card', () => {
    expect(passedDragThreshold(0, 0)).toBe(false)
    expect(passedDragThreshold(3, 3)).toBe(false)
    expect(passedDragThreshold(DRAG_THRESHOLD_PX, 0)).toBe(true)
    expect(passedDragThreshold(-DRAG_THRESHOLD_PX, 0)).toBe(true)
  })
})

/**
 * The drop indicator SNAPS to the sorted position rather than following the
 * cursor — the board has no manual order, so a free placement would be a
 * promise it cannot keep. These pin that the previewed index is the one the
 * drop actually produces.
 */
describe('plannedDropIndex', () => {
  const issue = (id: string, priority: number, seq: number) =>
    makeIssue({ id, priority, seq, stage: 'backlog' })

  it('lands a card where the priority ordering puts it', () => {
    const column = [issue('a', 0, 1), issue('b', 2, 2), issue('c', 3, 3)]
    const moved = makeIssue({ id: 'm', priority: 1, seq: 9, stage: 'proposed' })
    expect(plannedDropIndex(column, moved, 'backlog', 'priority')).toBe(1)
  })

  it('lands it last when it is the lowest priority in the column', () => {
    const column = [issue('a', 0, 1), issue('b', 1, 2)]
    const moved = makeIssue({ id: 'm', priority: 4, seq: 9, stage: 'proposed' })
    expect(plannedDropIndex(column, moved, 'backlog', 'priority')).toBe(2)
  })

  it('follows the column’s own ordering, not one fixed rule', () => {
    const column = [
      makeIssue({ id: 'a', stage: 'backlog', createdAt: '2026-07-03T00:00:00.000Z' }),
      makeIssue({ id: 'b', stage: 'backlog', createdAt: '2026-07-01T00:00:00.000Z' }),
    ]
    const moved = makeIssue({ id: 'm', stage: 'proposed', createdAt: '2026-07-02T00:00:00.000Z' })
    // `created` sorts newest first, so a middle-aged card lands in the middle.
    expect(plannedDropIndex(column, moved, 'backlog', 'created')).toBe(1)
  })

  it('excludes the moved card from its own target column, so a re-drop is a no-op', () => {
    const moved = makeIssue({ id: 'm', priority: 1, seq: 2, stage: 'backlog' })
    const column = [issue('a', 0, 1), moved, issue('c', 3, 3)]
    expect(plannedDropIndex(column, moved, 'backlog', 'priority')).toBe(1)
  })

  it('lands at the end of an empty column', () => {
    expect(plannedDropIndex([], makeIssue({ id: 'm' }), 'backlog', 'priority')).toBe(0)
  })
})
