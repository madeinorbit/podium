import type { CellRendererProps } from '@react-native/virtualized-lists'
import {
  createContext,
  type ForwardedRef,
  forwardRef,
  type ReactElement,
  type RefAttributes,
  useCallback,
  useContext,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { FlatList, Platform, StyleSheet, View, type ViewToken } from 'react-native'
import { ScrollViewMarker } from 'react-native-screens/experimental'
import { useNativeTranscriptScroll } from '../hooks/useNativeTranscriptScroll'
import { VisibleContent } from '../lib/visible-content'
import { listWindow } from './list-window'
import type { TranscriptViewportHandle, TranscriptViewportProps } from './TranscriptViewport.types'

const ViewableContext = createContext<ReadonlySet<string>>(new Set())
const viewabilityConfig = { itemVisiblePercentThreshold: 1 }

/** FlatList retains neighboring cells. Their content stays mounted, but only
 * the viewport's cells observe time and create animated styles. */
function VisibleCell<Item>({
  cellKey,
  children,
  index: _index,
  item: _item,
  ...props
}: CellRendererProps<Item>) {
  const keys = useContext(ViewableContext)
  return (
    <View {...props}>
      <VisibleContent visible={keys.has(cellKey)}>{children}</VisibleContent>
    </View>
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
  const [viewableKeys, setViewableKeys] = useState<ReadonlySet<string>>(() => new Set())
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<Item>[] }) => {
      const keys = new Set(viewableItems.map((item) => item.key))
      setViewableKeys((previous) =>
        previous.size === keys.size && [...keys].every((key) => previous.has(key))
          ? previous
          : keys,
      )
    },
    [],
  )
  const [footerVisible, setFooterVisible] = useState(false)
  const geometry = useRef({ height: 0, viewport: 0, offset: 0, footer: 0, visible: false })
  const bottomPadding = StyleSheet.flatten(props.contentContainerStyle)?.paddingBottom
  const hiddenTop = visibleInsets?.top ?? 0
  const hiddenBottom = visibleInsets?.bottom ?? 0
  const updateFooterVisibility = useCallback(() => {
    const { height, viewport, offset, footer } = geometry.current
    const top = height - footer - (typeof bottomPadding === 'number' ? bottomPadding : 0)
    const visible =
      footer > 0 &&
      viewport > 0 &&
      top < offset + viewport - hiddenBottom &&
      top + footer > offset + hiddenTop
    if (visible !== geometry.current.visible) {
      geometry.current.visible = visible
      setFooterVisible(visible)
    }
  }, [bottomPadding, hiddenTop, hiddenBottom])
  useLayoutEffect(updateFooterVisibility, [updateFooterVisibility])
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
      CellRendererComponent={VisibleCell}
      viewabilityConfig={viewabilityConfig}
      onViewableItemsChanged={onViewableItemsChanged}
      ListFooterComponent={
        ListFooterComponent ? (
          <View
            onLayout={(event) => {
              geometry.current.footer = event.nativeEvent.layout.height
              updateFooterVisibility()
            }}
          >
            <VisibleContent visible={footerVisible}>{ListFooterComponent}</VisibleContent>
          </View>
        ) : undefined
      }
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
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
        geometry.current.offset = contentOffset.y
        geometry.current.height = contentSize.height
        geometry.current.viewport = layoutMeasurement.height
        updateFooterVisibility()
        scroll.onScroll(event)
      }}
      onScrollBeginDrag={scroll.release}
      onScrollEndDrag={scroll.onScrollSettle}
      onMomentumScrollEnd={scroll.onScrollSettle}
      onLayout={(event) => {
        geometry.current.viewport = event.nativeEvent.layout.height
        updateFooterVisibility()
        scroll.onLayout(event)
      }}
      onContentSizeChange={(width, height) => {
        geometry.current.height = height
        updateFooterVisibility()
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
      <ViewableContext value={viewableKeys}>{list}</ViewableContext>
    </ScrollViewMarker>
  ) : (
    <ViewableContext value={viewableKeys}>{list}</ViewableContext>
  )
}) as <Item>(
  props: TranscriptViewportProps<Item> & RefAttributes<TranscriptViewportHandle>,
) => ReactElement
