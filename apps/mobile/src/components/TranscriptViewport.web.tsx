import { useDomTranscriptScroll } from '@podium/client-core/react/transcript-scroll'
import {
  type ForwardedRef,
  forwardRef,
  type ReactElement,
  type RefAttributes,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Keyboard, ScrollView } from 'react-native'
import type { TranscriptViewportHandle, TranscriptViewportProps } from './TranscriptViewport.types'

const noOperation = () => {}
const separators = { highlight: noOperation, unhighlight: noOperation, updateProps: noOperation }
const RENDER_WINDOW = 80

/** Mount a bounded tail while following, revealing history in measured DOM
 * order as the reader moves up. Keep the mounted head while reading, just as
 * desktop does; native FlatList windowing is unavailable in RN Web. */
export const TranscriptViewport = forwardRef(function WebViewport<Item>(
  {
    identity,
    data,
    extraData,
    keyExtractor,
    positionOfKey,
    anchorKeys,
    renderItem,
    ListEmptyComponent,
    ListFooterComponent,
    moreAbove = false,
    loadingOlder = false,
    onLoadOlder = noOperation,
    onFollowChange,
    keyboardDismissMode,
    ...props
  }: TranscriptViewportProps<Item>,
  ref: ForwardedRef<TranscriptViewportHandle>,
) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [following, setFollowing] = useState(true)
  const [renderCount, setRenderCount] = useState(RENDER_WINDOW)
  const heldHead = useRef<{ identity: string; key: string } | null>(null)
  const pendingTarget = useRef<{ key: string; animated: boolean } | null>(null)
  const windowIdentity = useRef(identity)
  const tailStart = Math.max(
    0,
    data.length - (windowIdentity.current === identity ? renderCount : RENDER_WINDOW),
  )
  const retainedStart =
    !following && heldHead.current?.identity === identity
      ? (positionOfKey(heldHead.current.key) ?? -1)
      : -1
  const renderStart = retainedStart >= 0 ? Math.min(tailStart, retainedStart) : tailStart
  const visibleRows = useMemo(() => data.slice(renderStart), [data, extraData, renderStart])
  useLayoutEffect(() => {
    windowIdentity.current = identity
    setFollowing(true)
    setRenderCount(RENDER_WINDOW)
    pendingTarget.current = null
  }, [identity])
  useLayoutEffect(() => {
    const first = visibleRows[0]
    heldHead.current =
      first === undefined ? null : { identity, key: keyExtractor(first, renderStart) }
  }, [identity, keyExtractor, renderStart, visibleRows])
  const followChanged = useCallback(
    (next: boolean) => {
      setFollowing(next)
      if (next) setRenderCount(RENDER_WINDOW)
      onFollowChange?.(next)
    },
    [onFollowChange],
  )
  const revealOlder = useCallback(() => {
    if (renderStart > 0) setRenderCount((count) => count + RENDER_WINDOW)
    else onLoadOlder()
  }, [onLoadOlder, renderStart])
  const scroll = useDomTranscriptScroll({
    sessionId: identity,
    scrollerRef,
    active: true,
    blockCount: data.length,
    renderStart,
    moreAbove: renderStart > 0 || moreAbove,
    loadingOlder,
    loadOlder: revealOlder,
    rowsToRender: visibleRows,
    lookupAnchorRow: positionOfKey,
    onFollowChange: followChanged,
  })
  useEffect(() => {
    const element = scrollerRef.current
    if (!element || keyboardDismissMode !== 'on-drag') return
    // RN Web dismisses from every scroll event, including Safari's keyboard
    // adjustment and our live-content following. Dismiss only for reader input.
    const dismiss = () => Keyboard.dismiss()
    element.addEventListener('touchmove', dismiss, { passive: true })
    element.addEventListener('wheel', dismiss, { passive: true })
    return () => {
      element.removeEventListener('touchmove', dismiss)
      element.removeEventListener('wheel', dismiss)
    }
  }, [keyboardDismissMode])
  useLayoutEffect(() => {
    const target = pendingTarget.current
    if (!target) return
    const index = positionOfKey(target.key) ?? -1
    if (index < renderStart) return
    pendingTarget.current = null
    if (index >= 0) scroll.scrollToBlock(index, { instant: !target.animated })
  }, [positionOfKey, renderStart, scroll.scrollToBlock])
  const setScrollView = useCallback(
    (node: ScrollView | null) => {
      const element = (node?.getNativeScrollRef() ?? null) as HTMLDivElement | null
      // RN Web installs its {x, y, animated} scrollTo on this DOM node. Our
      // shared browser scroll authority needs the native {top, behavior} API.
      if (element) element.scrollTo = HTMLElement.prototype.scrollTo.bind(element)
      scroll.setScrollerRef(element)
    },
    [scroll.setScrollerRef],
  )
  useImperativeHandle(
    ref,
    () => ({
      pinToNewest() {
        setRenderCount(RENDER_WINDOW)
        scroll.jumpToBottom()
      },
      scrollToIndex({ index, animated }) {
        const item = data[index]
        if (item === undefined) return
        if (index >= renderStart) scroll.scrollToBlock(index, { instant: !animated })
        else {
          pendingTarget.current = { key: keyExtractor(item, index), animated }
          setRenderCount(Math.max(RENDER_WINDOW, data.length - index))
        }
      },
    }),
    [data, keyExtractor, renderStart, scroll.jumpToBottom, scroll.scrollToBlock],
  )
  return (
    <ScrollView
      {...props}
      keyboardDismissMode="none"
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
        {visibleRows.map((item, visibleIndex) => {
          const index = renderStart + visibleIndex
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
}) as <Item>(
  props: TranscriptViewportProps<Item> & RefAttributes<TranscriptViewportHandle>,
) => ReactElement
