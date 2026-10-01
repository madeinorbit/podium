import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { asIssueId, asUserId } from '@podium/model/browser'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { attachWorklistPool, useWorklistPool, worklistPoolSurvivors } from '../src/app/store-worklist-pool'
import { SidebarUnified } from '../src/features/worklist/SidebarUnified'
import { SidebarRail } from '../src/features/worklist/SidebarRail'
import { SidebarPerfPanel } from '../src/features/worklist/SidebarPerfPanel'
import { initializeSidebarMeasurements } from '../src/features/worklist/sidebar-measurements'
import { initializeSidebarDataLayer, sidebarDataLayer } from '../src/lib/sidebar-data-layer'
import { createSidebarFixture } from './sidebar-fixture'
import { ConfirmProvider } from '../src/lib/hooks/use-confirm'
import '../src/index.css'
import '../src/styles.css'

initializeSidebarDataLayer({ get: () => null })
initializeSidebarMeasurements()
document.documentElement.classList.add('dark')
document.documentElement.dataset.theme = 'podium'
const synthetic = createSidebarFixture(Number(new URLSearchParams(location.search).get('rows') ?? 18))
let runtime: ClientRuntime | undefined
let ready = false
let toggleRail: ((value: boolean) => void) | undefined
let config = { httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }
const failures: string[] = []
const root = createRoot(document.getElementById('root')!)

function Fixture() {
  const [rail, setRail] = useState(false)
  const owner = useStoreHandle() as ClientRuntime
  const pool = useWorklistPool()
  useEffect(() => {
    toggleRail = setRail
    runtime = owner
    void owner.getSnapshot().refreshRepos().then(() => { ready = sidebarDataLayer() === 'legacy' || pool !== null })
    return () => { runtime = undefined; ready = false; toggleRail = undefined }
  }, [owner, pool])
  return <main className="flex h-screen bg-background text-foreground">
    <aside data-sidebar-shell className={rail ? 'flex w-[58px] flex-col bg-sidebar' : 'worklist-column flex w-[320px] flex-col bg-sidebar'}>
      {rail ? <SidebarRail /> : <SidebarUnified />}
    </aside>
    <div className="p-6 text-sm text-text-dim">Synthetic StoreProvider fixture · {sidebarDataLayer()}</div>
    <SidebarPerfPanel />
  </main>
}

function show(name: string | null = 'renderer-alice', rebuild = false) {
  ready = false
  if (rebuild) config = { ...config }
  const replica = synthetic.newReplica()
  flushSync(() => root.render(<StoreProvider principal={name === null ? null : asClientPrincipal(asUserId(name))}
    config={config} api={synthetic.api} createReplicaFn={() => replica} networkEnabled={false}
    onFatalError={message => failures.push(message)} attachRuntime={owner => attachWorklistPool(owner, error => failures.push(error.message))}>
    <ConfirmProvider><Fixture /></ConfirmProvider>
  </StoreProvider>))
}

const fixture = {
  ready: () => ready,
  failures: () => [...failures],
  show,
  rail: (value: boolean) => toggleRail?.(value),
  update: (patch: Record<string, unknown>) => synthetic.patch('issueProjection', 'synthetic-17', patch),
  select: (id: string) => runtime?.getSnapshot().setSelectedIssueId(asIssueId(id)),
  state: () => ({ mode: sidebarDataLayer(), selected: runtime?.getSnapshot().selectedIssueId, pane: runtime?.getSnapshot().paneA }),
  survivors: worklistPoolSurvivors,
}
Object.assign(window, { __sidebarRenderer: fixture })
declare global { interface Window { __sidebarRenderer: typeof fixture } }
show()
