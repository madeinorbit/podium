// @vitest-environment happy-dom
import { DraftStore } from '@podium/client-core/conversation'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { observable, runInAction } from 'mobx'
import { observer } from 'mobx-react-lite'
import { createRef, useMemo } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@/test-support/model-catalog-mock'
import { ChatComposer } from './ChatComposer'
import { ConversationPresentation } from './conversation-presentation'
import { TranscriptFeed } from './conversation-render-fixture'
import { WebConversation } from './conversation-render-fixture'
import type { ChatSurface } from './use-chat-layout'

const counts = vi.hoisted(() => ({ frames: 0, composer: 0, preview: 0, rows: new Map<string, number>() }))
vi.mock('./use-feed-arrivals', async importOriginal => ({
  ...await importOriginal<typeof import('./use-feed-arrivals')>(),
  useFeedArrivals: () => { counts.frames++; return new Set<string>() },
}))
vi.mock('./ChatBlockView', () => ({ ChatBlockView: ({ block }: { block: { item: TranscriptItem } }) => {
  counts.rows.set(block.item.id, (counts.rows.get(block.item.id) ?? 0) + 1)
  return <div data-block>{block.item.text}</div>
} }))
vi.mock('./TranscriptTail', () => ({ TranscriptTail: () => null, trailingRunIsLive: () => false }))
vi.mock('@/lib/markdown', () => ({
  renderMarkdown: (text: string) => { counts.preview++; return text },
  sanitizeRenderedMarkdown: (text: string) => text,
}))
vi.mock('./use-chat-context', () => ({ useChatMentions: () => [] }))
vi.mock('@/lib/at-mention/useFileMentions', () => ({ useFileMentions: () => [] }))

const id = asSessionId('render-chat')
const items: TranscriptItem[] = Array.from({ length: 20 }, (_, index) => ({
  id: `m${index}`, role: 'assistant', answer: true, text: `reply ${index}`,
}))
const owners: { conversation: WebConversation; drafts: DraftStore }[] = []
// Row-render counts use the synchronous fallback; worker publication has its own guard.
beforeEach(() => vi.stubGlobal('Worker', undefined))
afterEach(() => {
  cleanup()
  for (const owner of owners.splice(0)) { owner.conversation.dispose(); owner.drafts.dispose() }
  vi.unstubAllGlobals()
})
function resetCounts() { counts.frames = counts.composer = counts.preview = 0; counts.rows.clear() }

function fixture() {
  const drafts = new DraftStore({ storage: { get: () => null, set: () => {} },
    hub: { on: () => () => {}, sendDraftEdit: () => {}, connectionHealth: () => ({ status: 'ok' }) } as never })
  const presentation = new ConversationPresentation()
  const conversation = new WebConversation({
    sessionId: id, drafts,
    transcript: { cache: { read: () => ({ items, savedAt: 1 }), write: () => {} },
      source: { read: async () => ({ items, hasMore: false }), subscribe: () => () => {} } },
    sends: { createDeliveryId: () => 'test-send', deliver: async () => ({ state: 'sent' }) },
    onTranscriptChange: change => presentation.changed(change),
  }, { sources: { view: () => ({ session: () => undefined }) } } as never, { drafts } as never, {}, presentation)
  owners.push({ conversation, drafts })
  const chat = {
    conversation,
    headless: false,
    get pending() { return conversation.sends.bubbles },
    get activity() { return null },
  } as unknown as ChatSurface
  const Frame = observer(function Frame() {
    // The list observes order and the worker's structural index, never item values.
    conversation.transcript.ids.length
    const rows = presentation.rows
    const rendered = useMemo(() => rows.map((row, index) => ({ row, index })), [rows])
    return <TranscriptFeed chat={chat} rows={rendered} blocks={presentation.blocks}
      setScrollerRef={() => {}} setContentRef={() => {}} onScroll={() => {}} onPointerUp={() => {}}
      compact={false} superagent={false} phase="ready" markdownHtml={presentation.markdownHtml}
      search={presentation.search} moreAbove={false} loadingOlder={false} loadOlder={() => {}}
      sessionId={id} cwd="/repo" session={undefined} httpOrigin="http://synthetic.invalid"
      openFile={() => {}} onOpenImage={() => {}} onAnswerAsk={async () => {}}
      livePendingAskIndex={-1} pendingAskBlock={null} lastAnswerBlockIndex={-1}
      collapseContext={false} stickyEnabled={false} isOperatorPromptRow={() => false}
      onRetractQueued={async () => {}} attribution={{} as never} />
  })
  const Composer = observer(function Composer() {
    counts.composer++
    return <ChatComposer taRef={createRef()} draft={conversation.draft}
      onDraftChange={text => { conversation.draft = text }} deliverable placeholder="Message agent"
      compact={false} isMobile={false} onSend={() => {}}
      voice={{ supported: false, listening: false, toggle: () => {} } as never}
      attachments={{ attachments: [], uploading: false, fileInputRef: createRef(), dropHandlers: {}, openFilePicker: () => {}, remove: () => {}, onPaste: () => {}, onFileInputChange: () => {} } as never}
      turnRunning={false} canInterrupt={false} onInterrupt={() => {}} offer={null}
      onOfferAction={async () => {}} onOfferDismiss={async () => {}} session={undefined}
      turnError={null} transcriptFreshness={null} offlineAsOf={null} autoFocusKey={id} transcriptSettled />
  })
  return { conversation, presentation, Frame, Composer }
}

it('typing 60 keys renders the composer and zero message rows or list frames', () => {
  const { conversation, Frame, Composer } = fixture()
  const mounted = render(<><Frame /><Composer /></>)
  resetCounts()
  const field = mounted.container.querySelector('textarea')!
  for (let index = 1; index <= 60; index++) fireEvent.input(field, { target: { value: 'x'.repeat(index) } })
  expect(conversation.draft).toBe('x'.repeat(60))
  expect(counts.composer).toBe(60)
  expect(counts.frames).toBe(0)
  expect([...counts.rows]).toEqual([])
})

it('a streamed revision renders exactly its own row and zero list frames', () => {
  const { conversation, Frame } = fixture()
  const mounted = render(<Frame />)
  resetCounts()
  act(() => conversation.transcript.merge([{ ...items.at(-1)!, text: 'streamed reply' }]))
  expect(mounted.container.textContent).toContain('streamed reply')
  expect([...counts.rows]).toEqual([['m19', 1]])
  expect(counts.frames).toBe(0)
})

it('a preview revision renders only the preview block', () => {
  const { conversation, Frame, Composer } = fixture()
  const mounted = render(<><Frame /><Composer /></>)
  act(() => runInAction(() => { conversation.preview = { turnEpoch: 1, items: [{ kind: 'text', itemId: 'preview', text: 'first' }] } }))
  resetCounts()
  act(() => runInAction(() => { conversation.preview = { turnEpoch: 1, items: [{ kind: 'text', itemId: 'preview', text: 'second' }] } }))
  expect(mounted.container.querySelector('[data-turn-preview]')?.textContent).toContain('second')
  expect(counts.preview).toBe(1)
  expect(counts.composer).toBe(0)
  expect(counts.frames).toBe(0)
  expect([...counts.rows]).toEqual([])
})

it('quota and status changes outside this conversation render no chat component', () => {
  const elsewhere = observable({ quota: 1, status: 'live' })
  const { Frame, Composer } = fixture()
  render(<><Frame /><Composer /></>)
  resetCounts()
  act(() => runInAction(() => { elsewhere.quota = 2; elsewhere.status = 'exited' }))
  expect(counts).toMatchObject({ composer: 0, frames: 0, preview: 0 })
  expect([...counts.rows]).toEqual([])
})
