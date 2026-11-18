import type { CellRendererProps } from '@react-native/virtualized-lists'
import {
  type ForwardedRef,
  forwardRef,
  type ReactElement,
  type RefAttributes,
  useCallback,
  useContext,
  useImperativeHandle,
  useRef,
} from 'react'
import { FlatList, Platform, View } from 'react-native'
import { ScrollViewMarker } from 'react-native-screens/experimental'
import { useNativeTranscriptScroll } from '../hooks/useNativeTranscriptScroll'
import { listWindow } from './list-window'
import type { TranscriptViewportHandle, TranscriptViewportProps } from './TranscriptViewport.types'
import {
  type ActivityBounds,
  ActivityViewportContext,
  useActivityViewport,
} from './transcript-activity'

/** Cell layout changes can move a live line without a scroll event. */
function MeasuredCell<Item>({
  cellKey: _key,
  index: _index,
  item: _item,
  onLayout,
  ...props
}: CellRendererProps<Item>) {
  const viewport = useContext(ActivityViewportContext)
  return (
    <View
      {...props}
      onLayout={(event) => {
        onLayout?.(event)
        viewport?.refresh()
      }}
    />
  )
}

export const TranscriptViewport = forwardRef(function NativeViewport<Item>(
  {
    identity,
    anchorKeys: _anchorKeys,
    positionOfKey: _positionOfKey,
    moreAbove,
    loadingOlder,
    onLoadOlder,
    onFollowChange,
    ListFooterComponent,
    visibleInsets,
    ...props
  }: TranscriptViewportProps<Item>,
  ref: ForwardedRef<TranscriptViewportHandle>,
) {
  const listRef = useRef<FlatList<Item>>(null)
  const readBounds = useCallback((receive: (bounds: ActivityBounds) => void) => {
    listRef.current
      ?.getNativeScrollRef()
      ?.measureInWindow((x: number, y: number, width: number, height: number) =>
        receive({ x, y, width, height }),
      )
  }, [])
  const viewport = useActivityViewport(readBounds, visibleInsets)
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
      CellRendererComponent={MeasuredCell}
      ListFooterComponent={ListFooterComponent}
      // The native chat pager must bind its header edge to this list, never
      // to a loading skeleton, message preview or the composer's UITextView.
      testID="chat-transcript-scroll-view"
      ref={listRef}
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      // A status-bar tap (or a ••• tap that lands in the status-bar band)
      // must not fling a chat to its oldest loaded page; Newest and Find are
      // how the transcript moves on request.
      scrollsToTop={false}
      onScroll={(event) => {
        viewport.refresh()
        scroll.onScroll(event)
      }}
      onScrollBeginDrag={scroll.release}
      onScrollEndDrag={scroll.onScrollSettle}
      onMomentumScrollEnd={scroll.onScrollSettle}
      onLayout={(event) => {
        viewport.measure()
        scroll.onLayout(event)
      }}
      onContentSizeChange={(width, height) => {
        viewport.refresh()
        scroll.onContentSizeChange(width, height)
      }}
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
      <ActivityViewportContext value={viewport}>{list}</ActivityViewportContext>
    </ScrollViewMarker>
  ) : (
    <ActivityViewportContext value={viewport}>{list}</ActivityViewportContext>
  )
}) as <Item>(
  props: TranscriptViewportProps<Item> & RefAttributes<TranscriptViewportHandle>,
) => ReactElement
