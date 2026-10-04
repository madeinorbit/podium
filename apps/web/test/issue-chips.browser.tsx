import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
/** The full ChatView and chip components over a private runtime.
 * Operator-sized synthetic data, no network or operator cache. */
import type { ClientRuntime } from '@podium/client-core/engine'
import { chipPerf } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'

import { allIssueViewModels } from '@podium/client-graph/diagnostics/reference/issue-view-models'
import { asIssueId, asSessionId, asUserId, type TranscriptItem } from '@podium/model/browser'
import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { LiveIssueReference } from '../src/components/IssueReference'
import { RefMiniviewHost } from '../src/components/RefMiniview'
import { ChatView } from '../src/features/chat/ChatView'
import { IssueChipLiveness } from '../src/features/chat/IssueChipLiveness'
import { setKnownRefPrefixes } from '../src/lib/markdown-references'
import { createSidebarFixture } from './sidebar-fixture'
import '../src/index.css'
import '../src/styles.css'
chipPerf.enable()
setKnownRefPrefixes(new Set(['SYN']))
document.documentElement.classList.add('dark')
document.documentElement.dataset.theme = 'podium'
const count = Number(new URLSearchParams(location.search).get('issues') ?? 4887)
const synthetic = createSidebarFixture(count, Date.now(), true)
// The current miniview's legacy resolver reads the wire prefix. Real rows
// carry it; the sidebar fixture needs it added for a chip/card comparison.
for (let i = 0; i < count; i++) synthetic.patch('issue', `synthetic-${i}`, { prefix: 'SYN' })
for (let i = 674; i < count; i++) synthetic.records.delete(`session:synthetic-session-${i}`)
// Test authority resolves requested keys by their synthetic identity, without
// scanning rows. The production resolver is separately checked for permissions.
synthetic.api.issues = {
  ...synthetic.api.issues,
  resolveRefs: {
    query: async ({ refs }) =>
      refs.map((ref) => {
        const i = Number(ref.split('-').at(-1)) - 1000
        return { ref, id: i >= 0 && i < count ? asIssueId(`synthetic-${i}`) : null }
      }),
  },
}
Object.assign(synthetic.api.issues, { comments: { query: async () => [] } })
const sessionId = asSessionId('synthetic-session-0')
let items = Array.from(
  { length: 120 },
  (_, i): TranscriptItem => ({
    id: `message-${i}`,
    cursor: `cursor-${i}`,
    role: i % 2 ? 'assistant' : 'user',
    text: `Conversation message ${i}. Review SYN-${1000 + (i % 40)}, SYN-${1000 + ((i + 1) % 40)}, and SYN-${1000 + ((i + 2) % 40)}.`,
  }),
)
synthetic.api.sessions = Object.assign(
  { ...synthetic.api.sessions },
  {
    transcriptRead: {
      query: async () => ({ items, head: 'cursor-0', tail: 'cursor-119', hasMore: false }),
    },
  },
)
let runtime: ClientRuntime | undefined
let pool: ReturnType<typeof useWorklistPool> = null
let open: ((value: boolean) => void) | undefined
const failures: string[] = []
const transcriptListeners = new Set<Parameters<ClientRuntime['hub']['subscribeTranscript']>[2]>()

function Fixture() {
  const owner = useStoreHandle() as ClientRuntime
  const attached = useWorklistPool()
  const [shown, setShown] = useState(false)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    runtime = owner
    pool = attached
    open = setShown
    void referenceState(owner)
      .refreshRepos()
      .catch((error) => failures.push(String(error)))
    return () => {
      runtime = undefined
      pool = null
      open = undefined
    }
  }, [attached, owner])
  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <RefMiniviewHost />
      <div ref={setRoot}>
        <IssueChipLiveness root={root} />
        <div className="p-3" data-surface="issue-page">
          <LiveIssueReference token="SYN-1000" />
        </div>
        <div className="p-3" data-surface="miniview">
          <LiveIssueReference token="SYN-1001" showTitle={false} />
        </div>
        <div className="chat-md p-3" data-surface="mail">
          <a href="#SYN-1000" className="ref-link ref-link--issue" data-ref="SYN-1000">
            SYN-1000
          </a>
        </div>
      </div>
      {shown && <ChatView sessionId={sessionId} />}
    </main>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(
  <StoreProvider
    principal={asClientPrincipal(asUserId('chip-proof'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={synthetic.api}
    createReplicaFn={() => synthetic.replica}
    networkEnabled={false}
    onFatalError={(message) => failures.push(message)}
    attachRuntime={(owner) => {
      // Feed synthetic deltas through the real transcript controller and
      // compute worker without connecting this fixture to a server.
      owner.hub.subscribeTranscript = (id, _since, listener) => {
        if (id !== sessionId) throw new Error('Unexpected fixture transcript')
        transcriptListeners.add(listener)
        return () => {
          transcriptListeners.delete(listener)
        }
      }
      return attachWorklistPool(owner, (error) => failures.push(error.message))
    }}
  >
    <Fixture />
  </StoreProvider>,
)

const proof = {
  ready: () => !!runtime && referenceState(runtime).repos.length > 0 && pool !== null,
  status: () => ({
    runtime: !!runtime,
    pool: !!pool,
    repos: runtime?.getSnapshot().repos.length,
    issues: runtime?.replica.rows('issueProjections').length,
    sessions: runtime?.replica.rows('sessions').length,
  }),
  failures: () => failures,
  open(value = true) {
    flushSync(() => open?.(value))
  },
  stats() {
    if (!runtime) throw new Error('Runtime absent')
    return chipPerf.read(runtime)
  },
  patch(index: number, patch: Record<string, unknown>) {
    synthetic.patch('issueProjection', `synthetic-${index}`, patch)
  },
  traffic() {
    synthetic.patch('session', 'synthetic-session-673', {
      agentState: { phase: 'working', since: new Date().toISOString() },
    })
  },
  streamTail(text: string, append = false) {
    if (transcriptListeners.size === 0) throw new Error('Transcript subscription absent')
    const previous = items.at(-1)!
    const next: TranscriptItem = append
      ? { id: `message-${items.length}`, cursor: `cursor-${items.length}`, role: 'assistant', text }
      : { ...previous, text }
    items = append ? [...items, next] : [...items.slice(0, -1), next]
    for (const listener of transcriptListeners) listener([next], { reset: false })
    return next.id
  },
  async check() {
    if (!runtime || !pool) throw new Error('Pool absent')
    const { checkIssueChips } = await import('@podium/client-graph/diagnostics/chip-check')
    const state = referenceState(runtime)
    const legacy = allIssueViewModels(
      runtime.replica,
      state.issueProjections,
      state.issueUserStates,
    )
    return checkIssueChips(
      pool.references,
      legacy,
      [...document.querySelectorAll('a.ref-link--issue[data-ref], [data-issue-reference]')].map(
        (a) => a.getAttribute('data-ref') ?? a.getAttribute('data-issue-reference')!,
      ),
    )
  },
}
Object.assign(window, { __issueChips: proof })
declare global {
  interface Window {
    __issueChips: typeof proof
  }
}
