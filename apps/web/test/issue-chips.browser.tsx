/** The actual transcript renderer and chip components over a private runtime.
 * Operator-sized synthetic data, no network or operator cache. */
import type { ClientRuntime } from '@podium/client-core/engine'
import { chipPerf } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { allIssueViewModels } from '@podium/client-core/replica'
import { computeTranscript, transcriptAttributionTable } from '@podium/client-core/viewmodels'
import { asIssueId, asSessionId, asUserId, type TranscriptItem } from '@podium/model/browser'
import { useCallback, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { LiveIssueReference } from '../src/components/IssueReference'
import { IssueChipLiveness } from '../src/features/chat/IssueChipLiveness'
import { TranscriptFeed } from '../src/features/chat/TranscriptFeed'
import { chipsDataLayer, initializeChipsDataLayer } from '../src/lib/chips-data-layer'
import { setKnownRefPrefixes } from '../src/lib/markdown-references'
import { createSidebarFixture } from './sidebar-fixture'
import '../src/index.css'
import '../src/styles.css'

initializeChipsDataLayer({ get: () => null })
chipPerf.enable()
setKnownRefPrefixes(new Set(['SYN']))
document.documentElement.classList.add('dark')
document.documentElement.dataset.theme = 'podium'
const count = Number(new URLSearchParams(location.search).get('issues') ?? 4887)
const synthetic = createSidebarFixture(count, Date.now(), true)
for (let i = 674; i < count; i++) synthetic.records.delete(`session:synthetic-session-${i}`)
// Test authority resolves requested keys by their synthetic identity, without
// scanning rows. The production resolver is separately checked for permissions.
synthetic.api.issues = { ...synthetic.api.issues, resolveRefs: { query: async ({ refs }) => refs.map(ref => {
  const i = Number(ref.split('-').at(-1)) - 1000
  return { ref, id: i >= 0 && i < count ? asIssueId(`synthetic-${i}`) : null }
}) } }
const sessionId = asSessionId('synthetic-session-0')
const items = Array.from({ length: 120 }, (_, i): TranscriptItem => ({
  id: `message-${i}`, role: i % 2 ? 'assistant' : 'user', text: `Conversation message ${i}. Review SYN-${1000 + i % 40}, SYN-${1000 + (i + 1) % 40}, and SYN-${1000 + (i + 2) % 40}.`,
}))
const transcript = computeTranscript({ items, verbosity: 'normal', query: '', cursor: 0 })
const attribution = transcriptAttributionTable(undefined)
let runtime: ClientRuntime | undefined
let pool: ReturnType<typeof useWorklistPool> = null
let ready = false
let open: ((value: boolean) => void) | undefined
const failures: string[] = []

function Fixture() {
  const owner = useStoreHandle() as ClientRuntime
  const attached = useWorklistPool()
  const [shown, setShown] = useState(false)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const noop = useCallback(() => {}, [])
  useEffect(() => {
    runtime = owner; pool = attached; open = setShown
    void owner.getSnapshot().refreshRepos().then(() => { ready = chipsDataLayer() === 'legacy' || attached !== null })
    return () => { ready = false; runtime = undefined; pool = null; open = undefined }
  }, [attached, owner])
  return <main ref={setRoot} className="flex h-screen flex-col bg-background text-foreground">
    {shown && <>
      <IssueChipLiveness root={root} />
      <div className="p-3" data-surface="issue-page"><LiveIssueReference token="SYN-1000" /></div>
      <div className="p-3" data-surface="miniview"><LiveIssueReference token="SYN-1001" showTitle={false} /></div>
      <div className="chat-md p-3" data-surface="mail"><a className="ref-link ref-link--issue" data-ref="SYN-1000">SYN-1000</a></div>
      <TranscriptFeed setScrollerRef={noop} setContentRef={noop} onScroll={noop} onPointerUp={noop}
        compact={false} superagent={false} phase="ready"
        rows={transcript.rows.map((row, index) => ({ row, index }))} blocks={transcript.blocks}
        markdownHtml={new Map()} search={transcript.search} moreAbove={false} loadingOlder={false} loadOlder={noop}
        sessionId={sessionId} cwd="/synthetic/project" session={undefined} httpOrigin="http://offline.invalid"
        openFile={noop} onOpenImage={noop} onAnswerAsk={async () => {}} livePendingAskIndex={-1} pendingAskBlock={null}
        lastAnswerBlockIndex={-1} ctxSeq={null} collapseContext={false} stickyEnabled={false} isOperatorPromptRow={() => false}
        pending={[]} onRetractQueued={async () => {}} overlay={null} turnPreview={null} activity={null} attribution={attribution} />
    </>}
  </main>
}

const root = createRoot(document.getElementById('root')!)
root.render(<StoreProvider principal={asClientPrincipal(asUserId('chip-proof'))}
  config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }} api={synthetic.api}
  createReplicaFn={() => synthetic.newReplica()} networkEnabled={false} onFatalError={message => failures.push(message)}
  attachRuntime={owner => attachWorklistPool(owner, error => failures.push(error.message))}><Fixture /></StoreProvider>)

const proof = {
  ready: () => ready,
  failures: () => failures,
  open(value = true) { flushSync(() => open?.(value)) },
  stats() { if (!runtime) throw new Error('Runtime absent'); return chipPerf.read(runtime) },
  patch(index: number, patch: Record<string, unknown>) { synthetic.patch('issueProjection', `synthetic-${index}`, patch) },
  traffic() { synthetic.patch('session', 'synthetic-session-0', { agentState: { phase: 'working', since: new Date().toISOString() } }) },
  async check() {
    if (!runtime || !pool) throw new Error('Pool absent')
    const { checkIssueChips } = await import('@podium/client-graph/diagnostics/chip-check')
    const state = runtime.getSnapshot()
    const legacy = allIssueViewModels(runtime.replica, state.issueProjections, state.issues)
    return checkIssueChips(pool.references, legacy, [...document.querySelectorAll<HTMLAnchorElement>('a.ref-link--issue[data-ref]')].map(a => a.dataset.ref!))
  },
}
Object.assign(window, { __issueChips: proof })
declare global { interface Window { __issueChips: typeof proof } }
