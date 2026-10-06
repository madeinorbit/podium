import { worklistGroups } from '@podium/client-graph/worklist/groups'
import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
/** Synthetic acceptance fixture. No operator RPC, cache, runtime or data. */
import type { PodiumClientApi } from '@podium/client-core/api'
import { type ClientRuntime, openKernelEngineOutbox } from '@podium/client-core/engine'
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle, useRuntimeSelector } from '@podium/client-core/react'
import type { IssueViewModel } from '@podium/client-core/replica'
import {
  createKernelReplica,
  createSideCache,
  replicaNamespaceKey,
} from '@podium/client-core/replica'
import type { MobxPool } from '@podium/client-graph'
import { asIssueId, asUserId } from '@podium/model/browser'
import { IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import type { EntityRecord } from '@podium/sync/replica'
import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'

import { allIssueViewModels } from '@podium/client-graph/diagnostics/reference/issue-view-models'
import { buildFlightDeckRows } from '../../../packages/client-core/src/values/mission'
import {
  buildCorpus,
  buildCorpusCell,
  FIXED_NOW,
} from '../../../packages/worklist-proto/harness/src/fixture'
import { pickTargets } from '../../../packages/worklist-proto/shared/src/scenarios'
import { speedSwitchState } from '../harness/speed-switches'
import { CommandPaletteBoundary } from '../src/app/CommandPaletteBoundary'
import { FlightDeck } from '../src/app/FlightDeck'
import { OperatorFocusProvider } from '../src/app/operator-focus'
import { RightDock } from '../src/app/RightDock'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { Workspace } from '../src/app/Workspace'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { IssueExplorerProvider } from '../src/features/issues/explorer/explorer-context'
import { IssuePage } from '../src/features/issues/IssuePage'
import { SidebarUnified } from '../src/features/worklist/SidebarUnified'
import { ConfirmProvider } from '../src/lib/hooks/use-confirm'
import { seedAcceptanceCache } from './sidebar-acceptance-seed'
import '../src/index.css'
import '../src/styles.css'

const params = new URLSearchParams(location.search)
const startupSwitches = speedSwitchState(location.search)
const scale = Number(params.get('scale') ?? 1) as 1 | 4
const corpus =
  params.get('cell') === 'h10a1'
    ? buildCorpusCell({ history: 10, active: 1 }, 4443)
    : buildCorpus(scale, 4443)
const targets = pickTargets(corpus)
const full = params.get('surface') === 'full'
const pageSurface = params.get('surface') === 'page'
const measured = params.get('measure') === '1'
const errors: string[] = []
if (measured) storeStats.enable()
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
const database = await IndexedDbSyncStore.open({
  factory: indexedDB as unknown as Parameters<typeof IndexedDbSyncStore.open>[0]['factory'],
  databaseName: 'sidebar-acceptance-synthetic',
  onDegraded: (reason) => errors.push(`Synthetic IndexedDB degraded: ${String(reason)}`),
})
let owner: ClientRuntime | undefined
let graph: MobxPool | null = null
let ready = false
let assembly: Awaited<ReturnType<typeof assemble>>
let generation = 0
let configurePageTargets: (ids: string[]) => void = () => {}
const retired: { name: string; ref: WeakRef<object> }[] = []
const root = createRoot(document.getElementById('root')!)

type Interval = { start: number; end: number; kind: string; derivations?: number; rows?: number }
type CaptureStats = ReturnType<typeof storeStats.snapshot>
let active = false
let intervals: Interval[] = []
if (measured)
  Object.assign(globalThis, {
    __acceptanceTiming: {
      active: () => active,
      record: (interval: Interval) => intervals.push(interval),
    },
  })
const patched = new WeakSet<object>()
function patchBoundary(object: object, key: string, kind: string) {
  const obj = object as Record<string, (...args: unknown[]) => unknown>
  const original = obj[key]
  // Runtime methods are retired as reads move to the pool. Only instrument
  // measurement boundaries that still exist in this production build.
  if (typeof original !== 'function') return
  obj[key] = function (...args: unknown[]) {
    if (!active) return original.apply(this, args)
    const start = performance.now()
    try {
      return original.apply(this, args)
    } finally {
      intervals.push({ start, end: performance.now(), kind })
    }
  }
}
function instrumentRuntime(runtime: ClientRuntime) {
  if (!measured || patched.has(runtime)) return
  patched.add(runtime)
  patchBoundary(runtime, 'batch', 'runtime batch')
}
async function assemble(name: string) {
  const principal = replicaNamespaceKey({ syncBoundaryId: 'acceptance-synthetic', memberId: name })
  const view = database.viewFor(principal)
  const seedRecords = seedAcceptanceCache(corpus, name).readEntities()
  view.cache.installSnapshot(seedRecords, { feedId: 'synthetic-fixture', epoch: '1', seq: 1 }, [])
  await database.settled()
  const replica = createKernelReplica({
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

function MeasurementBinding() {
  return null
}

function Fixture() {
  const runtime = useStoreHandle() as ClientRuntime
  const pool = useWorklistPool()
  const selected = useRuntimeSelector((s) => s.selectedIssueId)
  const [pageTargets, setPageTargets] = useState<string[]>([])
  configurePageTargets = setPageTargets
  owner = runtime
  graph = pool
  useEffect(() => {
    ready = false
    void referenceState(runtime)
      .refreshRepos()
      .then(() => {
        ready = pool !== null
      })
    return () => {
      ready = false
    }
  }, [runtime, pool])
  return (
    <OperatorFocusProvider missionId={selected}>
      <IssueExplorerProvider>
        {measured && <MeasurementBinding />}
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
            {pageSurface && <IssuePageProbe ids={pageTargets} />}
            {full && (
              <>
                <div
                  data-fixture-mission={selected ?? ''}
                  className="flex min-h-0 flex-none"
                  style={{ width: 330 }}
                >
                  <FlightDeck key={selected ?? 'empty'} onCollapse={() => {}} />
                </div>
                <div data-fixture-workspace className="relative flex min-h-0 min-w-0 flex-1">
                  <Workspace />
                </div>
                <aside className="right-dock-shell flex min-h-0 flex-none" style={{ width: 316 }}>
                  <RightDock tab="issue" onClose={() => {}} />
                </aside>
              </>
            )}
          </div>
        </div>
      </IssueExplorerProvider>
    </OperatorFocusProvider>
  )
}

/** Measurement-only trusted opening controls; both arms render the shipped
 * page and write through the existing synthetic runtime/outbox. */
function IssuePageProbe({ ids }: { ids: string[] }) {
  const { openIssueId, setOpenIssueId, markIssueRead } = useRuntimeSelector((s) => ({
    openIssueId: s.openIssueId,
    setOpenIssueId: s.setOpenIssueId,
    markIssueRead: s.markIssueRead,
  }))
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex gap-2">
        {ids.map((id) => (
          <button
            type="button"
            key={id}
            data-page-target={id}
            onClick={() => {
              void markIssueRead(asIssueId(id))
              setOpenIssueId(asIssueId(id))
            }}
          >
            Open {id}
          </button>
        ))}
      </div>
      {openIssueId && (
        <div className="flex min-h-0 flex-1" data-fixture-issue-page={openIssueId}>
          {
            <IssuePage
              issue={{ id: openIssueId } as IssueViewModel}
              orderedIds={ids.map(asIssueId)}
              onBack={() => setOpenIssueId(null)}
              onNavigate={setOpenIssueId}
            />
          }
        </div>
      )}
    </div>
  )
}

async function show(name = 'acceptance-alice', rebuild = false) {
  ready = false
  active = false
  if (owner) {
    generation++
    retired.push({ name: `${generation}.runtime`, ref: new WeakRef(owner) })
    retired.push({ name: `${generation}.replica`, ref: new WeakRef(assembly.replica) })
    if (graph)
      for (const [key, value] of Object.entries({
        pool: graph,
        tables: graph.tables,
        relations: graph.graph,
        worklist: graph.worklist,
        groups: worklistGroups(graph),
        clock: graph.clock,
        residency: graph.residency,
      }))
        if (value) retired.push({ name: `${generation}.${key}`, ref: new WeakRef(value) })
  }
  assembly = await assemble(name)
  const config = { httpOrigin: location.origin, wsClientUrl: 'ws://offline.invalid' }
  flushSync(() =>
    root.render(
      <StoreProvider
        principal={assembly.principal}
        config={config}
        api={api}
        createReplicaFn={() => assembly.replica}
        createOutboxFn={assembly.createOutboxFn}
        networkEnabled={false}
        onFatalError={(message) => errors.push(message)}
        attachRuntime={(runtime) => {
          instrumentRuntime(runtime)
          return attachWorklistPool(runtime, (error) => errors.push(error.message))
        }}
      >
        <TooltipProvider>
          <ConfirmProvider>
            <Fixture />
          </ConfirmProvider>
        </TooltipProvider>
      </StoreProvider>,
    ),
  )
  void rebuild
}

let seq = 10
function patch(entity: string, id: string, changes: Record<string, unknown>) {
  const old = assembly.view.cache.read(entity, id)
  if (!old) throw new Error(`Missing synthetic ${entity}:${id}`)
  const record: EntityRecord = {
    ...old,
    value: { ...(old.value as object), ...changes },
    provenance: { ...old.provenance, seq: ++seq },
  }
  // The fixture's simulated authority updates the app's existing replica;
  // gestures still use the production store actions and its one outbox.
  assembly.view.cache.applyAtomic({
    operations: [{ kind: 'upsert', ...record }],
    cursor: { feedId: 'synthetic-fixture', epoch: '1', seq },
  })
  assembly.replica.onKernelEvent({ type: 'upserted', record, readmitted: false })
}

const fixture = {
  ready: () => ready,
  mode: () => 'pool' as const,
  paneMode: () => 'pool' as const,
  errors: () => [...errors],
  corpus: corpus.stats,
  targets,
  show,
  settled: () => database.settled(),
  begin() {
    storeStats.reset()
    intervals = []
    active = true
  },
  stop(): { intervals: Interval[]; stats: CaptureStats; panel: undefined } {
    active = false
    return { intervals, stats: storeStats.snapshot(), panel: undefined }
  },
  stats: (): CaptureStats => storeStats.snapshot(),
  perf: () => undefined,
  state: () => ({
    switches: startupSwitches,
    selected: owner?.access.selectedIssueId,
    pane: owner?.access.paneA,
    issues: owner?.replica.rowCount?.('issueProjections'),
    sessions: owner?.replica.rowCount?.('sessions'),
    pool: graph !== null,
    runtimeDestroyed: (owner as unknown as { destroyed?: boolean })?.destroyed,
  }),
  shape(ids: string[]) {
    const snapshot = referenceState(owner!)
    const issues = allIssueViewModels(
      assembly.replica,
      snapshot.issueProjections,
      snapshot.issueUserStates,
    )
    return ids.map((id) => ({
      id,
      root: issues.some(
        (issue) =>
          issue.id === id &&
          !issue.parentId &&
          !issue.archived &&
          !issue.closedAt &&
          issue.stage !== 'done',
      ),
      rows: buildFlightDeckRows(issues, snapshot.sessions, id, 'full', []).length,
    }))
  },
  backgroundTitle(id: string, title: string) {
    patch('issueProjection', id, { title })
  },
  async event(kind: string, iteration: number) {
    const stamp = new Date(Date.now() + iteration).toISOString()
    if (kind === 'unrelated') patch('session', targets.heartbeatSessionId, { lastActiveAt: stamp })
    else if (kind === 'title')
      assembly.replica.batch(() => {
        patch('issueProjection', targets.visibleRootId, {
          title: `Acceptance renamed ${iteration}`,
        })
      })
    else if (kind === 'phase')
      patch('session', targets.phaseSessionId, {
        agentState:
          iteration % 2
            ? { phase: 'working', since: stamp }
            : { phase: 'idle', since: stamp, idle: { kind: 'done' } },
        lastActiveAt: stamp,
      })
    else if (kind === 'draft')
      referenceState(owner!)
        .setSessionDraft(targets.phaseSessionId as never, `Acceptance draft ${iteration}`)
    else throw new Error(`Unknown event ${kind}`)
  },
  async compare() {
    if (!graph) throw new Error('No pool for side-by-side comparison')
    const { checkSidebar } = await import('@podium/client-graph/diagnostics/sidebar-check')
    const s = referenceState(owner!)
    const keys = [
      'podium:sidebar:pinned-fold',
      ...sidebarView(graph)
        .sections()
        .bands.flatMap((band) => [band.foldKey, band.snoozedFoldKey, band.closedFoldKey]),
    ]
    return checkSidebar(graph, s, {
      pinnedRepos: s.pins.repos,
      pinnedWorktrees: s.pins.worktrees,
      projectOrder: s.sidebarSettings.repoOrder,
      paneA: s.paneA,
      selectedWorktree: s.selectedWorktree,
      collapsed: Object.fromEntries(
        keys.flatMap((key) => {
          const value = owner!.ui.get(key)
          return value === null ? [] : [[key, value === 'true']]
        }),
      ),
    })
  },
  survivors: () => retired.filter(({ ref }) => ref.deref() !== undefined).map(({ name }) => name),
  rowCount: () =>
    graph ? Object.values(graph.tables).reduce((count, table) => count + table.size, 0) : null,
  select: (id: string) => referenceState(owner!).setSelectedIssueId(asIssueId(id)),
  preparePageTargets: (ids: string[]) => flushSync(() => configurePageTargets(ids)),
}
Object.assign(window, { __acceptance: fixture })
declare global {
  interface Window {
    __acceptance: typeof fixture
  }
}
await show()
requestAnimationFrame(() =>
  requestAnimationFrame(() => performance.mark('acceptance:startup-painted')),
)
