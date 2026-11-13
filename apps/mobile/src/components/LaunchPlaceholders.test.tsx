import { cleanup, render, waitFor } from '@testing-library/react'
import { type ScrollViewProps, StyleSheet, Text } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeaderInsetContext } from '../navigation/header-inset'
import {
  BootstrapCrossfade,
  DetailSkeleton,
  TasksSkeleton,
  TranscriptSkeleton,
  WorkSkeleton,
} from './LaunchPlaceholders'

const scroll = vi.hoisted(() => ({ props: {} as ScrollViewProps }))
vi.mock('react-native', async (original) => {
  const rn = await original<typeof import('react-native')>()
  return {
    ...rn,
    ScrollView: (props: ScrollViewProps) => {
      // The DOM renderer drops the UIKit-only inset props. Observe that native
      // boundary while rendering the actual scroll container and placeholder.
      scroll.props = props
      return <rn.ScrollView {...props} />
    },
  }
})

vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
afterEach(cleanup)

describe('skeleton content insets', () => {
  it.each([
    ['work', WorkSkeleton, 'Loading work'],
    ['tasks', TasksSkeleton, 'Loading tasks'],
    ['detail', DetailSkeleton, 'Loading task detail'],
  ] as const)('uses native scroll adjustment for %s, including a changing large title', (_, Skeleton, label) => {
    const page = (headerHeight: number) => (
      <HeaderInsetContext value={headerHeight}>
        <Skeleton />
      </HeaderInsetContext>
    )
    const view = render(page(156))
    expect(view.getByLabelText(label)).toBeTruthy()
    expect(scroll.props.contentInsetAdjustmentBehavior).toBe('automatic')
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle)?.paddingTop).toBe(0)

    // UIKit owns both the expanded and collapsed title inset, and a body that
    // already sits below its header must not gain another manual header gap.
    for (const inset of [103, 0]) {
      view.rerender(page(inset))
      expect(scroll.props.contentInsetAdjustmentBehavior).toBe('automatic')
      expect(StyleSheet.flatten(scroll.props.contentContainerStyle)?.paddingTop).toBe(0)
    }
    expect(scroll.props.scrollEnabled).toBe(false)
    expect(scroll.props.scrollsToTop).toBe(false)
  })

  it('matches the transcript measured top and composer insets without double insetting', () => {
    const view = render(
      <HeaderInsetContext value={103}>
        <TranscriptSkeleton topInset={147} bottomInset={124} />
      </HeaderInsetContext>,
    )
    expect(view.getByLabelText('Loading transcript')).toBeTruthy()
    expect(scroll.props.contentInsetAdjustmentBehavior).toBe('never')
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle)).toMatchObject({
      paddingTop: 147,
      paddingBottom: 124,
    })
    // Header and composer measurements can change after the first frame.
    view.rerender(
      <HeaderInsetContext value={103}>
        <TranscriptSkeleton topInset={171} bottomInset={164} />
      </HeaderInsetContext>,
    )
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle)).toMatchObject({
      paddingTop: 171,
      paddingBottom: 164,
    })
  })

  it('uses the screen header for chat and honors an explicitly paid zero inset', () => {
    const view = render(
      <HeaderInsetContext value={156}>
        <TranscriptSkeleton />
      </HeaderInsetContext>,
    )
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle)?.paddingTop).toBe(156)
    view.rerender(
      <HeaderInsetContext value={156}>
        <TranscriptSkeleton topInset={0} />
      </HeaderInsetContext>,
    )
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle)?.paddingTop).toBe(0)
    expect(scroll.props.contentInsetAdjustmentBehavior).toBe('never')
  })
})

describe('BootstrapCrossfade', () => {
  it('covers unresolved content, then latches the resolved page across reconnects', async () => {
    const renderPage = (resolved: boolean) => (
      <BootstrapCrossfade resolved={resolved} placeholder={<WorkSkeleton />}>
        <Text>real work</Text>
      </BootstrapCrossfade>
    )
    const view = render(renderPage(false))

    expect(view.getByTestId('bootstrap-placeholder')).toBeTruthy()
    view.rerender(renderPage(true))
    await waitFor(() => expect(view.queryByTestId('bootstrap-placeholder')).toBeNull())

    // A later transport re-bootstrap is a reconnect, not another app launch.
    view.rerender(renderPage(false))
    expect(view.queryByTestId('bootstrap-placeholder')).toBeNull()
    expect(view.getByText('real work')).toBeTruthy()
  })
})
