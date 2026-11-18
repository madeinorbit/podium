import type { IssueNavigationModel } from '@podium/client-core/values'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asIssueId } from '@podium/model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NavigationContainerRefContext } from 'expo-router/build/react-navigation/core/NavigationContainerRefContext'
import { Children, type ComponentProps, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const facts = vi.hoisted(() => ({ read: vi.fn() }))
const expoUI = await vi.hoisted(async () => {
  const { readFileSync } = await import('node:fs')
  const { createRequire } = await import('node:module')
  const { dirname, join } = await import('node:path')
  const root = dirname(createRequire(import.meta.url).resolve('@expo/ui/package.json'))
  const definition = readFileSync(join(root, 'ios/ExpoUIModule.swift'), 'utf8')
  return {
    config: JSON.parse(readFileSync(join(root, 'expo-module.config.json'), 'utf8')),
    registered: new Set(
      [...definition.matchAll(/\b(?:ExpoUI)?View\((?:ExpoUI\.)?(\w+)\.self\)/g)].map(
        (match) => match[1],
      ),
    ),
    component: (name: string) => join(root, 'src/swift-ui', name, 'index.tsx'),
  }
})
vi.mock('../client/use-issue-close', () => ({ useIssueCloseConcerns: facts.read }))
vi.mock('@expo/ui', async () => ({ Host: (await import('@expo/ui/swift-ui')).Host }))
// Keep every Expo wrapper real and replace only the native view factory.
// Fabric cannot mount RawText directly under these native views in Release.
vi.mock('expo', () => ({
  requireNativeView: (module: string, name: string) => {
    if (module !== 'ExpoUI' || !expoUI.registered.has(name)) {
      throw new Error(`Unregistered native view ${module}.${name}`)
    }
    return ({
      children,
      text,
      title,
      name: slot,
      label,
      role,
      modifiers,
      onButtonPress,
      isPresented,
      onIsPresentedChange,
      onDismiss,
    }: {
      children?: ReactNode
      text?: string
      title?: string
      name?: string
      label?: string
      role?: string
      modifiers?: { name: string; value: unknown }[]
      onButtonPress?: () => void
      isPresented?: boolean
      onIsPresentedChange?: (event: { nativeEvent: { isPresented: boolean } }) => void
      onDismiss?: () => void
    }) => {
      if (
        Children.toArray(children).some(
          (child) => typeof child === 'string' || typeof child === 'number',
        )
      ) {
        throw new Error(`Unregistered RawText under ExpoUI.${name}`)
      }
      if (name === 'Button') {
        return (
          <button
            type="button"
            data-native-role={role}
            onClick={onButtonPress}
            disabled={Boolean(modifiers?.find((item) => item.name === 'disabled')?.value)}
          >
            {label}
            {children}
          </button>
        )
      }
      if (name === 'BottomSheetView') {
        return (
          <div data-testid="native-close" data-presented={isPresented}>
            <button
              type="button"
              onClick={() => onIsPresentedChange?.({ nativeEvent: { isPresented: false } })}
            >
              Drag dismiss
            </button>
            {children}
            <button type="button" onClick={onDismiss}>
              Finish dismissal
            </button>
          </div>
        )
      }
      return (
        <div data-native-view={name} data-slot={slot}>
          {title ? <h2>{title}</h2> : null}
          {text}
          {children}
        </div>
      )
    }
  },
}))
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(
    [
      'accessibilityIdentifier',
      'disabled',
      'font',
      'foregroundStyle',
      'navigationBarTitleDisplayMode',
      'navigationTitle',
      'presentationDetents',
      'presentationDragIndicator',
    ].map((name) => [name, (value: unknown) => ({ name, value })]),
  ),
}))
vi.mock('@expo/ui/swift-ui', async () => {
  return Object.assign(
    {},
    ...(await Promise.all(
      [
        'BottomSheet',
        'Button',
        'Form',
        'Group',
        'Host',
        'NavigationStack',
        'Section',
        'Text',
        'Toolbar',
        'VStack',
      ].map((name) => vi.importActual(expoUI.component(name))),
    )),
  )
})

import { IssueCloseSheet } from './IssueCloseSheet.ios'

const issue = { id: asIssueId('task') } as IssueNavigationModel
const concern = {
  key: 'sessions',
  icon: 'sessions',
  label: '1 working agent',
  detail: 'Closing stops this agent.',
}

beforeEach(() => facts.read.mockReset().mockReturnValue([concern]))
afterEach(cleanup)

it('dismisses on navigation without confirming or stopping an agent', () => {
  let state = { index: 0, routes: [{ key: 'issue', name: 'issue/[issueId]' }] }
  let changed: (() => void) | undefined
  const navigation = {
    getRootState: () => state,
    addListener: (_event: string, listener: () => void) => {
      changed = listener
      return () => {}
    },
  } as unknown as NonNullable<
    ComponentProps<typeof NavigationContainerRefContext.Provider>['value']
  >
  const onClose = vi.fn()
  const onConfirm = vi.fn()
  render(
    <NavigationContainerRefContext value={navigation}>
      <IssueCloseSheet issue={issue} reason="done" onClose={onClose} onConfirm={onConfirm} />
    </NavigationContainerRefContext>,
  )
  act(() => {
    state = { index: 0, routes: [{ key: 'console', name: 'session/[sessionId]/terminal' }] }
    changed?.()
  })
  expect(screen.getByTestId('native-close').getAttribute('data-presented')).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: 'Finish dismissal' }))
  expect(onClose).toHaveBeenCalledOnce()
  expect(onConfirm).not.toHaveBeenCalled()
})

it('mounts the concern footer through SwiftUI Text, without a raw text native child', () => {
  expect(expoUI.config.apple.modules).toContain('ExpoUIModule')
  render(<IssueCloseSheet issue={issue} reason="done" onClose={vi.fn()} onConfirm={vi.fn()} />)
  const footer = screen.getByText(
    'Closing is still available, but it should be an explicit decision.',
  )
  expect(footer.getAttribute('data-native-view')).toBe('TextView')
  expect(footer.parentElement?.getAttribute('data-slot')).toBe('footer')
})

it('waits for live close facts, then keeps the native warning current', () => {
  const props = { issue, reason: 'done' as const, onClose: vi.fn(), onConfirm: vi.fn() }
  facts.read.mockReturnValue(LOADING)
  const view = render(<IssueCloseSheet {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Close task' }))
  expect(props.onConfirm).not.toHaveBeenCalled()
  expect(screen.getByText('Checking this task…')).toBeTruthy()

  facts.read.mockReturnValue([concern])
  view.rerender(<IssueCloseSheet {...props} />)
  expect(screen.getByText('1 working agent')).toBeTruthy()
  expect(
    screen.getByRole('button', { name: 'Close anyway' }).getAttribute('data-native-role'),
  ).toBe('destructive')

  facts.read.mockReturnValue([])
  view.rerender(<IssueCloseSheet {...props} />)
  expect(screen.queryByText('1 working agent')).toBeNull()
  expect(screen.getByRole('button', { name: 'Close task' }).hasAttribute('disabled')).toBe(false)
})

it.each([
  ['done', 'Close anyway'],
  ['cancelled', 'Close as cancelled'],
  ['duplicate', 'Close as duplicate'],
] as const)('confirms %s once, after native dismissal', (reason, label) => {
  const onClose = vi.fn()
  const onConfirm = vi.fn()
  render(<IssueCloseSheet issue={issue} reason={reason} onClose={onClose} onConfirm={onConfirm} />)
  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.click(screen.getByRole('button', { name: label }))
  expect(screen.getByTestId('native-close').getAttribute('data-presented')).toBe('false')
  expect(onClose).not.toHaveBeenCalled()
  expect(onConfirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Finish dismissal' }))
  fireEvent.click(screen.getByRole('button', { name: 'Finish dismissal' }))
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith(reason)
  const [closedAt = 0] = onClose.mock.invocationCallOrder
  const [confirmedAt = 0] = onConfirm.mock.invocationCallOrder
  expect(closedAt).toBeLessThan(confirmedAt)
})

it.each(['pending', 'busy'] as const)('keeps Keep open enabled while %s', (state) => {
  facts.read.mockReturnValue(state === 'pending' ? LOADING : [concern])
  const onClose = vi.fn()
  const onConfirm = vi.fn()
  render(
    <IssueCloseSheet
      issue={issue}
      reason="done"
      busy={state === 'busy'}
      onClose={onClose}
      onConfirm={onConfirm}
    />,
  )
  const confirm = screen.getByRole<HTMLButtonElement>('button', {
    name: state === 'busy' ? 'Closing…' : 'Close task',
  })
  expect(confirm.disabled).toBe(true)
  const keepOpen = screen.getByRole<HTMLButtonElement>('button', { name: 'Keep open' })
  expect(keepOpen.disabled).toBe(false)
  fireEvent.click(keepOpen)
  fireEvent.click(screen.getByRole('button', { name: 'Finish dismissal' }))
  expect(onClose).toHaveBeenCalledOnce()
  expect(onConfirm).not.toHaveBeenCalled()
})

it.each(['Keep open', 'Drag dismiss'])('%s dismisses without closing the task', (label) => {
  const onClose = vi.fn()
  const onConfirm = vi.fn()
  render(<IssueCloseSheet issue={issue} reason="done" onClose={onClose} onConfirm={onConfirm} />)
  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.click(screen.getByRole('button', { name: 'Finish dismissal' }))
  expect(onClose).toHaveBeenCalledOnce()
  expect(onConfirm).not.toHaveBeenCalled()
})

it('does not request close facts while down', () => {
  render(<IssueCloseSheet issue={issue} reason={null} onClose={vi.fn()} onConfirm={vi.fn()} />)
  expect(facts.read).not.toHaveBeenCalled()
  expect(screen.queryByTestId('native-close')).toBeNull()
})
