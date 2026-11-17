import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const dimensions = vi.hoisted(() => ({ width: 390, height: 844, fontScale: 1 }))
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  useWindowDimensions: () => dimensions,
}))
vi.mock('../theme/theme', () => ({ color: { text: '#000', groupedCard: '#fff' } }))
vi.mock('@expo/ui/swift-ui/modifiers', () =>
  Object.fromEntries(
    ['background', 'frame', 'padding', 'tint'].map((name) => [
      name,
      (value: unknown) => ({ name, value }),
    ]),
  ),
)
vi.mock('@expo/ui/swift-ui', () => {
  const Trigger = ({ children }: { children?: ReactNode }) => <>{children}</>
  const Items = ({ children }: { children?: ReactNode }) => <>{children}</>
  const Preview = ({ children }: { children?: ReactNode }) => (
    <div data-testid="preview">{children}</div>
  )
  return {
    VStack: ({ children }: { children?: ReactNode }) => <>{children}</>,
    ContextMenu: Object.assign(
      ({ children }: { children?: ReactNode }) => <div data-testid="native-menu">{children}</div>,
      { Trigger, Items, Preview },
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

it('previews the pressed row and preserves an explicit preview', () => {
  const menu = (explicit: boolean) => (
    <ContextMenu preview>
      <ContextMenu.Trigger>Current task</ContextMenu.Trigger>
      <ContextMenu.Items>Status</ContextMenu.Items>
      {explicit ? <ContextMenu.Preview>Custom preview</ContextMenu.Preview> : null}
    </ContextMenu>
  )
  const view = render(menu(false))
  expect(within(screen.getByTestId('preview')).getByText('Current task')).toBeTruthy()
  view.rerender(menu(true))
  expect(screen.getAllByTestId('preview')).toHaveLength(1)
  expect(screen.getByTestId('preview').textContent).toBe('Custom preview')
})
