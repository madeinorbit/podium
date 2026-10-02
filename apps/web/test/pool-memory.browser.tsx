/** POD-5133 heap-ownership fixture. The same synthetic assembly and sidebar
 * surface as the POD-4959 memory cells (sidebar-acceptance.browser.tsx with
 * measure=0), with no measurement hooks. It adds only `__memory.holdOwners()`:
 * named handles, held on a `Pod5133OwnerHolder` during the snapshot, that the
 * analyzer uses as ownership barriers. The analyzer never follows the
 * holder's own edges, so holding them changes no liveness. */
import type { PodiumClientApi } from '@podium/client-core/api'
import { type ClientRuntime, openKernelEngineOutbox } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle, useStoreSelector } from '@podium/client-core/react'
import {
  allIssueViewModels,
  createKernelReplica,
  createSideCache,
  replicaNamespaceKey,
  retainReplicaEntity,
} from '@podium/client-core/replica'
import type { MobxPool } from '@podium/client-graph'
import { asUserId } from '@podium/model/browser'
import { IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import { useEffect } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import {
  buildCorpus,
  buildCorpusCell,
  FIXED_NOW,
} from '../../../packages/worklist-proto/harness/src/fixture'
import { seedCacheFromCorpus } from '../../../packages/worklist-proto/shared/src/scenarios'
import { CommandPaletteBoundary } from '../src/app/CommandPaletteBoundary'
import { OperatorFocusProvider } from '../src/app/operator-focus'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { IssueExplorerProvider } from '../src/features/issues/explorer/explorer-context'
import { SidebarUnified } from '../src/features/worklist/SidebarUnified'
import { initializeSidebarMeasurements } from '../src/features/worklist/sidebar-measurements'
import { ConfirmProvider } from '../src/lib/hooks/use-confirm'
import { initializeSidebarDataLayer, sidebarDataLayer } from '../src/lib/sidebar-data-layer'
import '../src/index.css'
import '../src/styles.css'

const params = new URLSearchParams(location.search)
const scale = Number(params.get('scale') ?? 1) as 1 | 4
const dropLegacyIssues = params.get('dropLegacyIssues') === '1'
let corpus: ReturnType<typeof buildCorpus> | null = params.has('operator')
  ? ((await (await fetch('/operator-input.json')).json()) as ReturnType<typeof buildCorpus>)
  : params.get('cell') === 'h10a1'
    ? buildCorpusCell({ history: 10, active: 1 }, 4443)
    : buildCorpus(scale, 4443)
const errors: string[] = []
initializeSidebarDataLayer({ get: () => null })
initializeSidebarMeasurements()
document.documentElement.classList.add('dark')
document.documentElement.dataset.theme = 'podium'

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
  'sessions.models.query': [],
  'issues.cost.query': null,
  'cost.task.query': null,
  'cost.tasks.query': [],
  'models.catalog.query': { machineId: 'synthetic-machine', byAgent: {}, fetchedAt: FIXED_NOW },
}
const apiAt = (path: string[] = []): unknown =>
  new Proxy(() => {}, {
    get(_target, key) {
      return key === 'then' ? undefined : apiAt([...path, String(key)])
    },
    apply() {
      const key = path.join('.')
      if (Object.hasOwn(answers, key)) return Promise.resolve(answers[key])
      if (key.includes('cost'))
        return Promise.resolve({ sessions: [], totals: {}, daily: [], view: null })
      if (key.includes('transcript'))
        return Promise.resolve({ events: [], lines: [], cursor: null, hasMore: false, bytes: 0 })
      if (key.includes('catalog')) return Promise.resolve({ agents: [], models: [] })
      return Promise.resolve([])
    },
  })
const api = apiAt() as PodiumClientApi
let seedRecords: ReturnType<ReturnType<typeof seedCacheFromCorpus>['readEntities']> | null =
  seedCacheFromCorpus(corpus).readEntities()
const database = await IndexedDbSyncStore.open({
  factory: indexedDB as unknown as Parameters<typeof IndexedDbSyncStore.open>[0]['factory'],
  databaseName: 'pool-memory-synthetic',
  retainEntity: (entity) => retainReplicaEntity(entity, dropLegacyIssues),
  onDegraded: (reason) => errors.push(`Synthetic IndexedDB degraded: ${String(reason)}`),
})
let owner: ClientRuntime | undefined
let graph: MobxPool | null = null
let ready = false
const root = createRoot(document.getElementById('root')!)

async function assemble(name: string) {
  const principal = replicaNamespaceKey({ syncBoundaryId: 'acceptance-synthetic', memberId: name })
  const view = database.viewFor(principal)
  view.cache.installSnapshot(seedRecords!, { feedId: 'synthetic-fixture', epoch: '1', seq: 1 }, [])
  await database.settled()
  const replica = createKernelReplica({
    dropLegacyIssues,
    cache: view.cache,
    side: createSideCache({
      storage: localStorage,
      storageEventApi: window,
      enumerateKeys: () => Object.keys(localStorage),
      keyPrefix: `acceptance-side.${name}`,
    }),
  })
  return {
    view,
    replica,
    principal: asClientPrincipal(asUserId(name), 'acceptance-synthetic'),
    createOutboxFn: await openKernelEngineOutbox({
      store: view.outbox,
      principal: name,
      api,
      onDegraded: (reason) => errors.push(`Synthetic outbox degraded: ${String(reason)}`),
    }),
  }
}
const assembly = await assemble('acceptance-alice')

function Fixture() {
  const runtime = useStoreHandle() as ClientRuntime
  const pool = useWorklistPool()
  const selected = useStoreSelector((s) => s.selectedIssueId)
  owner = runtime
  graph = pool
  useEffect(() => {
    ready = false
    void runtime
      .getSnapshot()
      .refreshRepos()
      .then(() => {
        ready = sidebarDataLayer() === 'legacy' || pool !== null
      })
    return () => {
      ready = false
    }
  }, [runtime, pool])
  return (
    <OperatorFocusProvider missionId={selected}>
      <IssueExplorerProvider>
        <CommandPaletteBoundary />
        <div className="desktop-shell">
          <div className="desktop-shell-row" style={{ height: '100vh' }}>
            <aside
              data-sidebar-shell
              style={{ width: 300, flexShrink: 0 }}
              className="worklist-column flex w-[300px] flex-none flex-col"
            >
              <SidebarUnified />
            </aside>
          </div>
        </div>
      </IssueExplorerProvider>
    </OperatorFocusProvider>
  )
}

flushSync(() =>
  root.render(
    <StoreProvider
      principal={assembly.principal}
      config={{ httpOrigin: location.origin, wsClientUrl: 'ws://offline.invalid' }}
      api={api}
      createReplicaFn={() => assembly.replica}
      createOutboxFn={assembly.createOutboxFn}
      networkEnabled={false}
      onFatalError={(message) => errors.push(message)}
      attachRuntime={(runtime) =>
        attachWorklistPool(runtime, (error) => errors.push(error.message))
      }
    >
      <TooltipProvider>
        <ConfirmProvider>
          <Fixture />
        </ConfirmProvider>
      </TooltipProvider>
    </StoreProvider>,
  ),
)

/** Found by name in the snapshot; the analyzer ignores its outgoing edges. */
class Pod5133OwnerHolder {}

/** Own enumerable object-valued fields, one level, as `<prefix>.<key>`. */
function fields(prefix: string, value: object, into: Record<string, object>) {
  into[prefix] = value
  for (const [key, field] of Object.entries(value))
    if (
      field !== null &&
      (typeof field === 'object' || (typeof field === 'function' && Object.keys(field).length > 0))
    )
      into[`${prefix}.${key}`] = field
}

const memory = {
  ready: () => ready,
  mode: sidebarDataLayer,
  errors: () => [...errors],
  state: () => ({
    issues: owner?.getSnapshot().issues.length,
    sessions: owner?.getSnapshot().sessions.length,
    projections: owner?.getSnapshot().issueProjections.length,
    oldRecords: assembly.view.cache.readEntities().filter((row) => row.entity === 'issue').length,
    pool: graph !== null,
    rows: graph
      ? Object.fromEntries(
          Object.entries(graph.tables).map(([entity, table]) => [entity, table.size]),
        )
      : null,
  }),
  /** Only hashes leave the page; operator payloads stay on ludovico. */
  async fingerprint() {
    const hash = async (value: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value))
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    }
    return {
      models: await hash(allIssueViewModels(assembly.replica)),
      sidebar: await hash(document.querySelector('[data-sidebar-shell]')?.textContent),
      visible: await hash(
        [...document.querySelectorAll('[data-issue-row]')].map((row) =>
          row.getAttribute('data-issue-row'),
        ),
      ),
    }
  },
  /** Ids of the synthetic issue and session rows, read once before capture. */
  ids: () => ({
    issue: (owner!.getSnapshot().issueProjections as { id: string }[]).map((row) => row.id),
    session: owner!.getSnapshot().sessions.map((row) => row.sessionId as string),
  }),
  /** Ownership barriers; flat name -> object. */
  owners(): Record<string, object> {
    const into: Record<string, object> = {}
    fields('runtime', owner!, into)
    fields('snapshot', owner!.getSnapshot(), into)
    fields('replica', assembly.replica, into)
    fields('cache', assembly.view.cache, into)
    fields('outbox', assembly.view.outbox, into)
    if (graph) fields('pool', graph, into)
    return into
  },
  holdOwners() {
    Object.assign(window, {
      __pod5133Owners: Object.assign(new Pod5133OwnerHolder(), memory.owners()),
    })
  },
  dropOwners() {
    Reflect.deleteProperty(window, '__pod5133Owners')
  },
  /** Drop the fixture's own construction inputs so only the app retains rows. */
  releaseFixtureInputs() {
    corpus = null
    seedRecords = null
  },
}
Object.assign(window, { __memory: memory })
declare global {
  interface Window {
    __memory: typeof memory
  }
}
