import type { ClientRuntime } from '@podium/client-core/engine'
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { asUserId } from '@podium/model/browser'
import { normalizeSettings } from '@podium/runtime'
import { Profiler, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { settingsDataLayer } from '../src/features/settings/data-layer'
import { SettingsView } from '../src/features/settings/SettingsView'
import { ColdStartComposer } from '../src/features/setup/ColdStartComposer'
import { ConfirmProvider } from '../src/lib/hooks/use-confirm'
import { createHeaderFixture } from './header-fixture'
import '../src/index.css'
import '../src/styles.css'

const fixture = createHeaderFixture(5600, 5014)
const failures: string[] = []
document.documentElement.classList.add('dark')
document.documentElement.dataset.theme = 'podium'
const settings = normalizeSettings({})
Object.assign(fixture.api, {
  settings: {
    get: { query: async () => settings },
    viewer: { query: async () => ({ permitted: {} }) },
    secretPresence: {
      query: async () => {
        throw new Error('Synthetic secret surface absent')
      },
    },
  },
  features: {
    state: {
      query: async () => ({
        devMode: false,
        channel: 'edge',
        flags: [{ id: 'notifications', enabled: true }],
      }),
    },
  },
  accounts: {
    list: {
      query: async () => [
        {
          id: 'native:codex',
          source: 'native',
          provider: 'openai',
          harness: 'codex',
          status: 'connected',
        },
      ],
    },
  },
  updates: { fleet: { query: async () => ({ rows: [] }) } },
  setup: { info: { query: async () => ({ mode: 'all-in-one' }) } },
})
let owner: ClientRuntime,
  pool: ReturnType<typeof useWorklistPool> = null
let ready = false,
  commits = 0,
  commitMs = 0,
  generation = 0
let changePrincipal = () => {}
storeStats.enable()

function Surface() {
  const runtime = useStoreHandle() as ClientRuntime
  const currentPool = useWorklistPool()
  owner = runtime
  pool = currentPool
  useEffect(() => {
    let active = true
    queueMicrotask(async () => {
      if (!active) return
      // Provider start installs the real hub listeners in its passive effect.
      fixture.publishMachines()
      await runtime.getSnapshot().refreshRepos()
      if (!active) return
      runtime.getSnapshot().setSettingsTab('accounts')
      ready = settingsDataLayer() === 'legacy' || currentPool !== null
    })
    return () => {
      active = false
      ready = false
    }
  }, [currentPool, runtime])
  return (
    <main style={{ minHeight: '100vh', padding: 24 }}>
      <Profiler
        id="settings"
        onRender={(_id, _phase, duration) => {
          commits++
          commitMs += duration
        }}
      >
        <SettingsView onClose={() => {}} />
        <div style={{ maxWidth: 800, margin: '24px auto' }}>
          <ColdStartComposer first={false} />
        </div>
      </Profiler>
    </main>
  )
}
function App() {
  const [principal, setPrincipal] = useState(0)
  changePrincipal = () => {
    ready = false
    generation++
    setPrincipal(generation)
  }
  return (
    <StoreProvider
      principal={asClientPrincipal(asUserId(`settings-synthetic-${principal}`))}
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
      <ConfirmProvider>
        <Surface />
      </ConfirmProvider>
    </StoreProvider>
  )
}
const root = createRoot(document.getElementById('root')!)
root.render(<App />)
const nextFrame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
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
      owner.ui.set('podium.sounds.enabled', step % 2 ? 'true' : 'false')
      owner.getSnapshot().setSettingsTab(step % 2 ? 'accounts' : 'notifications')
      await nextFrame()
    }
  },
  stats() {
    const rows = storeStats.snapshot().runtimes
    return {
      selectors: rows.reduce((sum, row) => sum + row.selectorRuns, 0),
      legacyDerivations: rows.reduce(
        (sum, row) => sum + Object.values(row.slices).reduce((a, n) => a + n, 0),
        0,
      ),
      slices: rows.flatMap((row) => Object.entries(row.slices)),
      commits,
      commitMs,
      failures,
      preferenceLoads: pool?.preferenceCounts(),
      generation,
    }
  },
  async check() {
    if (!pool) return null
    const { checkSettings } = await import('@podium/client-graph/diagnostics/settings-check')
    return checkSettings(pool, owner)
  },
  sound: () => owner.ui.get('podium.sounds.enabled'),
  switchPrincipal: () => changePrincipal(),
  close: () => root.unmount(),
}
Object.assign(window, { __settings: driver })
declare global {
  interface Window {
    __settings: typeof driver
  }
}
