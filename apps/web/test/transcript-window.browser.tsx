/** Production transcript fixture: real rows/scroll controller, synthetic history. */
import { useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ChatRow } from '@podium/client-core/values'
import { asSessionId, type TranscriptItem } from '@podium/model/browser'
import { buildChatRows, pairToolResults } from '../src/features/chat/chat'
import { TranscriptFeed } from '../src/features/chat/TranscriptFeed'
import { useTranscriptScroll } from '../src/features/chat/use-transcript-scroll'
import '../src/index.css'
import '../src/styles.css'

const TOTAL = 8058
const markdownHtml = new Map<string, string>()
const attribution = {} as never
const noOp = () => {}
const noOpAsync = async () => {}
const isOperatorPromptRow = (row: ChatRow) => row.kind === 'block' && row.block.item.role === 'user'
const corpus: TranscriptItem[] = Array.from({ length: TOTAL }, (_, index) => ({
  id: `message-${index}`, role: index % 4 === 0 ? 'user' : 'assistant', answer: index % 4 === 3,
  text: `Message ${index} — native-needle-${index}.\n\n**A measured transcript** with \`inline code\` and [a link](https://example.invalid/).\n\n- First point\n- Second point\n\nThe viewport retains the same line lengths and message spacing.`,
  ts: new Date(1_700_000_000_000 + index * 60_000).toISOString(),
}))
function Fixture() {
  const [count, setCount] = useState(200)
  const [revision, setRevision] = useState(0)
  const blocks = useMemo(() => pairToolResults(corpus.slice(TOTAL - count)), [count, revision])
  const rows = useMemo(() => buildChatRows(blocks).map((row, index) => ({ row, index,
    ...(row.kind === 'block' ? { blockIndex: row.blockIndex } : {}) })), [blocks])
  const scroller = useRef<HTMLDivElement | null>(null)
  const scroll = useTranscriptScroll({ sessionId: asSessionId('window-proof'), scrollerRef: scroller,
    active: true, blockCount: blocks.length, renderStart: 0, moreAbove: count < TOTAL, loadingOlder: false,
    loadOlder: () => setCount(value => Math.min(TOTAL, value + 400)), rowsToRender: rows, stickyEnabled: true,
    lookupAnchorRow: key => rows.findIndex(({ row }) => row.kind === 'block' && row.block.item.id === key),
  })
  Object.assign(window, { __transcriptWindowProof: {
    page: scroll.loadOlder, jump: (index: number) => scroll.scrollToBlock(index, { instant: true }),
    bottom: scroll.jumpToBottom,
    grow() { corpus[TOTAL - count]!.text += '\n\n' + 'An additional line.\n'.repeat(40); setRevision(value => value + 1) },
    stats() {
      const el = scroller.current!, box = el.getBoundingClientRect()
      const nodes = [...el.querySelectorAll<HTMLElement>('[data-block]')].filter(row => !row.hasAttribute('data-transcript-placeholder'))
      const visible = nodes.filter(row => { const r = row.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom })
      return { loaded: count, elements: document.querySelectorAll('*').length, drawn: nodes.length,
        top: el.scrollTop, height: el.scrollHeight, gap: el.scrollHeight - el.scrollTop - el.clientHeight,
        key: visible[0]?.dataset.rowKey, offset: visible[0] ? visible[0].getBoundingClientRect().top - box.top : null,
        text: visible.map(row => row.textContent), following: scroll.atBottom }
    },
  } })
  return <main className="chat-theme" style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
    <TranscriptFeed setScrollerRef={scroll.setScrollerRef} setContentRef={scroll.setContentRef}
      onScroll={scroll.onScroll} onPointerUp={scroll.onPointerUp} compact={false} superagent={false}
      phase="ready" rows={rows} blocks={blocks} markdownHtml={markdownHtml}
      search={{ matches: [], activeMatch: undefined, activeRow: undefined, position: 0, total: 0, filtering: false }}
      moreAbove={count < TOTAL} loadingOlder={false} loadOlder={scroll.loadOlder}
      sessionId={asSessionId('window-proof')} cwd="/synthetic" session={undefined} httpOrigin="http://offline.invalid"
      openFile={noOp} onOpenImage={noOp} onAnswerAsk={noOpAsync}
      livePendingAskIndex={-1} pendingAskBlock={null} lastAnswerBlockIndex={-1}
      collapseContext={false} stickyEnabled={true} isOperatorPromptRow={isOperatorPromptRow}
      onRetractQueued={noOpAsync} attribution={attribution} />
  </main>
}
document.documentElement.classList.add('dark')
document.body.style.margin = '0'
createRoot(document.getElementById('root')!).render(<Fixture />)
