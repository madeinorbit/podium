import type { IssuePanelArtifact } from '@podium/model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

// The full-screen viewer (boards Artifact, ArtifactDrag): "2 of 3", one page
// per artifact, an opaque ground, a close control.

afterEach(cleanup)

vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' }, impactAsync: vi.fn() }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('../client/server-profile-context', () => ({ useServerProfile: () => ({ bearer: null }) }))
vi.mock('expo-blur', () => ({ BlurView: () => null }))
vi.mock('./RichMarkdown', () => ({ RichMarkdown: () => null }))
vi.mock('./ArtifactVideo', () => ({ ArtifactVideo: () => null }))
vi.mock('react-native-gesture-handler', async () => {
  const { View } = await import('react-native')
  return {
    GestureHandlerRootView: View,
    GestureDetector: ({ children }: { children: unknown }) => children,
    usePanGesture: () => ({}),
  }
})
vi.mock('react-native-reanimated', async () => {
  const { View } = await import('react-native')
  return {
    default: { View },
    Extrapolation: { CLAMP: 'clamp' },
    interpolate: () => 0,
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: number) => ({ get: () => value, set: () => {} }),
    withSpring: (value: number) => value,
    withTiming: (value: number) => value,
  }
})
vi.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: () => void) => fn() }))

const { ArtifactViewer } = await import('./ArtifactViewer')

const art = (path: string): IssuePanelArtifact => ({ path, addedAt: '2026-11-01T00:00:00.000Z' })
const items = ['a.png', 'pricing.png', 'c.png'].map((path) => ({
  key: path,
  artifact: art(path),
  url: `https://podium.local/files/${path}`,
}))

it('names the opened artifact and its place in the list', () => {
  render(<ArtifactViewer items={items} index={1} onClose={() => {}} />)
  expect(screen.getByRole('heading').textContent).toBe('pricing.png')
  expect(screen.getByTestId('artifact-position').textContent).toBe('2 of 3')
})

it('leaves the counter off a single artifact', () => {
  render(
    <ArtifactViewer artifact={art('one.png')} url="https://podium.local/x" onClose={() => {}} />,
  )
  expect(screen.getByRole('heading').textContent).toBe('one.png')
  expect(screen.queryByTestId('artifact-position')).toBeNull()
})

it('draws on an opaque ground and closes from its control', async () => {
  const onClose = vi.fn()
  render(<ArtifactViewer items={items} index={0} onClose={onClose} />)
  const page = screen.getByTestId('artifact-viewer')
  expect(getComputedStyle(page).backgroundColor).not.toMatch(/rgba\(.*,\s*0?\.\d+\)$/)
  await act(async () => fireEvent.click(screen.getByLabelText('Close artifact')))
  expect(onClose).toHaveBeenCalledOnce()
})

it('renders nothing without an artifact', () => {
  const { container } = render(<ArtifactViewer artifact={null} url={null} onClose={() => {}} />)
  expect(container.textContent).toBe('')
})
