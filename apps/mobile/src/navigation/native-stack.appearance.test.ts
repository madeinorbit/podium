import { expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
    Version: '26.5',
    select: (values: Record<string, unknown>) => values.ios ?? values.default,
  },
}))

import { detailStackOptions, headerSubtitleOptions, tabStackOptions } from './native-stack'

it('lets UIKit change header glass appearance synchronously with the rest of the window', () => {
  for (const options of [
    tabStackOptions,
    detailStackOptions,
    headerSubtitleOptions('Coordinator'),
    headerSubtitleOptions('3 need you', { large: true }),
    headerSubtitleOptions(undefined),
  ]) {
    expect(options.unstable_nativeProps).toMatchObject({
      headerConfig: { experimental_userInterfaceStyle: 'unspecified' },
    })
  }
})
