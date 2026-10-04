import type { ClientRuntime } from '@podium/client-core/engine'
import { readRuntimeStoreStats, storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { checkSuperagent } from '@podium/client-graph/diagnostics/superagent-check'
import { asUserId } from '@podium/model/browser'
import { Profiler, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DockHeaderSlotProvider } from '@/app/DockHeaderSlot'
import { attachWorklistPool, useWorklistPool } from '@/app/store-worklist-pool'
import { ConciergeButton } from './ConciergeButton'
import { createSuperagentFixture } from './fixture'
import { SuperagentView } from './SuperagentView'
import '@/index.css'

const data = createSuperagentFixture(5600, 5014),
  errors: string[] = []
let runtime: ClientRuntime,
  pool: ReturnType<typeof useWorklistPool> = null,
  commits = 0,
  ready = false,
  firstPool: unknown
storeStats.enable()
function Surface() {
  runtime = useStoreHandle() as ClientRuntime
  pool = useWorklistPool()
  if (firstPool === undefined) firstPool = pool
  const [header, setHeader] = useState<HTMLElement | null>(null)
  ready = pool !== null
  return (
    <main className="mx-auto max-w-2xl p-8">
      <p className="mb-4 text-xs text-muted-foreground">
        5,600 synthetic tasks · 5,014 sessions · pool readers
      </p>
      <Profiler id="superagent" onRender={() => commits++}>
        <header className="mb-3 flex items-center gap-3">
          <ConciergeButton />
          <h1 className="flex-1 text-lg">Superagent</h1>
          <div ref={setHeader} className="flex gap-2" />
        </header>
        <div className="flex h-96 rounded border bg-background">
          <DockHeaderSlotProvider value={header}>
            <SuperagentView />
          </DockHeaderSlotProvider>
        </div>
      </Profiler>
    </main>
  )
}
const root = createRoot(document.getElementById('root')!)
root.render(
  <StoreProvider
    principal={asClientPrincipal(asUserId('operator'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={data.api}
    createReplicaFn={() => data.newReplica()}
    networkEnabled={false}
    onFatalError={(error) => errors.push(error)}
    attachRuntime={(owner) => {
      data.bindHub(owner.hub)
      owner.readPosition.replace({
        issueEvents: { lastEventId: 9, seenAt: '2026-10-02T00:00:00Z' },
      })
      const stop = attachWorklistPool(owner, (error) => errors.push(error.message))
      void owner.getSnapshot().refreshSuperThreads()
      void owner.getSnapshot().refreshRepos()
      return stop
    }}
  >
    <Surface />
  </StoreProvider>,
)
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const driver = {
  ready: () =>
    ready &&
    !!document.querySelector('[data-testid="embedded-chat"]') &&
    !document.querySelector<HTMLButtonElement>('button[aria-label="Concierge"]')?.disabled,
  firstPool: () => firstPool === null,
  reset() {
    storeStats.reset()
    commits = 0
  },
  async activity(count: number) {
    for (let step = 1; step <= count; step++) {
      data.activity(step)
      await frame()
    }
  },
  async threads(count: number) {
    for (let step = 1; step <= count; step++) {
      await data.updateThread(runtime, !!(step % 2))
      await frame()
    }
  },
  snapshot() {
    return {
      surface: document.querySelector('[data-testid="superagent-pane"]')?.innerHTML,
      controls: [...document.querySelectorAll('button')].map((button) => ({
        title: button.title,
        label: button.getAttribute('aria-label'),
        disabled: button.disabled,
      })),
    }
  },
  stats() {
    const stats = readRuntimeStoreStats(runtime)
    return {
      selectors: stats?.selectorRuns ?? 0,
      ownLegacy: Object.fromEntries(
        Object.entries(stats?.slices ?? {}).filter(
          ([key]) => key === 'superagent' || key.startsWith('superagent.'),
        ),
      ),
      commits,
      failures: errors.length,
      actions: data.actions,
      focused: runtime.getSnapshot().paneA,
    }
  },
  check() {
    const result = pool ? checkSuperagent(pool, runtime.getSnapshot()) : null
    return result
  },
  close: () => root.unmount(),
}
Object.assign(window, { __superagentProof: driver })
declare global {
  interface Window {
    __superagentProof: typeof driver
  }
}
