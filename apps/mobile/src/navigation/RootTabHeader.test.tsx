import { act, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import type { SharedValue } from 'react-native-reanimated'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  options: {} as Record<string, unknown>,
  scroll: undefined as
    | undefined
    | ((event: { contentOffset: { y: number }; contentInset: { top: number } }) => void),
  geometry: undefined as undefined | ((geometry: { contentOffsetY: number }) => void),
}))
vi.mock('react-native', async (original) => {
  const rn = await original<typeof import('react-native')>()
  return { ...rn, Platform: { ...rn.Platform, OS: 'ios', Version: 26 } }
})
vi.mock('expo-router/stack', () => {
  const Slot = ({ children }: { children: ReactNode }) => children
  return {
    Stack: {
      Screen: ({ options }: { options: Record<string, unknown> }) => {
        native.options = options
        return null
      },
      Toolbar: Object.assign(Slot, { View: Slot }),
    },
  }
})
vi.mock('expo-router/react-navigation', async () => ({
  HeaderHeightContext: (await import('react')).createContext(100),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 60, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('react-native-worklets', () => ({
  scheduleOnRN: (fn: (value: boolean) => void, value: boolean) => fn(value),
}))
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' }, impactAsync: vi.fn() }))
vi.mock('../components/Icon', () => ({ Icon: () => null }))
vi.mock('react-native-reanimated', async () => {
  const React = await import('react')
  const { View } = await import('react-native')
  return {
    default: {
      View,
      ScrollView: ({ children }: { children: ReactNode }) => <View>{children}</View>,
    },
    useSharedValue: (value: number) => React.useRef({ value }).current,
    useAnimatedStyle: (fn: () => object) => fn(),
    useAnimatedReaction: () => {},
    useAnimatedScrollHandler: (fn: typeof native.scroll) => {
      native.scroll = fn
      return fn
    },
  }
})
vi.mock('@expo/ui/swift-ui', () => ({ List: View, VStack: View, RNHostView: View }))
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ignoreSafeArea: () => ({}),
  listRowBackground: () => ({}),
  listRowInsets: () => ({}),
  listRowSeparator: () => ({}),
  useScrollGeometryChange: (fn: typeof native.geometry) => {
    native.geometry = fn
    return {}
  },
}))

const { Screen } = await import('../components/Screen.native')
const { RootHeaderContext } = await import('./root-header-context')
const { RootTabTitle, RootTabInlineTitle } = await import('./RootTabTitle')
const { RootTabScrollView } = await import('./RootTabScrollView.native')
const { RootTabList } = await import('./RootTabList.ios')
const { rootHeaderProgress } = await import('./root-header-progress')

beforeEach(() => {
  native.options = {}
})

describe('root tab chrome', () => {
  it('keeps the native bar but disables its large title only on root screens', () => {
    const root = render(
      <Screen large title="Work">
        <RootTabScrollView>
          <Text>Rows</Text>
        </RootTabScrollView>
      </Screen>,
    )
    expect(native.options).toMatchObject({
      headerShown: true,
      headerLargeTitleEnabled: false,
      headerTransparent: true,
    })
    expect(root.getByRole('heading', { name: 'Work' })).toBeTruthy()
    root.unmount()
    render(
      <Screen title="Task detail">
        <Text>Details</Text>
      </Screen>,
    )
    expect(native.options).toMatchObject({
      title: 'Task detail',
      headerShown: true,
      headerLargeTitleEnabled: false,
      headerTransparent: true,
    })
  })

  it('keeps large-row actions clickable and hides the duplicate row from accessibility after collapse', () => {
    const onPress = vi.fn()
    const offset = { value: 0 } as SharedValue<number>
    const header = {
      title: 'Work',
      subtitle: '3 need you · 6 working',
      offset,
      compact: false,
      actions: [{ label: 'New work', icon: { ios: 'square.and.pencil' } as never, onPress }],
    }
    const screen = render(
      <RootHeaderContext value={header}>
        <RootTabTitle />
      </RootHeaderContext>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'New work' }))
    expect(onPress).toHaveBeenCalledOnce()
    expect(screen.getByText(header.subtitle)).toBeTruthy()
    offset.value = 44
    screen.rerender(
      <RootHeaderContext value={{ ...header, compact: true }}>
        <RootTabTitle />
        <RootTabInlineTitle />
      </RootHeaderContext>,
    )
    expect(screen.queryByRole('button', { name: 'New work' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Work' })).toBeTruthy()
  })

  it('normalizes RN insets without collapsing during pull-to-refresh', () => {
    const offset = { value: 0 } as SharedValue<number>
    render(
      <RootHeaderContext value={{ title: 'Pulse', offset, compact: false }}>
        <RootTabScrollView>
          <Text>Body</Text>
        </RootTabScrollView>
      </RootHeaderContext>,
    )
    act(() => native.scroll?.({ contentOffset: { y: -80 }, contentInset: { top: 60 } }))
    expect(offset.value).toBe(0)
    act(() => native.scroll?.({ contentOffset: { y: -38 }, contentInset: { top: 60 } }))
    expect(rootHeaderProgress(offset.value)).toBe(0.5)
    act(() => native.scroll?.({ contentOffset: { y: -60 }, contentInset: { top: 60 } }))
    expect(rootHeaderProgress(offset.value)).toBe(0)
  })

  it('uses SwiftUI geometry without waking a React render on each scroll', () => {
    const offset = { value: 0 } as SharedValue<number>
    const screen = render(
      <RootHeaderContext value={{ title: 'Tasks', offset, compact: false }}>
        <RootTabList>
          <Text>Task row</Text>
        </RootTabList>
      </RootHeaderContext>,
    )
    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeTruthy()
    act(() => native.geometry?.({ contentOffsetY: -60 }))
    expect(offset.value).toBe(0)
    act(() => native.geometry?.({ contentOffsetY: -16 }))
    expect(rootHeaderProgress(offset.value)).toBe(1)
    act(() => native.geometry?.({ contentOffsetY: -80 }))
    expect(offset.value).toBe(0)
    offset.value = 80
    screen.rerender(
      <RootHeaderContext value={{ title: 'Tasks', offset, compact: false }}>
        <RootTabList key="new-search">
          <Text>Task row</Text>
        </RootTabList>
      </RootHeaderContext>,
    )
    expect(offset.value).toBe(0)
  })
})
