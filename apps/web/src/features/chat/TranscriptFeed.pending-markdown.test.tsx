// @vitest-environment jsdom
import type { RenderableRow } from '@podium/client-core/values'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildChatRows, type PendingItem, pairToolResults } from './chat'
import { TranscriptFeed } from './TranscriptFeed'

const text =
  '> *Check the repair command.*\n> *your reply, 20:45*\n\nPlease check `apps/cli/src/cli.ts`.'
const openFile = vi.fn()
let host: HTMLDivElement
let root: Root

function pending(state: PendingItem['state'], body = text): PendingItem {
  return {
    id: 'pending-quote',
    deliveryId: 'delivery-quote',
    text: body,
    wire: body,
    at: 1,
    kind: 'message',
    state,
    retractable: false,
  }
}

function render(bubbles: PendingItem[], items: TranscriptItem[] = []): void {
  const blocks = pairToolResults(items)
  const rows = buildChatRows(blocks).map((row, index) => ({
    row,
    index,
    ...(row.kind === 'block' ? { blockIndex: row.blockIndex } : {}),
  })) as RenderableRow[]
  act(() => {
    root.render(
      <TranscriptFeed
        setScrollerRef={() => {}}
        setContentRef={() => {}}
        onScroll={() => {}}
        onPointerUp={() => {}}
        compact={false}
        superagent={false}
        phase="ready"
        rows={rows}
        blocks={blocks}
        markdownHtml={new Map()}
        search={{ activeRow: -1, filtering: false, matches: [], activeMatch: 0 } as never}
        moreAbove={false}
        loadingOlder={false}
        loadOlder={() => {}}
        sessionId={asSessionId('s1')}
        cwd="/repo"
        session={undefined}
        httpOrigin="http://localhost"
        openFile={openFile}
        onOpenImage={() => {}}
        onAnswerAsk={async () => {}}
        livePendingAskIndex={-1}
        pendingAskBlock={null}
        lastAnswerBlockIndex={-1}
        ctxSeq={null}
        collapseContext={false}
        stickyEnabled={false}
        isOperatorPromptRow={() => false}
        pending={bubbles}
        onRetractQueued={async () => {}}
        overlay={null}
        turnPreview={null}
        activity={null}
        attribution={{} as never}
      />,
    )
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  openFile.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

it.each([
  'sending',
  'queued',
  'accepted',
  'failed',
  'unknown',
] as const)('formats quoted text immediately while the message is %s', (state) => {
  render([pending(state)])
  const markdown = host.querySelector('.transcript-pending .chat-md')
  expect(markdown?.querySelector('blockquote em')?.textContent).toBe('Check the repair command.')
  expect(markdown?.querySelector(':scope > p')?.textContent).toBe(
    'Please check apps/cli/src/cli.ts.',
  )
  expect(markdown?.classList.contains('whitespace-pre-wrap')).toBe(false)
})

it('keeps the same Markdown when the pending quote becomes transcript history', () => {
  render([pending('queued')])
  const before = host.querySelector('.transcript-you-body .chat-md')?.innerHTML
  expect(host.querySelector('blockquote')).not.toBeNull()
  render([], [{ id: 'history-quote', role: 'user', text } as TranscriptItem])
  expect(host.querySelector('.transcript-pending')).toBeNull()
  expect(host.querySelector('.transcript-you-body .chat-md')?.innerHTML).toBe(before)
})

it('keeps pending quote text nodes through delivery status changes', () => {
  render([pending('sending')])
  const quote = host.querySelector('blockquote em')?.firstChild
  expect(quote).toBeDefined()
  render([pending('queued')])
  expect(host.querySelector('blockquote em')?.firstChild).toBe(quote)
  expect(host.querySelector('.transcript-delivery')?.textContent).toBe('pending')
})

it('routes file links in pending Markdown through the chat handler', () => {
  render([pending('sending')])
  const link = host.querySelector<HTMLAnchorElement>('.transcript-pending a.file-link')
  expect(link).not.toBeNull()
  act(() => link?.click())
  expect(openFile).toHaveBeenCalledWith(asSessionId('s1'), '/repo/apps/cli/src/cli.ts')
})

it('sanitizes pending Markdown before putting it in the DOM', () => {
  render([
    pending(
      'sending',
      '> Quoted text\n\n<img src="missing" onerror="alert(1)"><script>alert(2)</script>\n\n[unsafe](javascript:alert(3))',
    ),
  ])
  const markdown = host.querySelector('.transcript-pending .chat-md')
  expect(markdown?.querySelector('blockquote')?.textContent?.trim()).toBe('Quoted text')
  expect(markdown?.querySelector('script, [onerror], [href^="javascript:"]')).toBeNull()
})
