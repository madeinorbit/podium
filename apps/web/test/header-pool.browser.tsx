import type { ClientRuntime } from '@podium/client-core/engine'
import { headerStats, storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { asIssueId, asUserId } from '@podium/model/browser'
import { Profiler, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { FoldedFlightDeckBar } from '../src/app/FoldedFlightDeckBar'
import { RightRail } from '../src/app/RightRail'
import { StatusStrip } from '../src/app/StatusStrip'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { ToolbarSlotProvider } from '../src/app/ToolbarSlot'
import { TopBar } from '../src/app/TopBar'
import { ConfirmProvider } from '../src/lib/hooks/use-confirm'
import { createHeaderFixture } from './header-fixture'
import '../src/index.css'
import '../src/styles.css'
const count = Number(new URLSearchParams(location.search).get('rows') ?? 5600)
const sessionCount = Math.min(
  count,
  Number(new URLSearchParams(location.search).get('sessions') ?? count),
)
const fixture = createHeaderFixture(count, sessionCount)
const failures: string[] = []
let runtime: ClientRuntime | undefined
let pool: ReturnType<typeof useWorklistPool> = null
let ready = false
let commits: Record<string, { commits: number; ms: number }> = {}
type HeaderFixtureStats = {
  header: ReturnType<typeof headerStats.read>
  store: ReturnType<typeof storeStats.snapshot>
  commits: typeof commits
}
headerStats.enable()
storeStats.enable()
document.documentElement.classList.add('dark')
document.documentElement.dataset.theme = 'podium'
function Surfaces() {
  const owner = useStoreHandle() as ClientRuntime
  const graph = useWorklistPool()
  useEffect(() => {
    runtime = owner
    pool = graph
    owner.getSnapshot().setSelectedIssueId(asIssueId('synthetic-1'))
    ready = graph !== null
    return () => {
      ready = false
      runtime = undefined
      pool = null
    }
  }, [owner, graph])
  const record = (id: string, _phase: string, duration: number) => {
    const entry = commits[id] ?? (commits[id] = { commits: 0, ms: 0 })
    entry.commits++
    entry.ms += duration
  }
  return (
    <ToolbarSlotProvider>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <Profiler id="TopBar" onRender={record}>
          <TopBar />
        </Profiler>
        <div className="flex flex-1">
          <Profiler id="FoldedFlightDeckBar" onRender={record}>
            <FoldedFlightDeckBar onExpand={() => {}} />
          </Profiler>
          <div className="flex-1" />
          <Profiler id="RightRail" onRender={record}>
            <RightRail rightPanel={null} onPanelChange={() => {}} />
          </Profiler>
        </div>
        <Profiler id="StatusStrip" onRender={record}>
          <StatusStrip />
        </Profiler>
      </div>
    </ToolbarSlotProvider>
  )
}
const root = createRoot(document.getElementById('root')!)
root.render(
  <StoreProvider
    principal={asClientPrincipal(asUserId('header-synthetic'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={fixture.api}
    createReplicaFn={() => fixture.newReplica()}
    networkEnabled={false}
    onFatalError={(error) => failures.push(error)}
    attachRuntime={(owner) => {
      // StoreProvider starts the runtime before attachment: the hub listeners now
      // exist in both arms, even when no asynchronous pool import is requested.
      fixture.bindHub(owner.hub)
      fixture.publishMachines()
      fixture.publishMetrics(0)
      return attachWorklistPool(owner, (error) => failures.push(error.message))
    }}
  >
    <ConfirmProvider>
      <Surfaces />
    </ConfirmProvider>
  </StoreProvider>,
)
const driver = {
  ready: () => ready,
  failures: () => [...failures],
  reset: () => {
    headerStats.reset()
    storeStats.reset()
    commits = {}
  },
  stats: (): HeaderFixtureStats => ({
    header: headerStats.read(),
    store: storeStats.snapshot(),
    commits,
  }),
  metrics: fixture.publishMetrics,
  activity: fixture.activity,
  idle: fixture.idle,
  async check() {
    if (!pool || !runtime) return null
    const { checkHeader, poolHeaderSnapshot } = await import(
      '@podium/client-graph/diagnostics/header-check'
    )
    for (let round = 0; round < 64; round++) {
      poolHeaderSnapshot(pool, fixture.inputs() as never)
      if (pool.hydrate() === 0) break
    }
    const result = checkHeader(pool, runtime.getSnapshot(), fixture.inputs() as never)
    return {
      differences: result.differences,
      pending: result.pending,
      first: result.first
        ? { sectionIndex: result.first.sectionIndex, field: result.first.field }
        : null,
    }
  },
  close: () => root.unmount(),
}
Object.assign(window, { __headerFixture: driver })
declare global {
  interface Window {
    __headerFixture: typeof driver
  }
}
