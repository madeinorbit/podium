import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

const insets = { top: 0, right: 0, bottom: 34, left: 0 }
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ ...insets }),
}))
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn(async () => {}) }))
vi.mock('lucide-react-native', () => ({
  Activity: () => null,
  KanbanSquare: () => null,
  MessagesSquare: () => null,
  Rows3: () => null,
}))
// The capsule renders through BlurView; the shim keeps RNW's style pipeline
// (the real one is itself just a View plus backdrop-filter) while marking the
// element so the test can tell the blur capsule rendered at all.
vi.mock('expo-blur', async () => {
  const { View } = await import('react-native')
  type ViewProps = import('react-native').ViewProps
  return {
    BlurView: ({
      children,
      intensity: _i,
      tint: _t,
      ...props
    }: ViewProps & { intensity?: number; tint?: string }) => (
      <View {...props} testID="tab-bar-blur">
        {children}
      </View>
    ),
  }
})
// Only the context object is needed; the real module drags react-navigation in.
vi.mock('expo-router/build/react-navigation/bottom-tabs', async () => {
  const { createContext } = await import('react')
  return { BottomTabBarHeightCallbackContext: createContext(undefined) }
})

const { TabBar } = await import('./TabBar')

const state = {
  index: 0,
  routes: [
    { key: 'work-1', name: 'work' },
    { key: 'issues-1', name: 'issues' },
    { key: 'superagent-1', name: 'superagent' },
    { key: 'pulse-1', name: 'pulse' },
  ],
}
const descriptors = Object.fromEntries(
  state.routes.map((r) => [r.key, { options: { title: r.name } }]),
)
const navigation = {
  emit: () => ({ defaultPrevented: false }),
  navigate: vi.fn(),
}

describe('TabBar capsule', () => {
  it('is one floating tablist capsule that clears the safe area [POD-420]', () => {
    const { getByRole, getAllByRole } = render(
      <TabBar state={state} descriptors={descriptors} navigation={navigation} />,
    )

    // The capsule is a single tablist surface (the BlurView), not four
    // floating labels — and every tab sits inside it.
    const capsule = getByRole('tablist')
    expect(capsule.dataset.testid).toBe('tab-bar-blur')
    expect(getAllByRole('tab')).toHaveLength(4)
    for (const tab of getAllByRole('tab')) {
      expect(capsule.contains(tab)).toBe(true)
    }

    // The capsule floats above the home-indicator band: the dock around it
    // pays the safe-area inset OUTSIDE the capsule's background, so the
    // rounded island hovers clear of the screen edge rather than being an
    // edge-to-edge bar that absorbs the inset itself.
    const dock = capsule.parentElement as HTMLElement
    expect(dock.style.paddingBottom).toBe('34px')
    expect(capsule.style.paddingBottom).toBe('')
  })

  it('keeps the 12px float gap when the device reports no bottom inset', () => {
    insets.bottom = 0
    try {
      const { getByRole } = render(
        <TabBar state={state} descriptors={descriptors} navigation={navigation} />,
      )
      const dock = getByRole('tablist').parentElement as HTMLElement
      expect(dock.style.paddingBottom).toBe('12px')
    } finally {
      insets.bottom = 34
    }
  })
})
