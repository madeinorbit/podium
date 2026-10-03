/** Real components and their sole offline runtime, with the fixed 4x corpus. */
import type { PodiumClientApi } from '@podium/client-core/api'
import { type ClientRuntime, openKernelEngineOutbox } from '@podium/client-core/engine'
import { issueBoardStats, storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import {
  createKernelReplica,
  createSideCache,
  replicaNamespaceKey,
} from '@podium/client-core/replica'
import { asUserId } from '@podium/model/browser'
import { IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { buildCorpus, FIXED_NOW } from '../../../packages/worklist-proto/harness/src/fixture'
import { OperatorFocusProvider } from '../src/app/operator-focus'
import { initializePoolScreens } from '../src/app/pool-screens'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { ToolbarSlotProvider, ToolbarSlotTarget } from '../src/app/ToolbarSlot'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { boardDataLayer } from '../src/features/issues/board-data-layer'
import { IssueExplorerProvider } from '../src/features/issues/explorer/explorer-context'
import { IssueExplorerList } from '../src/features/issues/explorer/IssueExplorerList'
import { IssuesView } from '../src/features/issues/IssuesView'
import { ConfirmProvider } from '../src/lib/hooks/use-confirm'
import { seedAcceptanceCache } from '../test/sidebar-acceptance-seed'
import '../src/index.css'
import '../src/styles.css'

const corpus = buildCorpus(4, 4443)
const principal = 'board-proof'
const errors: string[] = []
const answers: Record<string, unknown> = {
  'discovery.refreshRepos.mutate': {
    repositories: corpus.repos,
    machines: corpus.machines,
    diagnostics: [],
  },
  'settings.get.query': {
    sessionDefaults: { agent: 'codex' },
    roles: { coding: { startScreen: 'chat' } },
  },
  'features.state.query': { devMode: true, channel: 'edge', flags: [] },
  'pins.list.query': corpus.pins,
}
const apiAt = (path: string[] = []): unknown =>
  new Proxy(() => {}, {
    get(_target, key) {
      return key === 'then' ? undefined : apiAt([...path, String(key)])
    },
    apply() {
      return Promise.resolve(answers[path.join('.')] ?? [])
    },
  })
const api = apiAt() as PodiumClientApi
const database = await IndexedDbSyncStore.open({
  factory: indexedDB as unknown as Parameters<typeof IndexedDbSyncStore.open>[0]['factory'],
  databaseName: 'board-proof-synthetic',
  onDegraded: (reason) => errors.push(String(reason)),
})
const view = database.viewFor(
  replicaNamespaceKey({ syncBoundaryId: 'board-proof', memberId: principal }),
)
view.cache.installSnapshot(
  seedAcceptanceCache(corpus, principal).readEntities(),
  { feedId: 'board-proof', epoch: '1', seq: 1 },
  [],
)
await database.settled()
const replica = createKernelReplica({
  cache: view.cache,
  side: createSideCache({
    storage: localStorage,
    enumerateKeys: () => Object.keys(localStorage),
    keyPrefix: 'board-proof.',
  }),
})
const outbox = await openKernelEngineOutbox({
  store: view.outbox,
  principal,
  api,
  onDegraded: (reason) => errors.push(String(reason)),
})
let owner: ClientRuntime
let pool: ReturnType<typeof useWorklistPool> = null
let ready = false
storeStats.enable()
issueBoardStats.enable()
document.documentElement.classList.add('dark')
document.documentElement.dataset.theme = 'podium'

function Fixture() {
  const runtime = useStoreHandle() as ClientRuntime
  initializePoolScreens(runtime.ui)
  owner = runtime
  const currentPool = useWorklistPool()
  pool = currentPool
  const [surface, setSurface] = useState<'closed' | 'board' | 'explorer'>('closed')
  useEffect(() => {
    void runtime
      .getSnapshot()
      .refreshRepos()
      .then(() => {
        ready = currentPool !== null
      })
    return () => {
      ready = false
    }
  }, [runtime, currentPool])
  return (
    <OperatorFocusProvider missionId={null}>
      <IssueExplorerProvider>
        <ToolbarSlotProvider>
          <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
            <div style={{ display: 'flex', minHeight: 42, gap: 12 }}>
              <button type="button" data-board-open onClick={() => setSurface('board')}>
                Open board
              </button>
              <button type="button" data-explorer-open onClick={() => setSurface('explorer')}>
                Open explorer
              </button>
              <button type="button" data-board-close onClick={() => setSurface('closed')}>
                Close
              </button>
              <ToolbarSlotTarget />
            </div>
            <main style={{ display: 'flex', flex: 1, minHeight: 0 }}>
              {surface === 'board' && <IssuesView />}
              {surface === 'explorer' && (
                <div style={{ width: 316, display: 'flex', flexDirection: 'column' }}>
                  <IssueExplorerList />
                </div>
              )}
            </main>
          </div>
        </ToolbarSlotProvider>
      </IssueExplorerProvider>
    </OperatorFocusProvider>
  )
}

Object.assign(window, {
  __boardHarness: {
    ready: () =>
      ready &&
      (boardDataLayer() !== 'pool' ||
        (!!pool && typeof pool.row('issueBoardWindow', 'current') !== 'symbol')),
    errors: () => [...errors],
    corpus: corpus.stats,
    now: FIXED_NOW,
    state: () => ({
      issues: owner?.getSnapshot().issueProjections.length,
      sessions: owner?.getSnapshot().sessions.length,
      residentIssues: pool?.tables.issue.size,
      coldIssues: pool?.residency?.ids('issue', true).length,
    }),
    reset: () => {
      storeStats.reset()
      issueBoardStats.reset()
    },
    stats: () => ({ ...storeStats.snapshot(), board: issueBoardStats.read() }),
  },
})
createRoot(document.getElementById('root')!).render(
  <StoreProvider
    principal={asClientPrincipal(asUserId(principal), 'board-proof')}
    config={{ httpOrigin: location.origin, wsClientUrl: 'ws://offline.invalid' }}
    api={api}
    createReplicaFn={() => replica}
    createOutboxFn={outbox}
    networkEnabled={false}
    attachRuntime={(runtime) => attachWorklistPool(runtime, (error) => errors.push(error.message))}
    onFatalError={(message) => errors.push(message)}
  >
    <TooltipProvider>
      <ConfirmProvider>
        <Fixture />
      </ConfirmProvider>
    </TooltipProvider>
  </StoreProvider>,
)
