import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { machineViewsFromWire } from '@podium/client-core/viewmodels'
import { checkAutomations } from '@podium/client-graph/diagnostics/automation-check'
import type { SidebarSnapshot } from '@podium/client-graph/diagnostics/sidebar-check'
import { asUserId } from '@podium/model/browser'
import { Profiler, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Store } from '../src/app/store'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import type { Trpc } from '../src/app/trpc'
import { AutomationsView } from '../src/features/automations/AutomationsView'
import { automationTargetChoices } from '../src/features/automations/automation-form'
import { NewAutomationDialog } from '../src/features/automations/NewAutomationDialog'
import { SpecsView } from '../src/features/specs/SpecsView'
import { ConfirmProvider } from '../src/lib/hooks/use-confirm'
import { createAutomationsFixture } from './automations-fixture'
import '../src/index.css'

const fixture = createAutomationsFixture(5600, 5014)
let owner: ReturnType<typeof useStoreHandle<Trpc>> | undefined
let pool: ReturnType<typeof useWorklistPool>,
  commits = 0,
  commitMs = 0
const failures: string[] = []
storeStats.enable()
function Surface() {
  owner = useStoreHandle<Trpc>()
  pool = useWorklistPool()
  const [dialog, setDialog] = useState(false)
  useEffect(() => {
    Object.assign(window, {
      __openAutomationDialog: () => setDialog(true),
      __closeAutomationDialog: () => setDialog(false),
    })
    void owner!
      .getSnapshot()
      .refreshRepos()
      .catch(() => failures.push('fixture-discovery-failure'))
  }, [])
  return (
    <Profiler
      id="automation-specs"
      onRender={(_id, _phase, duration) => {
        commits++
        commitMs += duration
      }}
    >
      <main className="grid h-screen grid-cols-2 gap-3">
        <div data-proof-surface="automations">
          <AutomationsView />
        </div>
        <div data-proof-surface="specs">
          <SpecsView />
        </div>
        {dialog && (
          <NewAutomationDialog
            trpc={owner!.getSnapshot().trpc}
            automation={null}
            onClose={() => setDialog(false)}
            onSaved={() => setDialog(false)}
          />
        )}
      </main>
    </Profiler>
  )
}
const root = createRoot(document.getElementById('root')!)
root.render(
  <StoreProvider
    principal={asClientPrincipal(asUserId('automation-browser'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={fixture.api}
    createReplicaFn={() => fixture.newReplica()}
    networkEnabled={false}
    onFatalError={() => failures.push('provider-failure')}
    attachRuntime={(runtime) => {
      fixture.bindHub(runtime.hub)
      return attachWorklistPool(runtime, () => failures.push('pool-failure'))
    }}
  >
    <ConfirmProvider>
      <Surface />
    </ConfirmProvider>
  </StoreProvider>,
)
const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
const driver = {
  ready: () =>
    Boolean(
      owner &&
        fixture.calls.specGet &&
        fixture.calls.subscriptions &&
        !document.querySelector('[role="status"]') &&
        document
          .querySelector('.ProseMirror')
          ?.textContent?.includes('Synthetic specification body'),
    ),
  reset() {
    storeStats.reset()
    commits = 0
    commitMs = 0
  },
  async activity(count: number) {
    for (let step = 1; step <= count; step++)
      fixture.patch('session', `synthetic-session-${step % 12}`, {
        lastActiveAt: new Date(Date.now() + step).toISOString(),
      })
    await frame()
  },
  async update() {
    fixture.patch('automation', 'synthetic-auto-0', { enabled: false })
    await frame()
  },
  check() {
    if (!pool || !owner) return null
    const state = owner.getSnapshot() as unknown as Store
    return checkAutomations(
      pool,
      state,
      (path) =>
        automationTargetChoices(
          state.repos,
          state.sessions,
          machineViewsFromWire(state.machines),
          path,
        ),
      [null, '/synthetic/missing'],
    )
  },
  stats() {
    const runtimes = storeStats.snapshot().runtimes
    return {
      runtimes: runtimes.length,
      issues: owner?.getSnapshot().issueProjections.length ?? 0,
      sessions: owner?.getSnapshot().sessions.length ?? 0,
      automations: owner?.getSnapshot().automations.length ?? 0,
      runs: owner?.getSnapshot().automationRuns.length ?? 0,
      pool: Boolean(pool),
      publishes: runtimes.reduce((sum, row) => sum + row.publishes, 0),
      selectors: runtimes.reduce((sum, row) => sum + row.selectorRuns, 0),
      commits,
      commitMs,
      calls: fixture.calls,
      failures,
    }
  },
  snapshot(): SidebarSnapshot {
    const nodes = [
      ...document.querySelectorAll('[data-proof-surface]'),
      ...document.querySelectorAll('[role="dialog"]'),
    ]
    return {
      pending: 0,
      sections: nodes.map((node, index) => ({
        key: node.getAttribute('data-proof-surface') ?? `dialog:${index}`,
        rows: [],
        fields: {
          text: node.textContent,
          labels: [...node.querySelectorAll('[aria-label]')].map((child) =>
            child.getAttribute('aria-label'),
          ),
          controls: [
            ...node.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
              'input,select,textarea',
            ),
          ].map((control) => ({
            id: control.id.replace(/_r_[0-9a-z]+_|:r[0-9a-z]+:/g, 'react-generated'),
            value: control.value,
            checked: control instanceof HTMLInputElement ? control.checked : undefined,
          })),
        },
      })),
    }
  },
  close: () => root.unmount(),
}
Object.assign(window, { __automationReaders: driver })
declare global {
  interface Window {
    __automationReaders: typeof driver
    __openAutomationDialog(): void
    __closeAutomationDialog(): void
  }
}
