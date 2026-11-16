import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ os: 'ios', edge: undefined as unknown }))
vi.mock('react-native', async (original) => {
  const rn = await original<typeof import('react-native')>()
  const { forwardRef } = await import('react')
  return {
    ...rn,
    Platform: {
      ...rn.Platform,
      get OS() {
        return native.os
      },
    },
    // UIKit/FlatList is the boundary here. Keep it a single native scroll node
    // so the marker's direct-child requirement is observable in this lane.
    FlatList: forwardRef(({ testID }: { testID?: string }, _ref) => (
      <div data-testid="native-transcript-scroll-view" data-native-id={testID} />
    )),
  }
})
vi.mock('react-native-screens/experimental', () => ({
  ScrollViewMarker: ({
    children,
    scrollEdgeEffects,
  }: {
    children: ReactNode
    scrollEdgeEffects: unknown
  }) => {
    native.edge = scrollEdgeEffects
    return <div data-testid="native-scroll-marker">{children}</div>
  },
}))

const { TranscriptViewport } = await import('./TranscriptViewport.native')
afterEach(() => {
  cleanup()
  native.os = 'ios'
  native.edge = undefined
})

const viewport = () => (
  <TranscriptViewport
    identity="chat"
    data={['message']}
    keyExtractor={(key) => key}
    positionOfKey={() => 0}
    renderItem={() => null}
  />
)

it('applies the native soft top edge to the actual transcript scroll view after it mounts', () => {
  render(viewport())
  expect(native.edge).toEqual({ top: 'soft' })
  const marker = screen.getByTestId('native-scroll-marker')
  expect(marker.children).toHaveLength(1)
  expect(marker.firstElementChild).toBe(screen.getByTestId('native-transcript-scroll-view'))
  expect(screen.getByTestId('native-transcript-scroll-view').dataset.nativeId).toBe(
    'chat-transcript-scroll-view',
  )
})

it('leaves the Android scroll view without an iOS edge marker', () => {
  native.os = 'android'
  render(viewport())
  expect(screen.queryByTestId('native-scroll-marker')).toBeNull()
  expect(screen.getByTestId('native-transcript-scroll-view')).toBeTruthy()
})
