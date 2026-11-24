import { act, cleanup, render, waitFor } from '@testing-library/react'
import { Animated, type ScrollViewProps, StyleSheet, Text } from 'react-native'
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
const motion = vi.hoisted(() => ({ reduce: true }))
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

vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => motion.reduce }))
afterEach(() => {
  cleanup()
  motion.reduce = true
  vi.restoreAllMocks()
})

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
  it('keeps transcript text hidden until the placeholder finishes fading out', async () => {
    motion.reduce = false
    // RN web's testing sequence starts every child immediately. Exercise its
    // real sequence so this test observes the native completion boundary.
    const { default: implementation } = await vi.importActual<{ default: typeof Animated }>(
      'react-native-web/dist/vendor/react-native/Animated/AnimatedImplementation',
    )
    vi.spyOn(Animated, 'sequence').mockImplementation(implementation.sequence)
    const finishes: Array<() => void> = []
    vi.spyOn(Animated, 'timing').mockImplementation((value, config) => {
      let finish: (() => void) | undefined
      return {
        start: (callback) => {
          finish = () => {
            const opacity = value as Animated.Value
            opacity.setValue(config.toValue as number)
            callback?.({ finished: true })
          }
          finishes.push(finish)
        },
        stop: () => {
          if (!finish) return
          const index = finishes.indexOf(finish)
          if (index >= 0) finishes.splice(index, 1)
        },
        reset: () => {},
      }
    })
    const page = (resolved: boolean) => (
      <BootstrapCrossfade resolved={resolved} placeholder={<TranscriptSkeleton />}>
        <Text>real transcript</Text>
      </BootstrapCrossfade>
    )
    const view = render(page(false))
    const content = view.getByText('real transcript').parentElement as HTMLElement
    const skeleton = view.getByTestId('bootstrap-placeholder')
    expect(content.style.opacity).toBe('0')
    view.rerender(page(true))
    expect(finishes).toHaveLength(1)
    expect(content.style.opacity).toBe('0')
    act(() => finishes.shift()?.())
    expect(skeleton.style.opacity).toBe('0')
    expect(content.style.opacity).toBe('0')
    expect(finishes).toHaveLength(1)
    act(() => finishes.shift()?.())
    expect(content.style.opacity).toBe('1')
    expect(view.queryByTestId('bootstrap-placeholder')).toBeNull()
  })

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
