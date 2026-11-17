import type { FullDeck } from '@podium/client-graph/mission-full-deck'
import { act, cleanup, render, screen } from '@testing-library/react'
import { memo, type ReactNode } from 'react'
import type { StyleProp, TextStyle } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'

const appearance = vi.hoisted(() => ({
  fontScale: 1,
  scheme: 'dark' as 'dark' | 'light' | 'unspecified',
  listeners: new Set<() => void>(),
}))
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>()
  const { useSyncExternalStore } = await import('react')
  return {
    ...actual,
    useWindowDimensions: () => ({
      width: 402,
      height: 874,
      scale: 1,
      fontScale: appearance.fontScale,
    }),
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
    Text: ({
      style,
      children,
      numberOfLines,
    }: {
      style?: unknown
      children: ReactNode
      numberOfLines?: number
    }) => (
      <span
        data-line-limit={numberOfLines}
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
  buckets: { done: 41, total: 64, working: 2, waiting: 0, todo: 21 },
  counts: { 'needs-you': 1, 'up-next': 11 },
} as unknown as FullDeck
// Nested RN Text inherits its parent's foreground when it has no own color.
const token = (node: HTMLElement) =>
  JSON.parse(node.closest<HTMLElement>('[data-ink]')?.dataset.ink ?? 'null')
function changeAppearance(scheme: 'light' | 'dark') {
  act(() => {
    appearance.scheme = scheme
    for (const listener of [...appearance.listeners]) listener()
  })
}
afterEach(() => {
  cleanup()
  appearance.scheme = 'dark'
  appearance.fontScale = 1
  appearance.listeners.clear()
})

function visibleText(text: string | RegExp): HTMLElement {
  const node = screen
    .getAllByText(text)
    .find((candidate) => !candidate.closest('[aria-hidden=true]'))
  if (!node) throw new Error(`Missing visible text: ${text}`)
  return node
}

it.each([
  { part: 'fraction', text: '41/64', light: '#000000', contrast: '#000000' },
  { part: 'inspector', text: null, light: '#3c3c43', contrast: '#000000' },
  { part: 'up next', text: /11 up next/, light: '#3c3c43', contrast: '#000000' },
  { part: 'needs you', text: /1 needs you/, light: '#765114', contrast: '#5e4110' },
  { part: 'working', text: /2 working/, light: '#0057b8', contrast: '#004693' },
])('changes the rendered $part ink under an unchanged memoized chat page', ({
  text,
  light,
  contrast,
}) => {
  let parentRenders = 0
  const ChatPage = memo(function ChatPage() {
    parentRenders++
    return <MissionBar full={full} onOpen={() => {}} />
  })
  render(<ChatPage />)
  const read = () => (text === null ? screen.getByTestId('inspector-symbol') : visibleText(text))
  const node = read()
  const dark = token(node)
  changeAppearance('light')
  const lightToken = token(read())
  expect(lightToken).not.toEqual(dark)
  expect(lightToken.dynamic).toMatchObject({
    light,
    highContrastLight: contrast,
  })
  expect(read()).toBe(node)
  changeAppearance('dark')
  expect(token(read())).toEqual(dark)
  expect(read()).toBe(node)
  expect(parentRenders).toBe(1)
  expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
    'Flight deck, 41/64 · 1 needs you · 2 working · 11 up next',
  )
})

it('updates the loading strip ink without replacing its text', () => {
  render(<MissionBar full={{ ...full, ready: false } as FullDeck} onOpen={() => {}} />)
  const node = screen.getByText('Loading tasks…')
  const dark = token(node)
  changeAppearance('light')
  expect(token(node)).not.toEqual(dark)
  expect(token(node).dynamic.light).toBe('#3c3c43')
  changeAppearance('dark')
  expect(token(node)).toEqual(dark)
  expect(screen.getByText('Loading tasks…')).toBe(node)
})

it('keeps an explicit signal tint and its symbol mounted across appearances', () => {
  render(<Icon as={Plus} size={16} color="#ff3344" />)
  const symbol = screen.getByTestId('inspector-symbol')
  changeAppearance('light')
  expect(token(symbol)).toBe('#ff3344')
  expect(screen.getByTestId('inspector-symbol')).toBe(symbol)
})

it('leaves nested native color variants with UIKit', () => {
  const ink = {
    dynamic: { light: { semantic: ['label'] }, dark: { semantic: ['secondaryLabel'] } },
  }
  render(<Icon as={Plus} size={16} color={ink as unknown as string} />)
  const symbol = screen.getByTestId('inspector-symbol')
  changeAppearance('light')
  expect(token(symbol)).toEqual(ink)
  changeAppearance('dark')
  expect(token(symbol)).toEqual(ink)
  expect(screen.getByTestId('inspector-symbol')).toBe(symbol)
})

it('uses the light foreground when iOS reports an unspecified appearance', () => {
  appearance.scheme = 'unspecified'
  render(<MissionBar full={full} onOpen={() => {}} />)
  expect(token(visibleText('41/64')).dynamic.light).toBe('#000000')
})

const long = {
  ...full,
  buckets: { done: 106, total: 112, working: 2, waiting: 0, todo: 4 },
  counts: { 'needs-you': 1, 'up-next': 33 },
} as unknown as FullDeck

it.each([
  { scale: 1, progress: true, upNext: true },
  { scale: 1.8, progress: true, upNext: false },
  { scale: 2.35, progress: false, upNext: false },
  { scale: 3.12, progress: false, upNext: false },
])('keeps priority counts on one line at font scale $scale', ({ scale, progress, upNext }) => {
  appearance.fontScale = scale
  render(<MissionBar full={long} onOpen={() => {}} />)
  const needs = visibleText(/1 needs you/)
  const counts = needs.parentElement
  if (!counts) throw new Error('Missing native counts text')
  expect(counts.getAttribute('data-line-limit')).toBe('1')
  expect(counts.textContent).toContain('1 needs you')
  expect(counts.textContent).toContain('2 working')
  const visible = (text: string | RegExp) =>
    screen.queryAllByText(text).some((node) => !node.closest('[aria-hidden=true]'))
  expect(visible('106/112')).toBe(progress)
  expect(visible(/33 up next/)).toBe(upNext)
  expect(getComputedStyle(screen.getByTestId('mission-bar')).height).toBe('40px')
  expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
    'Flight deck, 106/112 · 1 needs you · 2 working · 33 up next',
  )
})

it.each([
  { needsYou: 0, working: 0, reading: '106/112' },
  { needsYou: 1, working: 0, reading: '1 needs you' },
  { needsYou: 0, working: 2, reading: '2 working' },
])('keeps a complete $reading without a leading separator at AX5', ({
  needsYou,
  working,
  reading,
}) => {
  appearance.fontScale = 3.12
  const single = {
    ...long,
    buckets: { ...long.buckets, working },
    counts: { 'needs-you': needsYou, 'up-next': 33 },
  } as unknown as FullDeck
  render(<MissionBar full={single} onOpen={() => {}} />)
  const label = visibleText(reading)
  expect(label.parentElement?.textContent).toBe(reading)
  expect(Boolean(screen.queryByTestId('working-word'))).toBe(working > 0)
})

// 704dcf3ba7 MissionBar set minHeight: 40, overriding PressableScale's iOS 44pt floor.
const NATIVE_STRIP_HEIGHT_704DCF = 40

it.each(
  [1, 1.8, 2.35, 3.12].flatMap((scale) => [true, false].map((ready) => ({ scale, ready }))),
)('matches the 704dcf native strip height at scale=$scale, ready=$ready', ({ scale, ready }) => {
  appearance.fontScale = scale
  render(<MissionBar full={{ ...long, ready } as FullDeck} onOpen={() => {}} />)
  const style = getComputedStyle(screen.getByTestId('mission-bar'))
  // Native/Yoga clamps height to minHeight. Checking only `height`
  // misses the inherited 44pt floor even while it enlarges the scroll edge.
  expect(Number.parseFloat(style.height)).toBe(NATIVE_STRIP_HEIGHT_704DCF)
  expect(Number.parseFloat(style.minHeight)).toBe(NATIVE_STRIP_HEIGHT_704DCF)
})
