import { useCallback, useLayoutEffect, useRef } from 'react'
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import { measureAtTail, tailOffset } from '../lib/transcript-tail'

interface Options {
  identity: string
  scrollToOffset: (offset: number) => void
  onLoadOlder?: () => void
  onFollowChange?: (following: boolean) => void
  moreAbove?: boolean
  loadingOlder?: boolean
}

/** Native maintains row geometry through maintainVisibleContentPosition. This
 * hook owns intent only: a real drag releases before content-size callbacks,
 * and a layout-induced scroll can never rearm following. */
export function useNativeTranscriptScroll({
  identity,
  scrollToOffset,
  onLoadOlder,
  onFollowChange,
  moreAbove = false,
  loadingOlder = false,
}: Options) {
  const followChangeRef = useRef(onFollowChange)
  useLayoutEffect(() => {
    followChangeRef.current = onFollowChange
  }, [onFollowChange])
  const following = useRef(true)
  const userMoving = useRef(false)
  const height = useRef(0)
  const viewport = useRef(0)
  const offset = useRef(0)
  const writtenOffset = useRef<number | null>(null)
  const observedGeometry = useRef({ height: 0, viewport: 0 })
  const setFollowing = useCallback((next: boolean) => {
    if (following.current === next) return
    following.current = next
    followChangeRef.current?.(next)
  }, [])
  const followLayout = useCallback(() => {
    if (!following.current || height.current === 0) return
    const target = tailOffset(height.current, viewport.current)
    if (Math.abs(target - offset.current) <= 0.5) return
    writtenOffset.current = target
    offset.current = target
    scrollToOffset(target)
  }, [scrollToOffset])
  const release = useCallback(() => {
    userMoving.current = true
    setFollowing(false)
    // With a collapsed page that fits in the viewport, dragging cannot move
    // the offset. Reader intent must still be able to request older history.
    if (
      height.current <= viewport.current &&
      offset.current <= 0 &&
      moreAbove &&
      !loadingOlder
    )
      onLoadOlder?.()
  }, [loadingOlder, moreAbove, onLoadOlder, setFollowing])
  const readAtTarget = useCallback(() => {
    userMoving.current = false
    setFollowing(false)
  }, [setFollowing])
  const jumpToBottom = useCallback(() => {
    userMoving.current = false
    setFollowing(true)
    followLayout()
  }, [followLayout, setFollowing])
  useLayoutEffect(() => {
    userMoving.current = false
    writtenOffset.current = null
    setFollowing(true)
    followLayout()
  }, [identity, followLayout, setFollowing])
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
      const previous = offset.current
      const top = contentOffset.y
      const ownWrite =
        writtenOffset.current !== null && Math.abs(top - writtenOffset.current) <= 0.5
      const resized =
        observedGeometry.current.height !== contentSize.height ||
        observedGeometry.current.viewport !== layoutMeasurement.height
      writtenOffset.current = null
      observedGeometry.current = { height: contentSize.height, viewport: layoutMeasurement.height }
      offset.current = top
      if (userMoving.current && !ownWrite && !resized) {
        if (top < previous) setFollowing(false)
        else if (top > previous && measureAtTail(top, layoutMeasurement.height, contentSize.height))
          setFollowing(true)
        if (top < previous && top < Math.max(120, layoutMeasurement.height * 2) && moreAbove && !loadingOlder) onLoadOlder?.()
      }
    },
    [loadingOlder, moreAbove, onLoadOlder, setFollowing],
  )
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewport.current = event.nativeEvent.layout.height
      followLayout()
    },
    [followLayout],
  )
  const onContentSizeChange = useCallback(
    (_width: number, nextHeight: number) => {
      height.current = nextHeight
      followLayout()
    },
    [followLayout],
  )
  return { release, readAtTarget, jumpToBottom, onScroll, onLayout, onContentSizeChange }
}
