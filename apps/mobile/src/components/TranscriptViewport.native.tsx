import {
  forwardRef,
  type ForwardedRef,
  type ReactElement,
  type RefAttributes,
  useCallback,
  useImperativeHandle,
  useRef,
} from 'react'
import { FlatList } from 'react-native'
import { useNativeTranscriptScroll } from '../hooks/useNativeTranscriptScroll'
import type { TranscriptViewportHandle, TranscriptViewportProps } from './TranscriptViewport.types'

function NativeViewport<Item>(
  {
    identity,
    anchorKeys: _anchorKeys,
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
  return (
    <FlatList
      {...props}
      ref={listRef}
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      onScroll={scroll.onScroll}
      onScrollBeginDrag={scroll.release}
      onLayout={scroll.onLayout}
      onContentSizeChange={scroll.onContentSizeChange}
      scrollEventThrottle={16}
      onScrollToIndexFailed={({ index, averageItemLength }) =>
        scrollToOffset(Math.max(0, index * averageItemLength))
      }
    />
  )
}

export const TranscriptViewport = forwardRef(NativeViewport) as <Item>(
  props: TranscriptViewportProps<Item> & RefAttributes<TranscriptViewportHandle>,
) => ReactElement
