/** Real pointer routing on private synthetic rows and the app's single outbox. */
import { type ClientRuntime, createEngineOutbox, type OutboxOutcome } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { LOADING, type MobxPool } from '@podium/client-graph'
import { checkSidebar } from '@podium/client-graph/diagnostics/sidebar-check'
import { asUserId } from '@podium/model/browser'
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { SidebarUnified } from '../src/features/worklist/SidebarUnified'
import { ConfirmProvider } from '../src/lib/hooks/use-confirm'
import { initializeSidebarDataLayer } from '../src/lib/sidebar-data-layer'
import { createSidebarFixture } from './sidebar-fixture'
import '../src/index.css'
import '../src/styles.css'

initializeSidebarDataLayer({ get: () => null })
document.documentElement.classList.add('dark')
document.documentElement.dataset.theme = 'podium'
const synthetic = createSidebarFixture(12, Date.now(), true)
for (let index = 0; index < 12; index += 1) {
  const patch = { sortKey: `a${'0123456789AB'[index]}`, pinned: index === 0 }
  synthetic.patch('issue', `synthetic-${index}`, patch)
  synthetic.patch('issueProjection', `synthetic-${index}`, patch)
}
type Request = { procedure: string; input: Record<string, unknown>; reject: (error: unknown) => void }
const requests: Request[] = []
const outcomes: OutboxOutcome[] = []
const failures: string[] = []
const procedure = (name: string) => ({
  mutate: (input: Record<string, unknown>) => new Promise((_resolve, reject) => {
    requests.push({ procedure: name, input, reject })
  }),
})
Object.assign(synthetic.api, { issues: {
  update: procedure('issues.update'), markRead: procedure('issues.markRead'),
  archive: procedure('issues.archive'),
} })
let runtime: ClientRuntime | undefined
let pool: MobxPool | null = null
let ready = false
function Fixture() {
  const owner = useStoreHandle() as ClientRuntime
  const graph = useWorklistPool()
  useEffect(() => {
    runtime = owner
    pool = graph
    const stop = owner.subscribeOutboxOutcomes((outcome) => outcomes.push(outcome))
    void owner.getSnapshot().refreshRepos().then(() => { ready = graph !== null })
    return stop
  }, [owner, graph])
  return <main className="flex h-screen bg-background text-foreground">
    <aside className="worklist-column flex w-[320px] flex-col bg-sidebar"><SidebarUnified /></aside>
    <div className="p-6 text-sm text-text-dim">Synthetic sidebar interaction fixture</div>
  </main>
}
const fixture = {
  ready: () => ready,
  state: () => {
    const store = runtime!.getSnapshot()
    const sections = pool!.sidebar.sections()
    return {
      selected: store.selectedIssueId, pane: store.paneA,
      pinned: [...sections.pinnedIds], open: sections.bands.flatMap((band) => band.rowIds),
      closed: sections.bands.flatMap((band) => band.closedIds),
      requests: requests.map(({ procedure, input }) => ({ procedure, input })),
      outcomes: outcomes.map((outcome) => ({ type: outcome.type, mutationId: outcome.mutationId })),
      failures,
    }
  },
  compare: () => {
    const store = runtime!.getSnapshot()
    return checkSidebar(pool!, store, {
      pinnedRepos: store.pins.repos, pinnedWorktrees: store.pins.worktrees,
      projectOrder: store.sidebarSettings.repoOrder, paneA: store.paneA,
      selectedWorktree: store.selectedWorktree,
    })
  },
  refuse: (index: number) => requests[index]!.reject(Object.assign(new Error('Synthetic refusal'), {
    data: { code: 'BAD_REQUEST', httpStatus: 400 },
  })),
  title: (id: string) => {
    const row = pool!.sidebar.row(id)
    return row === undefined || row === LOADING ? null : row.title
  },
  close: (id: string) => {
    const patch = { stage: 'done', closedReason: 'done', closedAt: new Date().toISOString(), tuckedAt: new Date().toISOString() }
    synthetic.patch('issue', id, patch)
    synthetic.patch('issueProjection', id, patch)
  },
}
Object.assign(window, { __sidebarActions: fixture })
declare global { interface Window { __sidebarActions: typeof fixture } }
createRoot(document.getElementById('root')!).render(
  <StoreProvider
    principal={asClientPrincipal(asUserId('sidebar-synthetic-actions'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={synthetic.api} createReplicaFn={() => synthetic.replica}
    createOutboxFn={(options) => createEngineOutbox({ ...options, isOnline: () => true })}
    networkEnabled={false} onFatalError={(message) => failures.push(message)}
    attachRuntime={(owner) => attachWorklistPool(owner, (error) => failures.push(error.message))}
  ><ConfirmProvider><Fixture /></ConfirmProvider></StoreProvider>,
)
