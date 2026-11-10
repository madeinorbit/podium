import { render } from '@testing-library/react'
import { Text } from 'react-native'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(),
}))

vi.mock('./Icon', () => ({ Icon: () => null }))

const { Screen } = await import('./Screen')

describe('Screen safe areas', () => {
  it('pays the bottom inset when the pushed screen opts in', () => {
    const { container } = render(
      <Screen title="Session" safeBottom>
        <Text>Body</Text>
      </Screen>,
    )

    const inner = container.firstElementChild?.firstElementChild as HTMLElement
    expect(inner.style.paddingBottom).toBe('34px')
  })
})

describe('Screen actions', () => {
  it('draws plain trailing actions and leaves pull-down menus to native', () => {
    const onPress = vi.fn()
    const { getByLabelText, queryByLabelText } = render(
      <Screen
        title="Work"
        large
        actions={[
          { label: 'New work', icon: { ios: 'square.and.pencil' } as never, onPress },
          {
            label: 'Show',
            icon: { ios: 'line.3.horizontal' } as never,
            items: [{ label: 'Open', onPress }],
          },
        ]}
      >
        <Text>Body</Text>
      </Screen>,
    )
    getByLabelText('New work').click()
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(queryByLabelText('Show')).toBeNull()
  })
})
