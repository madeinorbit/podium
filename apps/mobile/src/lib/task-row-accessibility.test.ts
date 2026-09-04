import { describe, expect, it, vi } from 'vitest'
import {
  dispatchTaskRowAccessibilityAction,
  TASK_ROW_ACCESSIBILITY_ACTIONS,
  taskRowAccessibilityProps,
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

  it('builds the exact labeled action boundary used by TaskRow', () => {
    const open = vi.fn()
    const showActions = vi.fn()
    const props = taskRowAccessibilityProps({
      seq: 42,
      title: 'Ship mobile parity',
      stateText: '2 working',
      onOpen: open,
      onShowActions: showActions,
    })

    expect(props).toMatchObject({
      accessibilityLabel: 'Task 42: Ship mobile parity, 2 working',
      accessibilityHint: 'Open task, or use Actions for task actions.',
      accessibilityActions: TASK_ROW_ACCESSIBILITY_ACTIONS,
    })
    props.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } } as never)
    props.onAccessibilityAction?.({ nativeEvent: { actionName: 'showActions' } } as never)
    expect(open).toHaveBeenCalledOnce()
    expect(showActions).toHaveBeenCalledOnce()
  })
})
