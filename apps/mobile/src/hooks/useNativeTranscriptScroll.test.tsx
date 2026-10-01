import { act, cleanup, renderHook } from '@testing-library/react'
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNativeTranscriptScroll } from './useNativeTranscriptScroll'

afterEach(cleanup)
const layout = (height: number) => ({ nativeEvent: { layout: { height } } }) as LayoutChangeEvent
const motion = (top: number, height = 2000, viewport = 600) =>
  ({
    nativeEvent: {
      contentOffset: { y: top },
      contentSize: { height },
      layoutMeasurement: { height: viewport },
    },
  }) as NativeSyntheticEvent<NativeScrollEvent>

function setup() {
  const write = vi.fn()
  const mode = vi.fn()
  const older = vi.fn()
  const hook = renderHook(
    ({ identity }) =>
      useNativeTranscriptScroll({
        identity,
        scrollToOffset: write,
        onFollowChange: mode,
        onLoadOlder: older,
        moreAbove: true,
      }),
    { initialProps: { identity: 'one' } },
  )
  act(() => {
    hook.result.current.onLayout(layout(600))
    hook.result.current.onContentSizeChange(300, 2000)
    hook.result.current.onScroll(motion(1400))
  })
  write.mockClear()
  mode.mockClear()
  return { ...hook, write, mode, older }
}

describe('native transcript intent', () => {
  it('requests older history on a drag when the loaded page cannot scroll', () => {
    const older = vi.fn()
    const write = vi.fn()
    const { result, rerender } = renderHook(
      ({ loadingOlder }) =>
        useNativeTranscriptScroll({
          identity: 'short-page',
          scrollToOffset: write,
          onLoadOlder: older,
          moreAbove: true,
          loadingOlder,
        }),
      { initialProps: { loadingOlder: false } },
    )
    act(() => {
      result.current.onLayout(layout(600))
      result.current.onContentSizeChange(300, 200)
      result.current.release()
    })
    expect(older).toHaveBeenCalledTimes(1)
    rerender({ loadingOlder: true })
    act(() => result.current.release())
    expect(older).toHaveBeenCalledTimes(1)
  })
  it('keeps a programmatic search in reading mode even if the target reaches the bottom', () => {
    const { result, mode, write } = setup()
    act(() => {
      result.current.readAtTarget()
      result.current.onScroll(motion(700))
      result.current.onScroll(motion(1400))
      result.current.onContentSizeChange(300, 2300)
    })
    expect(mode).toHaveBeenLastCalledWith(false)
    expect(write).not.toHaveBeenCalled()
  })
  it('releases on drag before a content callback or scroll event arrives', () => {
    const { result, write, mode } = setup()
    act(() => {
      result.current.release()
      result.current.onContentSizeChange(300, 2400)
    })
    expect(mode).toHaveBeenLastCalledWith(false)
    expect(write).not.toHaveBeenCalled()
  })
  it('follows content and viewport changes only while following', () => {
    const { result, write } = setup()
    act(() => result.current.onContentSizeChange(300, 2200))
    expect(write).toHaveBeenLastCalledWith(1600)
    act(() => result.current.onLayout(layout(450)))
    expect(write).toHaveBeenLastCalledWith(1750)
    write.mockClear()
    act(() => {
      result.current.release()
      result.current.onLayout(layout(350))
    })
    expect(write).not.toHaveBeenCalled()
  })
  it('ignores a dimension-induced clamp at the bottom when reading', () => {
    const { result, mode, write } = setup()
    act(() => {
      result.current.release()
      result.current.onScroll(motion(900))
      result.current.onContentSizeChange(300, 1500)
      result.current.onScroll(motion(900, 1500))
      result.current.onContentSizeChange(300, 1800)
    })
    expect(mode).toHaveBeenLastCalledWith(false)
    expect(write).not.toHaveBeenCalled()
  })
  it('rearms only after actual downward movement to the bottom', () => {
    const { result, mode } = setup()
    act(() => {
      result.current.release()
      result.current.onScroll(motion(900))
      result.current.onScroll(motion(1360))
    })
    expect(mode).toHaveBeenLastCalledWith(false)
    act(() => result.current.onScroll(motion(1399)))
    expect(mode).toHaveBeenLastCalledWith(true)
  })
  it('allows immediate escape after a jump', () => {
    const { result, mode, write } = setup()
    act(() => {
      result.current.release()
      result.current.onScroll(motion(700))
      result.current.jumpToBottom()
    })
    expect(write).toHaveBeenLastCalledWith(1400)
    expect(mode).toHaveBeenLastCalledWith(true)
    write.mockClear()
    act(() => {
      result.current.release()
      result.current.onContentSizeChange(300, 2500)
    })
    expect(mode).toHaveBeenLastCalledWith(false)
    expect(write).not.toHaveBeenCalled()
  })
  it('requests history only on upward reader movement, excluding prepend correction', () => {
    const { result, older } = setup()
    act(() => {
      result.current.release()
      result.current.onScroll(motion(90))
      result.current.onContentSizeChange(300, 2800)
      result.current.onScroll(motion(890, 2800))
    })
    expect(older).toHaveBeenCalledTimes(1)
  })
  it('opens a different conversation following without changing mode on callback replacement', () => {
    const write = vi.fn()
    const mode = vi.fn()
    const { result, rerender } = renderHook(
      ({ identity, callback }) =>
        useNativeTranscriptScroll({
          identity,
          onFollowChange: callback,
          scrollToOffset: write,
        }),
      { initialProps: { identity: 'one', callback: mode } },
    )
    act(() => result.current.release())
    const latest = vi.fn()
    rerender({ identity: 'one', callback: latest })
    act(() => result.current.onContentSizeChange(300, 2000))
    expect(write).not.toHaveBeenCalled()
    rerender({ identity: 'two', callback: latest })
    expect(latest).toHaveBeenLastCalledWith(true)
    expect(write).toHaveBeenLastCalledWith(2000)
  })
})
