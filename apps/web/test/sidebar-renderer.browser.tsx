import type { ClientRuntime } from '@podium/client-core/engine'
import { bindSidebarPerf, createSidebarPerf, storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { asIssueId, asUserId } from '@podium/model/browser'
import { useEffect, useLayoutEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { CommandPaletteBoundary } from '../src/app/CommandPaletteBoundary'
import {
  attachWorklistPool,
  useWorklistPool,
  worklistPoolSurvivors,
} from '../src/app/store-worklist-pool'
import { SidebarPerfPanel } from '../src/features/worklist/SidebarPerfPanel'
import { SidebarRail } from '../src/features/worklist/SidebarRail'
import { SidebarUnified } from '../src/features/worklist/SidebarUnified'
import {
  bindSidebarRowMeasurements,
  createPaintBoundary,
  initializeSidebarMeasurements,
  observeSidebarInputs,
} from '../src/features/worklist/sidebar-measurements'
import { ConfirmProvider } from '../src/lib/hooks/use-confirm'
import { initializeSidebarDataLayer, sidebarDataLayer } from '../src/lib/sidebar-data-layer'
import { createSidebarFixture } from './sidebar-fixture'
import '../src/index.css'
import '../src/styles.css'

initializeSidebarDataLayer({ get: () => null })
initializeSidebarMeasurements()
document.documentElement.classList.add('dark')
document.documentElement.dataset.theme = 'podium'
const count = Number(new URLSearchParams(location.search).get('rows') ?? 18)
const worklistProof = new URLSearchParams(location.search).get('worklistProof') === '1'
// Before ANY StoreProvider render, including bootstrap. Never reset this census
// during a phase or principal rebuild; even a departed runtime's derive counts.
if (worklistProof) storeStats.enable()
const synthetic = createSidebarFixture(count)
let runtime: ClientRuntime | undefined
let ready = false
let toggleRail: ((value: boolean) => void) | undefined
let config = { httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }
const failures: string[] = []
const root = createRoot(document.getElementById('root')!)
let proofPerf: ReturnType<typeof createSidebarPerf> | undefined

/** The product panel disables store-stats in pool mode. The regression owns
 * its instrumentation so an accidental legacy reader cannot hide behind that. */
function WorklistProofMeasurements() {
  const owner = useStoreHandle()
  const [perf] = useState(() => createSidebarPerf())
  useLayoutEffect(() => {
    perf.reset()
    proofPerf = perf
    const paint = createPaintBoundary()
    const unbind = bindSidebarPerf(owner, perf, paint.afterPaint)
    const unbindRows = bindSidebarRowMeasurements({ owner, perf, mode: sidebarDataLayer() })
    const stopInput = observeSidebarInputs(perf, paint.afterPaint)
    return () => {
      stopInput()
      unbindRows()
      unbind()
      paint.dispose()
      if (proofPerf === perf) proofPerf = undefined
    }
  }, [owner, perf])
  return null
}

function Fixture() {
  const [rail, setRail] = useState(false)
  const owner = useStoreHandle() as ClientRuntime
  const pool = useWorklistPool()
  useEffect(() => {
    toggleRail = setRail
    runtime = owner
    void owner
      .getSnapshot()
      .refreshRepos()
      .then(() => {
        ready = sidebarDataLayer() === 'legacy' || pool !== null
      })
    return () => {
      runtime = undefined
      ready = false
      toggleRail = undefined
    }
  }, [owner, pool])
  return (
    <main className="flex h-screen bg-background text-foreground">
      <aside
        data-sidebar-shell
        className={
          rail
            ? 'flex w-[58px] flex-col bg-sidebar'
            : 'worklist-column flex w-[320px] flex-col bg-sidebar'
        }
      >
        {rail ? <SidebarRail /> : <SidebarUnified />}
      </aside>
      <div className="p-6 text-sm text-text-dim">
        Synthetic StoreProvider fixture · {sidebarDataLayer()}
      </div>
      {worklistProof ? (
        <>
          <CommandPaletteBoundary />
          <WorklistProofMeasurements />
        </>
      ) : (
        <SidebarPerfPanel />
      )}
    </main>
  )
}

function show(name: string | null = 'renderer-alice', rebuild = false) {
  ready = false
  if (rebuild) config = { ...config }
  const replica = synthetic.newReplica()
  flushSync(() =>
    root.render(
      <StoreProvider
        principal={name === null ? null : asClientPrincipal(asUserId(name))}
        config={config}
        api={synthetic.api}
        createReplicaFn={() => replica}
        networkEnabled={false}
        onFatalError={(message) => failures.push(message)}
        attachRuntime={(owner) =>
          attachWorklistPool(owner, (error) => failures.push(error.message))
        }
      >
        <ConfirmProvider>
          <Fixture />
        </ConfirmProvider>
      </StoreProvider>,
    ),
  )
}

const fixture = {
  ready: () => ready,
  failures: () => [...failures],
  show,
  rail: (value: boolean) => toggleRail?.(value),
  palette: (value: boolean) => runtime?.getSnapshot().setPaletteOpen(value),
  update: (patch: Record<string, unknown>) =>
    synthetic.patch('issueProjection', `synthetic-${count - 1}`, patch),
  select: (id: string) => runtime?.getSnapshot().setSelectedIssueId(asIssueId(id)),
  state: () => ({
    mode: sidebarDataLayer(),
    selected: runtime?.getSnapshot().selectedIssueId,
    pane: runtime?.getSnapshot().paneA,
    projectOrder: runtime?.getSnapshot().sidebarSettings.repoOrder,
    coarseNow: runtime?.getSnapshot().coarseNow,
  }),
  stats: () => storeStats.snapshot(),
  perf: () => proofPerf?.read() ?? globalThis.__podiumSidebarPerf?.read(),
  survivors: worklistPoolSurvivors,
}
Object.assign(window, { __sidebarRenderer: fixture })
declare global {
  interface Window {
    __sidebarRenderer: typeof fixture
  }
}
show()
