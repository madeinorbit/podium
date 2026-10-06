import { referenceState } from '../../../tests/worklist/diagnostics/reference-state'
/** Real provider/replica/outbox, synthetic rows, and actual composer/offer UI.
 * Reports counts only: this acceptance is not a timed benchmark. */
import type { ClientRuntime } from '@podium/client-core/engine'
import { DRAFTS_UI_KEY } from '@podium/client-core/engine'
import { readRuntimeStoreStats, storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'

import { allIssueViewModels } from '../../../tests/worklist/diagnostics/reference/issue-view-models'
import { noticeFixture } from '../../../tests/worklist/diagnostics/notice-fixture'
import { asSessionId, asUserId } from '@podium/model/browser'
import { Profiler, StrictMode, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { ChatComposer } from '../src/features/chat/ChatComposer'
import { checkChatContext } from './chat/chat-context-check'
import { OfferArtifactStrip } from '../src/features/chat/OfferArtifactStrip'
import {
  useChatArtifactIssue,
  useChatContextWindow,
  useChatDraft,
  useChatInteractions,
  useChatIssueSeq,
  useChatMachines,
  useChatMentions,
  useChatReferenceMachines,
  useChatReferenceSessions,
  useChatRepositoryKey,
  useChatSession,
  useChatSessionExitKind,
  useChatThreads,
} from '../src/features/chat/use-chat-context'
import { useConversation } from '../src/features/chat/use-conversation'
import { observer } from 'mobx-react-lite'
import { createHeaderFixture } from './header-fixture'
import '../src/index.css'
import '../src/styles.css'

const rows = Number(new URLSearchParams(location.search).get('rows') ?? 5600)
const omitArtifactStrip = new URLSearchParams(location.search).get('omitArtifactStrip') === '1'
const fixture = createHeaderFixture(rows)
const notice = noticeFixture(),
  id = asSessionId('synthetic-session-0')
for (const row of notice.messages)
  fixture.records.set(`messageRecord:${row.id}`, {
    entity: 'messageRecord',
    entityId: row.id,
    value: row,
    provenance: { seq: 1 },
  })
for (const row of [...notice.interactions].reverse())
  fixture.records.set(`pendingInteraction:${row.id}`, {
    entity: 'pendingInteraction',
    entityId: row.id,
    value: row,
    provenance: { seq: 1 },
  })
const record = fixture.records.get('issueProjection:synthetic-0')!
fixture.records.set('issueProjection:synthetic-0', {
  ...record,
  value: {
    ...(record.value as object),
    panel: {
      artifacts: [
        {
          path: 'concept.html',
          title: 'Synthetic concept',
          artifactId: 'opaque-artifact',
          entry: 'concept.html',
          addedAt: '2026-10-01T12:00:00Z',
        },
      ],
    },
  },
})
for (let index = rows - Math.min(rows, 100); index < rows; index++) {
  const cold = fixture.records.get(`session:synthetic-session-${index}`)!
  fixture.records.set(`session:synthetic-session-${index}`, {
    ...cold,
    value: {
      ...(cold.value as object),
      status: 'exited',
      stoppedAt: '2020-01-01T00:00:00Z',
      archived: true,
      lastActiveAt: '2020-01-01T00:00:00Z',
    },
  })
}
Object.assign(fixture.api, { messages: { records: { query: async () => ({ records: [] }) } } })
let owner: ClientRuntime | undefined
let graph: ReturnType<typeof useWorklistPool> = null
let ready = false,
  commits = 0,
  sawUnattached = false
const failures: string[] = []
const attachments = {
  attachments: [],
  dragOver: false,
  openFilePicker() {},
  processFiles: async () => {},
  remove() {},
  clear() {},
  clearReady() {},
  uploading: false,
  ready: () => ({ paths: [], legacyPaths: [], refs: [], tags: [], draftArtifacts: [] }),
  dropHandlers: {},
  onPaste() {},
  onFileInputChange() {},
}
const noop = () => {}

storeStats.enable()
document.documentElement.classList.add('dark')
document.documentElement.dataset.theme = 'podium'
const Surface = observer(function Surface() {
  const runtime = useStoreHandle() as ClientRuntime,
    pool = useWorklistPool()
  const session = useChatSession(id),
    machines = useChatMachines(),
    mentions = useChatMentions('task')
  const exit = useChatSessionExitKind(id)
  const draft = useChatDraft(id),
    asks = useChatInteractions(id),
    window = useChatContextWindow(),
    seq = useChatIssueSeq()
  const threads = useChatThreads(),
    sessions = useChatReferenceSessions(),
    refs = useChatReferenceMachines(),
    repos = useChatRepositoryKey()
  const artifact = useChatArtifactIssue({ sessionId: id, issueId: 'synthetic-0' as never })
  const actions = runtime.access
  const conversation = useConversation(id)
  const held = pool?.row('chatHeld', id)
  const reader = pool?.row('chatContextReader', 'reader')
  const taRef = useRef<HTMLTextAreaElement>(null),
    fileInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    owner = runtime
    graph = pool
    if (!pool) sawUnattached = true
    ready = !!session && !!conversation?.ready && draft !== '' && !!pool
  }, [runtime, pool, session, conversation?.ready, draft])
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-8">
      <h1 className="text-xl">Conversation context</h1>
      <p>One runtime and mutation owner. Saved draft, questions, mentions and review artifacts.</p>
      <output data-testid="context">
        {JSON.stringify({
          title: session?.title,
          exit,
          machines: machines.length,
          mentions,
          question: asks.question?.id,
          blocked: asks.blocked,
          attached: window.attachedSessionId,
          seq: seq('synthetic-0'),
          threads: threads.length,
          sessions: sessions.map((row) => row.sessionId),
          refs: refs.length,
          repos,
          artifact: artifact?.id,
          ready: conversation?.ready,
          conversationReady: conversation?.ready,
          conversationDraft: conversation?.draft ?? '',
          held: held && typeof held !== 'symbol' ? held.sends.map(row => row.mutationId) : [],
          records: reader && typeof reader !== 'symbol' ? reader.records(id).records.map(row => row.id) : [],
        })}
      </output>
      <ChatComposer
        taRef={taRef}
        draft={draft}
        onDraftChange={(text) => runtime.drafts.set(id, text)}
        deliverable={conversation?.ready ?? false}
        placeholder="Synthetic prompt"
        compact={false}
        isMobile={false}
        onSend={noop}
        voice={{ supported: false, listening: false, toggle: noop } as never}
        attachments={{ ...attachments, fileInputRef } as never}
        turnRunning={false}
        canInterrupt={false}
        onInterrupt={noop}
        interruptError={null}
        offer={null}
        onOfferAction={async () => {}}
        onOfferDismiss={async () => {}}
        session={session}
        turnError={null}
        transcriptFreshness="saved"
        offlineAsOf={null}
        autoFocusKey={id}
        transcriptSettled
      />
      {!omitArtifactStrip && session && (
        <OfferArtifactStrip
          session={session}
          offer={
            {
              message: 'Synthetic concept ready',
              at: '2026-10-01T12:00:01Z',
              artifacts: ['concept.html'],
              actions: [],
            } as never
          }
        />
      )}
    </main>
  )
})
const root = createRoot(document.getElementById('root')!)
root.render(
  <StrictMode>
    <StoreProvider
      principal={asClientPrincipal(asUserId('operator'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={fixture.api}
      createReplicaFn={() => {
        const replica = fixture.newReplica()
        // The real runtime hydrates this device ledger in its constructor, before
        // either controller mounts. Attachment is intentionally a later boundary.
        replica
          .uiState()
          .set(
            DRAFTS_UI_KEY,
            JSON.stringify({ [id]: { text: 'Saved synthetic draft', serverRev: 0, editedAt: 1 } }),
          )
        return replica
      }}
      networkEnabled={false}
      onFatalError={(error) => failures.push(error)}
      attachRuntime={(runtime) => {
        fixture.bindHub(runtime.hub)
        fixture.publishMachines()
        return attachWorklistPool(runtime, (error) => failures.push(error.message))
      }}
    >
      <Profiler
        id="conversation"
        onRender={() => {
          commits++
        }}
      >
        <Surface />
      </Profiler>
    </StoreProvider>
  </StrictMode>,
)
const driver = {
  ready: () => ready,
  failures: () => [...failures],
  sawUnattached: () => sawUnattached,
  reset: () => {
    storeStats.reset()
    commits = 0
  },
  stats: () => ({
    commits,
    slices: readRuntimeStoreStats(owner!)?.slices ?? {},
    selectorRuns: readRuntimeStoreStats(owner!)?.selectorRuns ?? 0,
    rowBuilds: readRuntimeStoreStats(owner!)?.rowBuilds ?? 0,
    publishes: readRuntimeStoreStats(owner!)?.publishes ?? 0,
  }),
  update(step: number) {
    fixture.patch('messageRecord', 'notice-message-0', { body: `Synthetic update ${step}` })
    fixture.patch('session', 'synthetic-session-0', { title: `Synthetic agent ${step}` })
    referenceState(owner!).setSessionDraft(id, `Saved synthetic draft ${step}`)
  },
  check() {
    if (!owner || !graph) return null
    return checkChatContext(graph, { ...referenceState(owner), drafts: Object.fromEntries(owner.drafts.values) }, allIssueViewModels(owner.replica), [
      id,
      asSessionId('synthetic-session-1'),
    ])
  },
  close: () => root.unmount(),
}
Object.assign(window, { __chatContextFixture: driver })
declare global {
  interface Window {
    __chatContextFixture: typeof driver
  }
}
