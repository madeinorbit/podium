import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const dimensions = vi.hoisted(() => ({ width: 390, fontScale: 1 }))
vi.mock('react-native', () => ({ useWindowDimensions: () => dimensions }))
vi.mock('@expo/ui/swift-ui', () => {
  const Slot = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    ContextMenu: Object.assign(
      ({ children }: { children?: ReactNode }) => <div data-testid="native-menu">{children}</div>,
      { Trigger: Slot, Items: Slot, Preview: Slot },
    ),
  }
})

import { ContextMenu } from './ContextMenu.ios'

afterEach(() => {
  cleanup()
  dimensions.width = 390
  dimensions.fontScale = 1
})

it('rebuilds native menu rows for live text-size increases and decreases', () => {
  const menu = () => (
    <ContextMenu>
      <ContextMenu.Trigger>Task</ContextMenu.Trigger>
      <ContextMenu.Items>Status</ContextMenu.Items>
    </ContextMenu>
  )
  const view = render(menu())
  let previous = screen.getByTestId('native-menu')
  for (const fontScale of [3.571, 0.823, 1]) {
    dimensions.fontScale = fontScale
    view.rerender(menu())
    expect(previous.isConnected).toBe(false)
    previous = screen.getByTestId('native-menu')
    expect(previous.textContent).toBe('TaskStatus')
  }
})

it('keeps the host on record updates and rotation, with the current action', () => {
  const onAction = vi.fn()
  const menu = (title: string) => (
    <ContextMenu>
      <ContextMenu.Trigger>{title}</ContextMenu.Trigger>
      <ContextMenu.Items>
        <button type="button" onClick={() => onAction(title)}>
          Open task
        </button>
      </ContextMenu.Items>
    </ContextMenu>
  )
  const view = render(menu('Before'))
  const host = screen.getByTestId('native-menu')
  dimensions.width = 844
  view.rerender(menu('After'))
  expect(screen.getByTestId('native-menu')).toBe(host)
  fireEvent.click(screen.getByRole('button', { name: 'Open task' }))
  expect(onAction).toHaveBeenCalledWith('After')
})
