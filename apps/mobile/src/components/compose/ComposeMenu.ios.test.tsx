import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import type { LayoutChangeEvent } from 'react-native'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComposeMenuProps } from './ComposeMenu'

const native = vi.hoisted(() => ({
  host: {} as Record<string, unknown>,
  bridge: {} as Record<string, unknown>,
  menu: {} as Record<string, unknown>,
  labelLayout: undefined as ((event: LayoutChangeEvent) => void) | undefined,
  hostLayout: undefined as ((event: LayoutChangeEvent) => void) | undefined,
  dismissKeyboard: vi.fn(),
}))
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>()
  return {
    ...actual,
    Keyboard: { ...actual.Keyboard, dismiss: native.dismissKeyboard },
    View: (props: ComponentProps<typeof actual.View>) => {
      if (props.testID === 'compose-menu-label') native.labelLayout = props.onLayout
      if (props.testID === 'compose-menu-host') native.hostLayout = props.onLayout
      return <actual.View {...props} />
    },
  }
})
vi.mock('@expo/ui', () => ({
  Host: (props: { children: ReactNode }) => {
    native.host = props
    return <div>{props.children}</div>
  },
}))
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  disabled: (value: boolean) => ({ disabled: value }),
  buttonStyle: (value: string) => ({ buttonStyle: value }),
  frame: (value: unknown) => ({ frame: value }),
  menuActionDismissBehavior: (value: string) => ({ menuActionDismissBehavior: value }),
}))
vi.mock('@expo/ui/swift-ui', () => ({
  RNHostView: (props: { children: ReactNode }) => {
    native.bridge = props
    return <div>{props.children}</div>
  },
  Menu: (props: { label: ReactNode; children: ReactNode }) => {
    if (typeof props.label !== 'string') native.menu = props
    return (
      <section aria-label={typeof props.label === 'string' ? props.label : 'root'}>
        {props.label}
        {props.children}
      </section>
    )
  },
  Section: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Toggle: ({
    children,
    isOn,
    onIsOnChange,
  }: {
    children: ReactNode
    isOn: boolean
    onIsOnChange: (value: boolean) => void
  }) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={isOn}
      onClick={() => onIsOnChange(!isOn)}
    >
      {children}
    </button>
  ),
  Button: ({
    children,
    label,
    onPress,
  }: {
    children?: ReactNode
    label?: string
    onPress: () => void
  }) => (
    <button type="button" onClick={onPress}>
      {label ?? children}
    </button>
  ),
}))
const { ComposeMenu } = await import('./ComposeMenu.ios')
beforeEach(() => {
  native.host = {}
  native.bridge = {}
  native.menu = {}
  native.labelLayout = undefined
  native.hostLayout = undefined
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const event = (width: number, height: number) =>
  ({ nativeEvent: { layout: { x: 0, y: 0, width, height } } }) as LayoutChangeEvent
function layoutMenu(width = 402, height = 44) {
  act(() => {
    native.hostLayout?.(event(width, height))
    native.labelLayout?.(event(width, height))
  })
}

it('shows a full-width RN label until the native menu can mount at its measured width', () => {
  render(
    <ComposeMenu label="Machine" items={[]}>
      {() => <span>MBP-Cofo.local</span>}
    </ComposeMenu>,
  )
  expect(screen.getByText('MBP-Cofo.local')).toBeTruthy()
  expect(native.host).toEqual({})
  layoutMenu(0, 0)
  expect(native.host).toEqual({})
  // Native parent layout can be delivered before the label measurement.
  act(() => native.hostLayout?.(event(320, 76)))
  expect(native.host).toMatchObject({ style: { width: 320, minHeight: 76 } })
  act(() => native.labelLayout?.(event(0, 0)))
  expect(native.host).toMatchObject({ style: { width: 320, minHeight: 76 } })
  expect(screen.getAllByText('MBP-Cofo.local')).toHaveLength(1)
  expect(getComputedStyle(screen.getByTestId('compose-menu-label')).width).toBe('320px')
})

it('keeps a measured menu row in place through dismissal and label remeasurement', () => {
  const view = render(
    <ComposeMenu label="Agent" items={[]} style={{ minHeight: 44 }}>
      {() => <span>Claude Code</span>}
    </ComposeMenu>,
  )
  expect(getComputedStyle(screen.getByTestId('compose-menu-host')).minHeight).toBe('44px')
  layoutMenu()
  expect(native.host).toMatchObject({
    style: { width: 402, minHeight: 44 },
  })
  expect(native.host.ignoreSafeArea).toBeUndefined()
  act(() => {
    native.hostLayout?.(event(0, 0))
    native.labelLayout?.(event(0, 0))
  })
  expect(getComputedStyle(screen.getByTestId('compose-menu-host')).minHeight).toBe('44px')
  view.rerender(
    <ComposeMenu label="Agent" items={[]}>
      {() => <span>Claude Code, larger text</span>}
    </ComposeMenu>,
  )
  act(() => native.labelLayout?.(event(402, 64)))
  expect(native.host).toMatchObject({ style: { width: 402, minHeight: 64 } })
  // Text size and sheet width can both decrease while the form is open.
  layoutMenu(300, 44)
  expect(native.host).toMatchObject({ style: { width: 300, minHeight: 44 } })
})

it('bridges full-width labels and uses native menu dismissal for held Start', () => {
  const start = vi.fn()
  const props: ComposeMenuProps = {
    label: 'Start',
    onPrimaryAction: start,
    items: [{ id: 'save', label: 'Save to Backlog' }],
    children: () => <span>Start</span>,
  }
  render(<ComposeMenu {...props} />)
  layoutMenu()
  expect(native.host.matchContents).toEqual({ vertical: true })
  expect(native.bridge.matchContents).toEqual({ vertical: true })
  expect(native.menu.onPrimaryAction).toBe(start)
  expect(native.menu.modifiers).toContainEqual({ buttonStyle: 'plain' })
  expect(native.menu.modifiers).toContainEqual({ menuActionDismissBehavior: 'enabled' })
})

it.each([
  'Project',
  'Agent',
  'Model',
  'Effort',
  'Machine',
])('opens %s over the composing sheet without blurring and resizing it', (label) => {
  render(
    <ComposeMenu label={label} items={[{ id: 'current', label: 'Current', selected: true }]}>
      {() => <span>Current</span>}
    </ComposeMenu>,
  )
  layoutMenu()
  const host = screen.getByTestId('compose-menu-host')
  const touch = { identifier: 0, target: host, clientX: 10, clientY: 10, pageX: 10, pageY: 10 }
  fireEvent.touchStart(host, { touches: [touch], changedTouches: [touch] })
  fireEvent.touchEnd(host, { touches: [], changedTouches: [touch] })
  expect(native.dismissKeyboard).not.toHaveBeenCalled()
  expect(native.host.ignoreSafeArea).toBeUndefined()
  // The menu remains a child of the current row, rather than a new sheet.
  expect(host.contains(screen.getByRole('region', { name: 'root' }))).toBe(true)
})

it('updates native Model and Effort submenus with live choices and dispatches selected values', () => {
  const pick = vi.fn()
  const props: ComposeMenuProps = { label: 'Agent', children: () => <span>Agent</span>, items: [] }
  const { rerender } = render(<ComposeMenu {...props} />)
  layoutMenu()
  rerender(
    <ComposeMenu
      {...props}
      items={[
        {
          id: 'model',
          label: 'Model',
          items: [{ id: 'reported', label: 'Machine model', selected: true, onPress: pick }],
        },
        {
          id: 'effort',
          label: 'Effort',
          items: [{ id: 'high', label: 'High', selected: false, onPress: pick }],
        },
      ]}
    />,
  )
  expect(screen.getByRole('region', { name: 'Model' })).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Effort' })).toBeTruthy()
  expect(
    screen.getByRole('menuitemradio', { name: 'Machine model' }).getAttribute('aria-checked'),
  ).toBe('true')
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'High' }))
  expect(pick).toHaveBeenCalledOnce()
})
