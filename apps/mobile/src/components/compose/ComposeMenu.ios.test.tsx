import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComposeMenuProps } from './ComposeMenu'

const native = vi.hoisted(() => ({
  host: {} as Record<string, unknown>,
  bridge: {} as Record<string, unknown>,
  menu: {} as Record<string, unknown>,
}))
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
afterEach(cleanup)

it('bridges full-width labels and uses native menu dismissal for held Start', () => {
  const start = vi.fn()
  const props: ComposeMenuProps = {
    label: 'Start',
    onPrimaryAction: start,
    items: [{ id: 'save', label: 'Save to Backlog' }],
    children: () => <span>Start</span>,
  }
  render(<ComposeMenu {...props} />)
  expect(native.host.matchContents).toEqual({ vertical: true })
  expect(native.bridge.matchContents).toEqual({ vertical: true })
  expect(native.menu.onPrimaryAction).toBe(start)
  expect(native.menu.modifiers).toContainEqual({ buttonStyle: 'plain' })
  expect(native.menu.modifiers).toContainEqual({ menuActionDismissBehavior: 'enabled' })
})

it('updates native Model and Effort submenus with live choices and dispatches selected values', () => {
  const pick = vi.fn()
  const props: ComposeMenuProps = { label: 'Agent', children: () => <span>Agent</span>, items: [] }
  const { rerender } = render(<ComposeMenu {...props} />)
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
