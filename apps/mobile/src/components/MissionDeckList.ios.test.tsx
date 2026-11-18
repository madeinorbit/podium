import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useContentVisible } from '../lib/visible-content'
import { DeckContent, DeckGroup, DeckProposals } from './MissionDeckList.ios'

type Modifier = { name: string; value: unknown }
type Props = { children?: ReactNode; header?: ReactNode; modifiers?: Modifier[] }
const native = vi.hoisted(() => ({ header: [] as Modifier[] }))

vi.mock('./list-row-press.ios', () => ({
  contentVisibility: (onChange: (visible: boolean) => void) => ({
    name: 'contentVisibility',
    value: onChange,
  }),
}))
vi.mock('@expo/ui', () => ({ Host: ({ children }: Props) => <div>{children}</div> }))
vi.mock('@expo/ui/swift-ui', () => {
  const Box = ({ children }: Props) => <div>{children}</div>
  return {
    Group: Box,
    List: Box,
    RNHostView: Box,
    Section: ({ children, header }: Props) => (
      <section>
        {header}
        {children}
      </section>
    ),
    VStack: ({ children, modifiers = [] }: Props) => {
      native.header = modifiers
      return <div>{children}</div>
    },
  }
})
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(
    [
      'accessibilityIdentifier',
      'animation',
      'background',
      'frame',
      'listRowInsets',
      'listSectionMargins',
      'listSectionSpacing',
      'listStyle',
      'scrollContentBackground',
    ].map((name) => [name, (value: unknown) => ({ name, value })]),
  ),
  Animation: { default: 'default' },
}))
afterEach(cleanup)

function Content() {
  return <span data-testid="header-active">{String(useContentVisible())}</span>
}

it.each([
  [
    'standalone',
    <DeckContent key="standalone">
      <Content />
    </DeckContent>,
  ],
  [
    'group',
    <DeckGroup key="group" testID="group" header={<Content />}>
      <span>Row</span>
    </DeckGroup>,
  ],
  [
    'proposals',
    <DeckProposals key="proposals" ids={[]} header={<Content />}>
      <span>Row</span>
    </DeckProposals>,
  ],
])('keeps the %s header zero-inset trait outside its visibility wrapper', (_kind, element) => {
  render(element)
  const visibility = native.header.findIndex((modifier) => modifier.name === 'contentVisibility')
  const insets = native.header.findIndex((modifier) => modifier.name === 'listRowInsets')
  // Expo applies later modifiers outside earlier ones. The availability
  // branch must not hide the row trait from the native List.
  expect(visibility).toBeGreaterThanOrEqual(0)
  expect(insets).toBeGreaterThan(visibility)
  expect(native.header[insets]?.value).toEqual({ leading: 0, trailing: 0, top: 0, bottom: 0 })
  const onChange = native.header[visibility]?.value as (visible: boolean) => void
  expect(screen.getByTestId('header-active').textContent).toBe('false')
  act(() => onChange(true))
  expect(screen.getByTestId('header-active').textContent).toBe('true')
  act(() => onChange(false))
  expect(screen.getByTestId('header-active').textContent).toBe('false')
})
