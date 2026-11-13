import {
  type ForwardedRef,
  forwardRef,
  type ReactElement,
  type RefAttributes,
  useCallback,
  useImperativeHandle,
  useRef,
} from 'react'
import { FlatList, Platform } from 'react-native'
import { ScrollViewMarker } from 'react-native-screens/experimental'
import { useNativeTranscriptScroll } from '../hooks/useNativeTranscriptScroll'
import { listWindow } from './list-window'
import type { TranscriptViewportHandle, TranscriptViewportProps } from './TranscriptViewport.types'

export const TranscriptViewport = forwardRef(function NativeViewport<Item>(
  {
    identity,
    anchorKeys: _anchorKeys,
    positionOfKey: _positionOfKey,
    moreAbove,
    loadingOlder,
    onLoadOlder,
    onFollowChange,
    ...props
  }: TranscriptViewportProps<Item>,
  ref: ForwardedRef<TranscriptViewportHandle>,
) {
  const listRef = useRef<FlatList<Item>>(null)
  const scrollToOffset = useCallback((offset: number) => {
    listRef.current?.scrollToOffset({ offset, animated: false })
  }, [])
  const scroll = useNativeTranscriptScroll({
    identity,
    moreAbove,
    loadingOlder,
    onLoadOlder,
    onFollowChange,
    scrollToOffset,
  })
  useImperativeHandle(
    ref,
    () => ({
      pinToNewest: scroll.jumpToBottom,
      scrollToIndex(options) {
        scroll.readAtTarget()
        listRef.current?.scrollToIndex(options)
      },
    }),
    [scroll.jumpToBottom, scroll.readAtTarget],
  )
  const list = (
    <FlatList
      {...props}
      {...listWindow}
      ref={listRef}
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      // A status-bar tap (or a ••• tap that lands in the status-bar band)
      // must not fling a chat to its oldest loaded page; Newest and Find are
      // how the transcript moves on request.
      scrollsToTop={false}
      onScroll={scroll.onScroll}
      onScrollBeginDrag={scroll.release}
      onScrollEndDrag={scroll.onScrollSettle}
      onMomentumScrollEnd={scroll.onScrollSettle}
      onLayout={scroll.onLayout}
      onContentSizeChange={scroll.onContentSizeChange}
      scrollEventThrottle={16}
      onScrollToIndexFailed={({ index, averageItemLength }) =>
        scrollToOffset(Math.max(0, index * averageItemLength))
      }
    />
  )
  // Configure the actual UIScrollView when it mounts, including after the
  // transcript/composer loading boundary. A screen-level option is applied
  // before that scroll view exists and the v4 stack does not revisit it.
  // The marker also preserves the first-descendant chain for UIKit's header.
  return Platform.OS === 'ios' ? (
    <ScrollViewMarker style={{ flex: 1, minHeight: 0 }} scrollEdgeEffects={{ top: 'soft' }}>
      {list}
    </ScrollViewMarker>
  ) : (
    list
  )
}) as <Item>(
  props: TranscriptViewportProps<Item> & RefAttributes<TranscriptViewportHandle>,
) => ReactElement
