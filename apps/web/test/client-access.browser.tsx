import type { ClientRuntime } from '@podium/client-core/engine'
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import {
  StoreProvider,
  useHarnessDescriptors,
  useModelCatalogState,
  usePresenceRoom,
  useRepoLocks,
  useStoreHandle,
} from '@podium/client-core/react'
import { asUserId } from '@podium/model/browser'
import { Profiler, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { DensityProvider, useDensity } from '../src/app/density'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { useTerminalAppearance } from '../src/features/terminal/use-terminal-appearance'
import { useStickyPromptsPreference } from '../src/lib/sticky-prompts'
import { usePersistedUiValue } from '../src/lib/use-persisted-ui-state'
import { createHeaderFixture } from './header-fixture'
import '../src/index.css'

const fixture = createHeaderFixture(5600, 5014)
const failures: string[] = []
let owner: ClientRuntime,
  pool: ReturnType<typeof useWorklistPool> = null
let ready = false,
  commits = 0,
  commitMs = 0
storeStats.enable()
const parse = (value: string | null) => value ?? 'default'

function CurrentReaders() {
  const sticky = useStickyPromptsPreference()
  const density = useDensity()
  const fold = usePersistedUiValue('podium:sidebar:collapsed', parse)
  useTerminalAppearance()
  useModelCatalogState()
  useHarnessDescriptors(undefined)
  useRepoLocks(null)
  usePresenceRoom(null)
  return (
    <dl>
      <dt>Sticky prompts</dt>
      <dd>{sticky.enabled ? 'On' : 'Off'}</dd>
      <dt>Density</dt>
      <dd>{density.density}</dd>
      <dt>Sidebar</dt>
      <dd>{fold}</dd>
    </dl>
  )
}
function Surface() {
  const runtime = useStoreHandle() as ClientRuntime
  const currentPool = useWorklistPool()
  owner = runtime
  pool = currentPool
  const ui = runtime.getSnapshot().uiState
  useEffect(() => {
    ready = currentPool !== null
    return () => {
      ready = false
    }
  }, [currentPool])
  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 680, padding: 48, margin: 'auto' }}>
      <h1>Saved client preferences</h1>
      <p>5,600 synthetic tasks · 5,014 sessions</p>
      <Profiler
        id="preferences"
        onRender={(_id, _phase, ms) => {
          commits++
          commitMs += ms
        }}
      >
        <DensityProvider uiState={ui} densityEnabled>
          <CurrentReaders />
        </DensityProvider>
      </Profiler>
      <button
        type="button"
        onClick={() =>
          ui.set(
            'podium.chat.stickyPrompts',
            ui.get('podium.chat.stickyPrompts') === 'false' ? null : 'false',
          )
        }
      >
        Toggle sticky prompts
      </button>
    </main>
  )
}
const root = createRoot(document.getElementById('root')!)
root.render(
  <StoreProvider
    principal={asClientPrincipal(asUserId('preference-synthetic'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={fixture.api}
    createReplicaFn={() => fixture.newReplica()}
    networkEnabled={false}
    onFatalError={(error) => failures.push(error)}
    attachRuntime={(runtime) => {
      fixture.bindHub(runtime.hub)
      return attachWorklistPool(runtime, (error) => failures.push(error.message))
    }}
  >
    <Surface />
  </StoreProvider>,
)
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const driver = {
  ready: () => ready,
  reset() {
    storeStats.reset()
    commits = 0
    commitMs = 0
  },
  async activity(count: number) {
    for (let step = 1; step <= count; step++) fixture.activity(step)
    await nextFrame()
  },
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
    return {
      selectors: rows.reduce((sum, row) => sum + row.selectorRuns, 0),
      wakes: rows.reduce((sum, row) => sum + row.subscriberWakes, 0),
      legacyDerivations: rows.reduce(
        (sum, row) => sum + Object.values(row.slices).reduce((a, n) => a + n, 0),
        0,
      ),
      pool: pool?.preferenceCounts(),
      commits,
      commitMs,
      failures,
    }
  },
  async check() {
    if (!pool) return null
    const { checkPreferences } = await import('@podium/client-graph/diagnostics/preference-check')
    return checkPreferences(pool, owner.ui)
  },
  close: () => root.unmount(),
}
Object.assign(window, { __clientAccess: driver })
declare global {
  interface Window {
    __clientAccess: typeof driver
  }
}
