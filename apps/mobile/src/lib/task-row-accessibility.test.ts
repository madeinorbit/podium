import { describe, expect, it, vi } from 'vitest'
import {
  dispatchTaskRowAccessibilityAction,
  TASK_ROW_ACCESSIBILITY_ACTIONS,
} from './task-row-accessibility'

describe('task row accessibility actions', () => {
  it('names and dispatches both the primary and actions paths', () => {
    const open = vi.fn()
    const showActions = vi.fn()

    expect(TASK_ROW_ACCESSIBILITY_ACTIONS).toEqual([
      { name: 'activate', label: 'Open task' },
      { name: 'showActions', label: 'Show task actions' },
    ])
    dispatchTaskRowAccessibilityAction('activate', open, showActions)
    dispatchTaskRowAccessibilityAction('showActions', open, showActions)
    dispatchTaskRowAccessibilityAction('unknown', open, showActions)

    expect(open).toHaveBeenCalledOnce()
    expect(showActions).toHaveBeenCalledOnce()
  })
})
