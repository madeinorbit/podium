import { act, cleanup, renderHook } from '@testing-library/react'
import { NavigationContainerRefContext } from 'expo-router/build/react-navigation/core/NavigationContainerRefContext'
import type { NavigationState } from 'expo-router/react-navigation'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expoRootStateReader } from '../../test/expo-root-state'
import { useDismissOnRootLeave } from './use-dismiss-on-root-leave'

afterEach(cleanup)

function root(initial: NavigationState['routes'][number] = { key: 'owner', name: '(tabs)' }) {
  let state = { index: 0, routes: [initial] }
  let listener = () => {}
  const remove = vi.fn()
  const addListener = vi.fn((event: string, next: () => void) => {
    expect(event).toBe('state')
    listener = next
    return remove
  })
  const navigation = {
    getRootState: expoRootStateReader(() => state),
    addListener,
  } as unknown as NonNullable<
    ComponentProps<typeof NavigationContainerRefContext.Provider>['value']
  >
  return {
    remove,
    addListener,
    publish(focused: NavigationState['routes'][number]) {
      state = { index: 0, routes: [focused] }
      act(() => listener())
    },
    wrapper: ({ children }: { children: ReactNode }) => (
      <NavigationContainerRefContext value={navigation}>{children}</NavigationContainerRefContext>
    ),
  }
}

describe('local modal dismissal on root navigation', () => {
  it('dismisses with the current callback when a full-screen route opens and removes the listener on close', () => {
    const app = root()
    const first = vi.fn()
    const current = vi.fn()
    const view = renderHook(({ dismiss, visible }) => useDismissOnRootLeave(dismiss, visible), {
      initialProps: { dismiss: first, visible: true },
      wrapper: app.wrapper,
    })
    view.rerender({ dismiss: current, visible: true })
    expect(app.addListener).toHaveBeenCalledTimes(1)
    app.publish({ key: 'console', name: 'session/[sessionId]/terminal' })
    app.publish({ key: 'another-console', name: 'session/[sessionId]/terminal' })
    expect(current).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()
    view.rerender({ dismiss: current, visible: false })
    expect(app.remove).toHaveBeenCalledOnce()
  })

  it('retains the sheet through nested presentation, picker/background events and nested tab updates', () => {
    const app = root()
    const dismiss = vi.fn()
    renderHook(() => useDismissOnRootLeave(dismiss), { wrapper: app.wrapper })
    // A native picker/background event leaves the root route unchanged.
    app.publish({ key: 'owner', name: '(tabs)' })
    app.publish({ key: 'new-task', name: 'new-issue' })
    app.publish({ key: 'start', name: 'launch/[issueId]' })
    app.publish({ key: 'details', name: 'inspect/[issueId]' })
    app.publish({ key: 'owner', name: '(tabs)' })
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('retains the sheet when the focused nested tab changes below the same app route', () => {
    const tabs: NavigationState = {
      key: 'native-tabs',
      type: 'tab',
      stale: false,
      index: 0,
      routeNames: ['work', 'issues'],
      routes: [
        { key: 'work-tab', name: 'work' },
        { key: 'tasks-tab', name: 'issues' },
      ],
    }
    const owner = { key: 'owner', name: '(tabs)', state: tabs }
    const app = root(owner)
    const dismiss = vi.fn()
    renderHook(() => useDismissOnRootLeave(dismiss), { wrapper: app.wrapper })

    app.publish({ ...owner, state: { ...tabs, index: 1 } })

    expect(dismiss).not.toHaveBeenCalled()
  })

  it('does not subscribe for a hidden modal or require navigation in an isolated component', () => {
    const app = root()
    const dismiss = vi.fn()
    const view = renderHook(() => useDismissOnRootLeave(dismiss, false), { wrapper: app.wrapper })
    expect(app.addListener).not.toHaveBeenCalled()
    view.unmount()
    renderHook(() => useDismissOnRootLeave(dismiss))
    expect(dismiss).not.toHaveBeenCalled()
  })
})
