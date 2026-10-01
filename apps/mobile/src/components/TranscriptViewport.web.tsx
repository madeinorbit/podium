import { useDomTranscriptScroll } from '@podium/client-core/react/transcript-scroll'
import {
  forwardRef,
  type ForwardedRef,
  type ReactElement,
  type RefAttributes,
  useCallback,
  useImperativeHandle,
  useRef,
} from 'react'
import { ScrollView } from 'react-native'
import type { TranscriptViewportHandle, TranscriptViewportProps } from './TranscriptViewport.types'

const noOperation = () => {}
const separators = { highlight: noOperation, unhighlight: noOperation, updateProps: noOperation }

/** RN Web does not implement native visible-content anchoring. Keep loaded rows
 * in normal DOM order, with the same scroll authority as desktop. Unmeasured
 * virtualizer spacers must never replace the reader's message. */
function WebViewport<Item>(
  {
    identity,
    data,
    keyExtractor,
    anchorKeys,
    renderItem,
    ListEmptyComponent,
    ListFooterComponent,
    moreAbove = false,
    loadingOlder = false,
    onLoadOlder = noOperation,
    onFollowChange,
    ...props
  }: TranscriptViewportProps<Item>,
  ref: ForwardedRef<TranscriptViewportHandle>,
) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const scroll = useDomTranscriptScroll({
    sessionId: identity,
    scrollerRef,
    active: true,
    blockCount: data.length,
    renderStart: 0,
    moreAbove,
    loadingOlder,
    loadOlder: onLoadOlder,
    rowsToRender: data,
    onFollowChange,
  })
  const setScrollView = useCallback(
    (node: ScrollView | null) => {
      scroll.setScrollerRef((node?.getNativeScrollRef() ?? null) as HTMLDivElement | null)
    },
    [scroll.setScrollerRef],
  )
  useImperativeHandle(
    ref,
    () => ({
      pinToNewest: scroll.jumpToBottom,
      scrollToIndex: ({ index, animated }) => scroll.scrollToBlock(index, { instant: !animated }),
    }),
    [scroll.jumpToBottom, scroll.scrollToBlock],
  )
  return (
    <ScrollView
      {...props}
      testID="transcript-scroller"
      ref={setScrollView}
      onScroll={scroll.onScroll}
      scrollEventThrottle={16}
    >
      <div
        ref={scroll.setContentRef}
        style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}
      >
        {data.length === 0 ? ListEmptyComponent : null}
        {data.map((item, index) => {
          const key = keyExtractor(item, index)
          return (
            <div
              key={key}
              data-block={index}
              data-row-key={key}
              data-row-aliases={anchorKeys ? JSON.stringify(anchorKeys(item)) : undefined}
              style={{ display: 'flex', flexDirection: 'column' }}
            >
              {renderItem({ item, index, separators })}
            </div>
          )
        })}
        <div
          data-block={data.length}
          data-row-key="transcript:footer"
          style={{ display: 'flex', flexDirection: 'column' }}
        >
          {ListFooterComponent}
        </div>
      </div>
    </ScrollView>
  )
}

export const TranscriptViewport = forwardRef(WebViewport) as <Item>(
  props: TranscriptViewportProps<Item> & RefAttributes<TranscriptViewportHandle>,
) => ReactElement
