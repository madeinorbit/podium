import { useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TranscriptViewport } from '../../../apps/mobile/src/components/TranscriptViewport.web'
import type { TranscriptViewportHandle } from '../../../apps/mobile/src/components/TranscriptViewport.types'
import { useTranscriptScroll } from '../../../apps/web/src/features/chat/use-transcript-scroll'

export interface ScrollSnapshot {
  top: number
  gap: number
  following: boolean
  loading: boolean
  key: string
  offset: number
}

export interface ScrollFixture {
  snapshot(): ScrollSnapshot
  append(): void
  completePage(): void
  growAbove(): void
  reflowAboveAndBelow(): void
  shortPage(): void
  jump(): void
  search(): void
}

declare global {
  interface Window {
    __transcriptScrollFixture: ScrollFixture
  }
}

const phone = new URLSearchParams(location.search).get('viewport') === 'phone'

function Fixture() {
  const [rows, setRows] = useState(Array.from({ length: 40 }, (_, index) => `held-${index}`))
  const [loading, setLoading] = useState(false)
  const [older, setOlder] = useState(true)
  const [firstHeight, setFirstHeight] = useState(72)
  const [lastHeight, setLastHeight] = useState(72)
  const nextId = useRef(0)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<TranscriptViewportHandle>(null)
  const [phoneFollowing, setPhoneFollowing] = useState(true)
  const scroll = useTranscriptScroll({
    sessionId: 'scroll-fixture' as never,
    scrollerRef,
    active: !phone,
    blockCount: rows.length,
    renderStart: 0,
    stickyEnabled: false,
    moreAbove: older,
    loadingOlder: loading,
    loadOlder: () => setLoading(true),
    rowsToRender: rows,
  })
  const jump = () => (phone ? viewportRef.current?.pinToNewest() : scroll.jumpToBottom())
  useLayoutEffect(() => {
    if (phone) {
      scrollerRef.current = document.querySelector('[data-testid="transcript-scroller"]')
      scrollerRef.current?.setAttribute('data-feed-scroller', '')
      scrollerRef.current?.setAttribute('tabindex', '0')
    }
    window.__transcriptScrollFixture = {
      snapshot() {
        const element = scrollerRef.current!
        const viewport = element.getBoundingClientRect()
        const visible = [...element.querySelectorAll<HTMLElement>('[data-block]')].find(
          (row) => row.getBoundingClientRect().bottom > viewport.top,
        )
        return {
          top: element.scrollTop,
          gap: element.scrollHeight - element.clientHeight - element.scrollTop,
          following: phone ? phoneFollowing : scroll.atBottom,
          loading,
          key: visible?.dataset.rowKey ?? '',
          offset: (visible?.getBoundingClientRect().top ?? viewport.top) - viewport.top,
        }
      },
      append: () =>
        setRows((held) => [
          ...held,
          ...Array.from({ length: 5 }, () => `live-${nextId.current++}`),
        ]),
      completePage() {
        setRows((held) => [
          ...Array.from({ length: 12 }, (_, index) => `older-${index}`),
          ...held,
          'concurrent-live',
        ])
        setOlder(false)
        setLoading(false)
      },
      growAbove: () => setFirstHeight((height) => height + 100),
      reflowAboveAndBelow() {
        setFirstHeight((height) => height + 50)
        setLastHeight((height) => height - 50)
      },
      shortPage() {
        setRows(['short-0', 'short-1'])
        setOlder(true)
        setLoading(false)
      },
      jump,
      search: () =>
        phone
          ? viewportRef.current?.scrollToIndex({ index: 20, animated: false })
          : scroll.scrollToBlock(20, { instant: true }),
    }
  })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      {phone ? (
        <TranscriptViewport
          ref={viewportRef}
          identity="scroll-fixture"
          data={rows}
          moreAbove={older}
          loadingOlder={loading}
          onLoadOlder={() => setLoading(true)}
          onFollowChange={setPhoneFollowing}
          keyExtractor={(key) => key}
          style={{ flex: 1, minHeight: 0 }}
          renderItem={({ item: key, index }) => (
            <div
              style={{
                height:
                  key === 'held-0' ? firstHeight : index === rows.length - 1 ? lastHeight : 72,
              }}
            >
              <p>{key} — a retained transcript message</p>
            </div>
          )}
          ListFooterComponent={<div style={{ height: 40 }}>Live output</div>}
        />
      ) : (
        <div
          data-feed-scroller
          ref={scroll.setScrollerRef}
          tabIndex={0}
          onScroll={scroll.onScroll}
          onPointerUp={scroll.onPointerUp}
          style={{
            flex: 1,
            minHeight: 0,
            overflowX: 'clip',
            overflowY: 'auto',
            overscrollBehaviorY: 'contain',
          }}
        >
          <div ref={scroll.setContentRef}>
            {loading && <div style={{ height: 24 }}>Loading history</div>}
            {rows.map((key, index) => (
              <div
                key={key}
                data-block={index}
                data-row-key={key}
                style={{
                  height:
                    key === 'held-0' ? firstHeight : index === rows.length - 1 ? lastHeight : 72,
                }}
              >
                <p>{key} — a retained transcript message</p>
              </div>
            ))}
            <div style={{ height: 40 }}>Live output</div>
          </div>
        </div>
      )}
      <button type="button" onClick={jump}>
        Jump to bottom
      </button>
    </div>
  )
}

document.body.style.margin = '0'
// Row geometry includes real margins, just as Markdown does in the product.
const style = document.createElement('style')
style.textContent = 'p { margin: 0; padding: 12px; }'
document.head.appendChild(style)
createRoot(document.getElementById('root')!).render(<Fixture />)
