/** Shipping composer and note UI, with offline ports recording destination/body. */
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import type { ParsedEnvelope } from '@podium/client-core/values'
import { MobxPool } from '@podium/client-graph'
import { asSessionId, asThreadId, asUserId } from '@podium/model/browser'
import { observable } from 'mobx'
import { useMemo, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { attachWorklistPool } from '@/app/store-worklist-pool'
import { ScopedChatComposer } from '@/features/chat/ChatView'
import { ChatViewModel } from '@/features/chat/chat-view-model'
import { MessageEnvelopeGroup } from '@/features/chat/MessageEnvelopeGroup'
import type { ChatSurface } from '@/features/chat/use-chat-layout'
import type { QuoteInput } from '@/lib/quote/quote-sinks'
import { createSidebarFixture } from '../test/sidebar-fixture'
import '@/index.css'
import '@/styles.css'
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', params.get('theme') !== 'light')
const id = asSessionId('mail-reply-harness')
const envelope: ParsedEnvelope = {
  id: 'msg_ask',
  from: 'issue:POD-2242',
  to: 'the operator',
  question: true,
  expectsReply: false,
  body: 'whether inbox reads keep their own row\nWhich treatment do you prefer?',
}
const wire = {
  ...envelope,
  threadId: asThreadId('thread'),
  inReplyTo: null,
  kind: 'question',
  urgency: 'next-turn',
  lifecycle: 'wait',
  createdAt: '2026-10-31T17:14:00Z',
  deliveryStatus: 'confirmed',
  ackedBy: null,
  deliveredAt: null,
  deliveredTo: null,
  expiresAt: null,
  clampedFrom: null,
  hop: 0,
}
const noop = () => {}
function Harness() {
  const taRef = useRef<HTMLTextAreaElement>(null),
    surfaceRef = useRef<HTMLDivElement>(null)
  const quoteDraftRef = useRef<((input: QuoteInput) => void) | null>(null)
  const state = useMemo(() => {
    const pool = new MobxPool({ coarseNow: 0, selectedIssueId: null })
    const drafts = observable.map([[id, 'Continue reviewing the branch.']])
    pool.bindSessionDrafts({
      get: (key) => drafts.get(key) ?? '',
      set: (key, text) => {
        drafts.set(key, text)
      },
    })
    const mail: { id: string; body: string }[] = [],
      prompts: string[] = []
    let failNext = false
    const trpc = {
      messages: {
        show: { query: async () => wire },
        reply: {
          mutate: async (input: { id: string; body: string }) => {
            await new Promise((done) => setTimeout(done, 80))
            if (failNext) {
              failNext = false
              throw new Error('Connection interrupted. Try again.')
            }
            mail.push(input)
            return { id: 'msg_reply', ok: true, acked: true, to: envelope.from }
          },
        },
      },
    }
    const conversation = {
      pool,
      sessionId: id,
      runtime: { access: { trpc, replica: { row: () => undefined } } },
      transcript: { freshness: null, offlineAsOf: null },
      sends: { canInterrupt: false, interruptError: null, offer: null },
      turnError: null,
      visibleFailure: null,
    }
    const view = new ChatViewModel(conversation as never, params.has('compact'), undefined, noop)
    // The transcript, presence and delivery ports are stubbed; draft ownership,
    // the reply action, quote staging and submit routing are the shipping code.
    Object.defineProperties(view, {
      composer: { value: { deliverable: true, placeholder: 'Message the agent…' } },
      phase: { value: 'ready' },
    })
    const attachments = {
      attachments: [],
      dragOver: false,
      fileInputRef: { current: null },
      openFilePicker: noop,
      processFiles: async () => {},
      remove: noop,
      clear: noop,
      clearReady: noop,
      uploading: false,
      ready: () => ({ paths: [], legacyPaths: [], refs: [], tags: [], draftArtifacts: [] }),
      dropHandlers: {},
      onPaste: noop,
      onFileInputChange: noop,
    }
    const chat = {
      view,
      taRef,
      attachments,
      setDraft: view.setDraft,
      submitDraft: (draft: string) => {
        prompts.push(draft)
        view.setDraft('')
      },
      interrupt: noop,
      isMobile: false,
      sendOfferPrompt: async () => {},
      dismissOffer: async () => {},
    } as unknown as ChatSurface
    Object.assign(window, {
      mailReplyHarness: {
        read: () => ({
          mail,
          prompts,
          normalDraft: drafts.get(id),
          replyDraft: view.reply.draft,
          error: view.reply.error,
          active: view.reply.active,
        }),
        failNext: () => {
          failNext = true
        },
      },
    })
    return { view, chat }
  }, [])
  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--background)',
        padding: 24,
        display: 'grid',
        justifyItems: 'center',
        alignContent: 'start',
        gap: 18,
      }}
    >
      <button
        type="button"
        onClick={() =>
          quoteDraftRef.current?.({ text: 'Review the footer spacing.', source: 'the review' })
        }
      >
        Quote review into composer
      </button>
      <div
        ref={surfaceRef}
        data-reply-pane
        className={params.has('compact') ? 'chat-compact' : undefined}
        style={{
          width: Number(params.get('width') ?? 720),
          maxWidth: '100%',
          height: 520,
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid var(--border-strong)',
          borderRadius: 10,
          background: 'var(--chat-face)',
        }}
      >
        <div
          style={{
            flex: 1,
            padding: 24,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'end',
          }}
        >
          <MessageEnvelopeGroup
            envelopes={[envelope]}
            onBodyClick={noop}
            mailReply={state.view.reply}
            onQuote={(input) => quoteDraftRef.current?.(input)}
          />
        </div>
        <ScopedChatComposer
          sessionId={id}
          superThread={undefined}
          compact={params.has('compact')}
          chat={state.chat}
          quoteDraftRef={quoteDraftRef}
          surfaceRef={surfaceRef}
          issueClosed={false}
          active
        />
      </div>
    </main>
  )
}
const fixture = createSidebarFixture(0, 0, true)
createRoot(document.getElementById('root')!).render(
  <StoreProvider
    principal={asClientPrincipal(asUserId('operator'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={fixture.api}
    createReplicaFn={() => fixture.replica}
    networkEnabled={false}
    onFatalError={(message) => {
      throw new Error(message)
    }}
    attachRuntime={(owner) =>
      attachWorklistPool(owner, (error) => {
        throw error
      })
    }
  >
    <Harness />
  </StoreProvider>,
)
