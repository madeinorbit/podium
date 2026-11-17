import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { type ReactNode, useEffect, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SuperagentBackend } from '../lib/superagent-backend'

const native = vi.hoisted(() => ({
  host: {} as Record<string, unknown>,
  dismissKeyboard: vi.fn(),
}))
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>()
  return { ...actual, Keyboard: { ...actual.Keyboard, dismiss: native.dismissKeyboard } }
})
vi.mock('./action-sheet-native', () => import('./action-sheet-native.ios'))
vi.mock('./BottomSheet', () => ({ BottomSheet: () => null }))
vi.mock('./Icon', () => ({ Icon: () => null }))
vi.mock('./PressableScale', () => ({
  PressableScale: ({
    children,
    accessibilityLabel,
  }: {
    children: ReactNode
    accessibilityLabel?: string
  }) => (
    <span role="img" aria-label={accessibilityLabel}>
      {children}
    </span>
  ),
}))
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
          <div hidden={!open}>{children}</div>
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
    }) => {
      // Expo keeps the SwiftUI Picker mounted inside Menu. Its own @State
      // changes on a choice and resets only when the selection prop changes.
      const [nativeSelection, setNativeSelection] = useState(selection)
      useEffect(() => setNativeSelection(selection), [selection])
      return (
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
                aria-checked={nativeSelection === value}
                disabled={child.props.modifiers.some((modifier) => modifier.disabled)}
                onClick={() => {
                  if (nativeSelection === value) return
                  setNativeSelection(value)
                  onSelectionChange(value)
                }}
              >
                {child.props.children}
              </button>
            )
          })}
        </div>
      )
    },
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  }
})
const { NativePicker } = await import('./action-sheet-native.ios')
const { SuperagentBackendRail } = await import('./SuperagentBackendRail')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it.each([
  'Keep open',
  'Drag dismiss',
])('restores the real stage after %s so the same close can be requested again', (dismiss) => {
  const select = vi.fn()
  function Task() {
    const [confirming, setConfirming] = useState(false)
    return (
      <>
        <NativePicker
          label="Status"
          selected="in_progress"
          options={[
            { value: 'in_progress', label: 'In Progress' },
            { value: 'done', label: 'Done' },
          ]}
          onSelect={(value) => {
            select(value)
            setConfirming(true)
          }}
          onOpenFallback={vi.fn()}
        >
          {() => <span>Stage In Progress</span>}
        </NativePicker>
        {confirming ? (
          <div role="dialog" aria-label="Close task">
            <button type="button" onClick={() => setConfirming(false)}>
              {dismiss}
            </button>
          </div>
        ) : null}
      </>
    )
  }

  render(<Task />)
  const stage = screen.getByRole('button', { name: 'Stage In Progress' })
  fireEvent.click(stage)
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Done' }))
  expect(select).toHaveBeenCalledExactlyOnceWith('done')
  // UIMenu dismisses after a choice without unmounting the Picker's React tree.
  fireEvent.click(stage)
  fireEvent.click(screen.getByRole('button', { name: dismiss }))
  expect(screen.queryByRole('dialog')).toBeNull()

  fireEvent.click(stage)
  expect(
    screen.getByRole('menuitemradio', { name: 'In Progress' }).getAttribute('aria-checked'),
  ).toBe('true')
  expect(screen.getByRole('menuitemradio', { name: 'Done' }).getAttribute('aria-checked')).toBe(
    'false',
  )
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Done' }))
  expect(select).toHaveBeenNthCalledWith(2, 'done')
  expect(select).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('dialog', { name: 'Close task' })).toBeTruthy()
})

it('preserves accepted model and effort checkmarks in the real composer rail after reopening', () => {
  const changeModel = vi.fn()
  const changeEffort = vi.fn()
  function Composer() {
    const [backend, setBackend] = useState<SuperagentBackend>({
      agentKind: undefined,
      model: 'auto',
      effort: 'auto',
    })
    return (
      <>
        <textarea aria-label="Draft" defaultValue="Keep this draft" />
        <SuperagentBackendRail
          backend={backend}
          modelCatalog={{
            'claude-code': [{ value: 'opus', label: 'Opus', efforts: ['low', 'high'] }],
          }}
          onModelChange={(model, agentKind) => {
            changeModel(model, agentKind)
            setBackend((current) => ({ ...current, model, agentKind }))
          }}
          onEffortChange={(effort) => {
            changeEffort(effort)
            setBackend((current) => ({ ...current, effort }))
          }}
        />
      </>
    )
  }
  render(<Composer />)
  const draft = screen.getByRole('textbox')
  draft.focus()
  const model = screen.getByRole('button', { name: 'Model' })
  fireEvent.click(model)
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Opus$/ }))
  expect(changeModel).toHaveBeenCalledExactlyOnceWith('opus', 'claude-code')
  fireEvent.click(model)
  fireEvent.click(model)
  expect(screen.getByRole('menuitemradio', { name: /Opus$/ }).getAttribute('aria-checked')).toBe(
    'true',
  )

  const effort = screen.getByRole('button', { name: 'Effort' })
  fireEvent.click(effort)
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'High' }))
  expect(changeEffort).toHaveBeenCalledExactlyOnceWith('high')
  fireEvent.click(effort)
  fireEvent.click(effort)
  const high = screen.getByRole('menuitemradio', { name: 'High' })
  expect(high.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(high)
  expect(changeEffort).toHaveBeenCalledOnce()
  expect(screen.getByRole('textbox')).toBe(draft)
  expect(document.activeElement).toBe(draft)
  expect(native.dismissKeyboard).not.toHaveBeenCalled()
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
