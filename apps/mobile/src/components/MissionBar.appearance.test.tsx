import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import { act, cleanup, render, screen } from '@testing-library/react'
import { memo, type ReactNode } from 'react'
import type { StyleProp, TextStyle } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'

const appearance = vi.hoisted(() => ({
  scheme: 'dark' as 'dark' | 'light' | 'unspecified',
  listeners: new Set<() => void>(),
}))
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>()
  const { useSyncExternalStore } = await import('react')
  return {
    ...actual,
    Platform: {
      ...actual.Platform,
      OS: 'ios',
      select: (values: Record<string, unknown>) => values.ios ?? values.default,
    },
    PlatformColor: (name: string) => ({ semantic: [name] }),
    DynamicColorIOS: (dynamic: unknown) => ({ dynamic }),
    useColorScheme: () =>
      useSyncExternalStore(
        (listener) => {
          appearance.listeners.add(listener)
          return () => appearance.listeners.delete(listener)
        },
        () => appearance.scheme,
      ),
    Text: ({ style, children }: { style?: unknown; children: ReactNode }) => (
      <span
        data-ink={JSON.stringify(actual.StyleSheet.flatten(style as StyleProp<TextStyle>)?.color)}
      >
        {children}
      </span>
    ),
  }
})
vi.mock('../theme/platform-colors', () => import('../theme/platform-colors.native'))
vi.mock('../theme/use-live-ink', () => import('../theme/use-live-ink.ios'))
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' } }))
vi.mock('expo-symbols', () => ({
  SymbolView: ({ tintColor }: { tintColor: unknown }) => (
    <i data-testid="inspector-symbol" data-ink={JSON.stringify(tintColor)} />
  ),
}))

import { Icon } from './Icon'
import { Plus } from './icons'
import { MissionBar } from './MissionBar'

const full = {
  ready: true,
  buckets: { done: 41, total: 64, working: 0, waiting: 0, todo: 23 },
  counts: { 'needs-you': 0, 'up-next': 11 },
} as unknown as FullDeck
const token = (node: HTMLElement) => JSON.parse(node.dataset.ink ?? 'null')
function changeAppearance(scheme: 'light' | 'dark') {
  act(() => {
    appearance.scheme = scheme
    for (const listener of [...appearance.listeners]) listener()
  })
}
afterEach(() => {
  cleanup()
  appearance.scheme = 'dark'
  appearance.listeners.clear()
})

it.each([
  'fraction',
  'inspector',
] as const)('changes the rendered %s ink under an unchanged memoized chat page', (part) => {
  let parentRenders = 0
  const ChatPage = memo(function ChatPage() {
    parentRenders++
    return <MissionBar full={full} onOpen={() => {}} />
  })
  render(<ChatPage />)
  const read = () =>
    part === 'fraction' ? screen.getByText('41/64') : screen.getByTestId('inspector-symbol')
  const node = read()
  const dark = token(node)
  changeAppearance('light')
  const light = token(read())
  expect(light).not.toEqual(dark)
  expect(light.dynamic).toMatchObject({
    light: part === 'fraction' ? '#000000' : '#3c3c43',
    highContrastLight: '#000000',
  })
  expect(read()).toBe(node)
  changeAppearance('dark')
  expect(token(read())).toEqual(dark)
  expect(read()).toBe(node)
  expect(parentRenders).toBe(1)
  expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
    'Flight deck, 41/64 · 11 up next',
  )
})

it('keeps an explicit signal tint and its symbol mounted across appearances', () => {
  render(<Icon as={Plus} size={16} color="#ff3344" />)
  const symbol = screen.getByTestId('inspector-symbol')
  changeAppearance('light')
  expect(token(symbol)).toBe('#ff3344')
  expect(screen.getByTestId('inspector-symbol')).toBe(symbol)
})

it('uses the light foreground when iOS reports an unspecified appearance', () => {
  appearance.scheme = 'unspecified'
  render(<MissionBar full={full} onOpen={() => {}} />)
  expect(token(screen.getByText('41/64')).dynamic.light).toBe('#000000')
})
