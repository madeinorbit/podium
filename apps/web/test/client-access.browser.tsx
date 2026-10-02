import type { ClientRuntime } from '@podium/client-core/engine'
import { StoreProvider, useStoreHandle, useStoreSelector, useModelCatalogState, useHarnessDescriptors, useRepoLocks, usePresenceRoom } from '@podium/client-core/react'
import { asClientPrincipal } from '@podium/client-core/principal'
import { storeStats } from '@podium/client-core/perf'
import { asUserId } from '@podium/model/browser'
import { Profiler, useEffect, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { DensityProvider, useDensity } from '../src/app/density'
import { usePersistedUiValue } from '../src/lib/use-persisted-ui-state'
import { useStickyPromptsPreference } from '../src/lib/sticky-prompts'
import { useTerminalAppearance } from '../src/features/terminal/use-terminal-appearance'
import { preferenceReadStats, preferencesDataLayer } from '../src/lib/preferences-data-layer'
import { createHeaderFixture } from './header-fixture'
import '../src/index.css'

const params = new URLSearchParams(location.search)
const mode = params.get('before') === '1' ? 'before' : 'after'
const fixture = createHeaderFixture(5600, 5014)
const failures: string[] = []
let owner: ClientRuntime, pool: ReturnType<typeof useWorklistPool> = null
let ready = false, commits = 0, commitMs = 0
storeStats.enable(); preferenceReadStats.enable()
const parse = (value: string | null) => value ?? 'default'

function LegacyReaders() {
  const ui = useStoreSelector((state) => state.uiState)
  useStoreSelector((state) => state.trpc)
  useStoreSelector((state) => state.hub)
  useStoreSelector((state) => state.httpOrigin)
  const sticky = useSyncExternalStore(ui.subscribe, () => ui.get('podium.chat.stickyPrompts'))
  const density = useSyncExternalStore(ui.subscribe, () => ui.get('podium.shell.density'))
  const fold = useSyncExternalStore(ui.subscribe, () => ui.get('podium:sidebar:collapsed'))
  return <dl><dt>Sticky prompts</dt><dd>{sticky !== 'false' ? 'On' : 'Off'}</dd><dt>Density</dt><dd>{density ?? 'balanced'}</dd><dt>Sidebar</dt><dd>{fold ?? 'default'}</dd></dl>
}
function CurrentReaders() {
  const sticky = useStickyPromptsPreference()
  const density = useDensity()
  const fold = usePersistedUiValue('podium:sidebar:collapsed', parse)
  useTerminalAppearance()
  useModelCatalogState(); useHarnessDescriptors(undefined); useRepoLocks(null); usePresenceRoom(null)
  return <dl><dt>Sticky prompts</dt><dd>{sticky.enabled ? 'On' : 'Off'}</dd><dt>Density</dt><dd>{density.density}</dd><dt>Sidebar</dt><dd>{fold}</dd></dl>
}
function Surface() {
  owner = useStoreHandle() as ClientRuntime
  pool = useWorklistPool()
  const ui = owner.getSnapshot().uiState
  useEffect(() => { ready = preferencesDataLayer() === 'legacy' || pool !== null; return () => { ready = false } }, [pool])
  return <main style={{ fontFamily: 'system-ui', maxWidth: 680, padding: 48, margin: 'auto' }}>
    <h1>Saved client preferences</h1><p>5,600 synthetic tasks · 5,014 sessions</p>
    <Profiler id="preferences" onRender={(_id, _phase, ms) => { commits++; commitMs += ms }}>
      {mode === 'before' ? <LegacyReaders /> : <DensityProvider uiState={ui} densityEnabled><CurrentReaders /></DensityProvider>}
    </Profiler>
    <button onClick={() => ui.set('podium.chat.stickyPrompts', ui.get('podium.chat.stickyPrompts') === 'false' ? null : 'false')}>Toggle sticky prompts</button>
  </main>
}
const root = createRoot(document.getElementById('root')!)
root.render(<StoreProvider principal={asClientPrincipal(asUserId('preference-synthetic'))}
  config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }} api={fixture.api}
  createReplicaFn={() => fixture.newReplica()} networkEnabled={false} onFatalError={(error) => failures.push(error)}
  attachRuntime={(runtime) => { fixture.bindHub(runtime.hub); return attachWorklistPool(runtime, (error) => failures.push(error.message)) }}
><Surface /></StoreProvider>)
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const driver = {
  ready: () => ready,
  reset() { storeStats.reset(); preferenceReadStats.reset(); commits = 0; commitMs = 0 },
  async activity(count: number) { for (let step = 1; step <= count; step++) fixture.activity(step); await nextFrame() },
  async preferences() {
    for (let step = 0; step < 20; step++) {
      owner.ui.set('podium.chat.stickyPrompts', step % 2 ? null : 'false')
      owner.ui.set('podium.shell.density', step % 2 ? 'balanced' : 'compact')
      owner.ui.set('podium:sidebar:collapsed', step % 2 ? 'false' : 'true')
      await nextFrame()
    }
  },
  stats: () => {
    const rows = storeStats.snapshot().runtimes
    return { selectors: rows.reduce((sum, row) => sum + row.selectorRuns, 0),
      wakes: rows.reduce((sum, row) => sum + row.subscriberWakes, 0),
      legacyDerivations: rows.reduce((sum, row) => sum + Object.values(row.slices).reduce((a, n) => a + n, 0), 0),
      ...preferenceReadStats.read(owner), pool: pool?.preferenceCounts(), commits, commitMs, failures }
  },
  async check() {
    if (!pool) return null
    const { checkPreferences } = await import('@podium/client-graph/diagnostics/preference-check')
    return checkPreferences(pool, owner.ui)
  },
  close: () => root.unmount(),
}
Object.assign(window, { __clientAccess: driver })
declare global { interface Window { __clientAccess: typeof driver } }
