import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { type ReactNode, useEffect, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  host: {} as Record<string, unknown>,
  dismissKeyboard: vi.fn(),
}))
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>()
  return { ...actual, Keyboard: { ...actual.Keyboard, dismiss: native.dismissKeyboard } }
})
vi.mock('@expo/ui', () => ({
  Host: (props: { children: ReactNode }) => {
    native.host = props
    return <div>{props.children}</div>
  },
}))
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  disabled: (value: boolean) => ({ disabled: value }),
  pickerStyle: (value: string) => ({ pickerStyle: value }),
  tag: (value: string) => ({ tag: value }),
}))
vi.mock('@expo/ui/swift-ui', async () => {
  const { Children, isValidElement } = await import('react')
  return {
    RNHostView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Menu: ({ label, children }: { label: ReactNode; children: ReactNode }) => {
      const [open, setOpen] = useState(false)
      return (
        <div>
          <button type="button" onClick={() => setOpen(!open)}>
            {label}
          </button>
          {open ? children : null}
        </div>
      )
    },
    Picker: ({
      label,
      selection,
      onSelectionChange,
      children,
    }: {
      label: string
      selection: string
      onSelectionChange: (value: string) => void
      children: ReactNode
    }) => (
      <div role="menu" aria-label={label}>
        {Children.map(children, (child) => {
          if (
            !isValidElement<{
              children: ReactNode
              modifiers: Array<{ tag?: string; disabled?: boolean }>
            }>(child)
          )
            return null
          const value =
            child.props.modifiers.find((modifier) => modifier.tag !== undefined)?.tag ?? ''
          return (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={selection === value}
              disabled={child.props.modifiers.some((modifier) => modifier.disabled)}
              onClick={() => onSelectionChange(value)}
            >
              {child.props.children}
            </button>
          )
        })}
      </div>
    ),
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  }
})
const { NativePicker } = await import('./action-sheet-native.ios')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it.each([
  'Agent',
  'Model',
  'Effort',
  'Machine',
])('opens %s in the existing sheet without invoking its fallback or blurring', (label) => {
  const fallback = vi.fn()
  const unmount = vi.fn()
  function Sheet() {
    const [selected, setSelected] = useState('current')
    useEffect(() => unmount, [])
    return (
      <div role="dialog" aria-label="Start task">
        <textarea aria-label="Draft" defaultValue="Keep this draft" />
        <NativePicker
          label={label}
          selected={selected}
          options={[
            { value: 'current', label: 'Current' },
            { value: 'next', label: 'Next' },
            { value: 'denied', label: 'Unavailable', disabled: true },
          ]}
          onSelect={setSelected}
          onOpenFallback={fallback}
        >
          {(onPress) => {
            expect(onPress).toBeUndefined()
            return <span>{label}</span>
          }}
        </NativePicker>
      </div>
    )
  }
  render(<Sheet />)
  const draft = screen.getByRole('textbox')
  draft.focus()
  fireEvent.click(screen.getByRole('button', { name: label }))
  expect(screen.getByRole('menuitemradio', { name: 'Current' }).getAttribute('aria-checked')).toBe(
    'true',
  )
  expect(
    (screen.getByRole('menuitemradio', { name: 'Unavailable' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Next' }))
  expect(screen.getByRole('menuitemradio', { name: 'Next' }).getAttribute('aria-checked')).toBe(
    'true',
  )
  fireEvent.click(screen.getByRole('button', { name: label }))
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.getByRole('dialog', { name: 'Start task' }).contains(draft)).toBe(true)
  expect(document.activeElement).toBe(draft)
  expect(native.host.ignoreSafeArea).toBe('all')
  expect(native.dismissKeyboard).not.toHaveBeenCalled()
  expect(fallback).not.toHaveBeenCalled()
  expect(unmount).not.toHaveBeenCalled()
})
