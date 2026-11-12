import type { IssueViewModel } from '@podium/client-core/replica'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { View as RNView } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'
import { poolRouteFixture } from '../../test/pool-routes'

const issues = [
  { id: 'issue-13', seq: 13, prefix: 'POD', displayRef: 'POD-13', title: 'Chips', stage: 'review' },
] as IssueViewModel[]

vi.mock('../client/use-inbox-data', () => ({
  usePoolRefChip: (token: string, kind: 'issue' | 'session', prefix: string) => {
    const fixture = poolRouteFixture({ issues, sessions: [] })
    try {
      return fixture.views.chip(token, kind, prefix)
    } finally {
      fixture.dispose()
    }
  },
}))
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  const Stub = (props: ComponentProps<typeof RNView>) => <View {...props} />
  return { default: Stub, Svg: Stub, Circle: Stub, Path: Stub, Rect: Stub, G: Stub }
})
vi.mock('../lib/podium-link', () => ({ followPodiumLink: vi.fn(), openPodiumTarget: vi.fn() }))
vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }))

const { RichMarkdown } = await import('./RichMarkdown')
const { openPodiumTarget } = await import('../lib/podium-link')

afterEach(cleanup)

it('renders issue and session refs in chat prose as chips [POD-2444]', () => {
  const onRefPress = vi.fn()
  render(
    <RichMarkdown
      text="Merged POD-13 after **POD-13-A** reviewed it; see UTF-8."
      onRefPress={onRefPress}
    />,
  )
  fireEvent.click(screen.getByRole('link', { name: /task POD-13\b/i }))
  expect(onRefPress).toHaveBeenCalledWith('POD-13')
  fireEvent.click(screen.getByRole('link', { name: /Session POD-13-A/i }))
  expect(openPodiumTarget).toHaveBeenCalledWith({ kind: 'session', session: 'POD-13-A' })
  // An unregistered prefix is prose, not a chip.
  expect(screen.queryByRole('link', { name: /UTF-8/ })).toBeNull()
  expect(screen.getAllByRole('link')).toHaveLength(2)
})

it('unwraps a backticked sole ref into a chip, as desktop does', () => {
  const { container } = render(
    <RichMarkdown text="Filed `POD-13`, ran `podium issue show POD-13`, kept `UTF-8`." />,
  )
  expect(screen.getAllByRole('link')).toHaveLength(1)
  screen.getByRole('link', { name: /task POD-13\b/i })
  // A ref quoted inside a longer span stays literal code, and so does a
  // ref-shaped token whose prefix is not a repo's.
  const leaves = Array.from(container.querySelectorAll('span'))
  expect(leaves.some((el) => el.textContent === 'podium issue show POD-13')).toBe(true)
  expect(leaves.some((el) => el.textContent === 'UTF-8')).toBe(true)
})
