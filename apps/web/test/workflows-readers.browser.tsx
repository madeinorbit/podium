import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
import { storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import type { SidebarSnapshot } from '@podium/client-graph/diagnostics/sidebar-check'
import { checkWorkflows } from '@podium/client-graph/diagnostics/workflow-check'
import { asUserId } from '@podium/model/browser'
import { createRoot } from 'react-dom/client'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import type { Trpc } from '../src/app/trpc'
import { MergeQueuePanel } from '../src/features/merge-queue/MergeQueuePanel'
import { ExecutionProfiles } from '../src/features/workflows/ExecutionProfiles'
import { RunProgress } from '../src/features/workflows/RunProgress'
import { useWorkflows } from '../src/features/workflows/use-workflows'
import { OPERATOR_WORKFLOW_RIGHTS } from '../src/features/workflows/workflow-commands'
import { createWorkflowsFixture } from './workflows-fixture'
import '../src/index.css'

const fixture = createWorkflowsFixture(5600, 5014)
let owner: ReturnType<typeof useStoreHandle<Trpc>> | undefined
let pool: ReturnType<typeof useWorklistPool>
const failures: string[] = []
const runtimeOwners = new Set<object>()
let capture: ReturnType<typeof storeStats.begin>
// Latch before any child renders; attaching the pool happens later, exactly as
// in the app. Choosing by pool availability would change hook order here.
storeStats.enable()
function Surface() {
  owner = useStoreHandle<Trpc>()
  pool = useWorklistPool()
  const source = useWorkflows()
  return (
    <main className="grid h-screen grid-cols-[2fr_2fr_1fr] bg-background text-foreground">
      <div data-proof-surface="profiles">
        <ExecutionProfiles source={source} rights={OPERATOR_WORKFLOW_RIGHTS} />
      </div>
      <div data-proof-surface="progress">
        <RunProgress source={source} rights={OPERATOR_WORKFLOW_RIGHTS} />
      </div>
      <div data-proof-surface="queues">
        <MergeQueuePanel
          issues={[]}
          scope={{ repoPath: '/synthetic/project' }}
          onSelectIssue={() => {}}
        />
      </div>
    </main>
  )
}
const root = createRoot(document.getElementById('root')!)
root.render(
  <StoreProvider
    principal={asClientPrincipal(asUserId('workflow-browser'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={fixture.api}
    createReplicaFn={() => fixture.newReplica()}
    networkEnabled={false}
    onFatalError={() => failures.push('provider-failure')}
    attachRuntime={(runtime) => {
      runtimeOwners.add(runtime)
      fixture.bindHub(runtime.hub)
      void referenceState(runtime)
        .refreshRepos()
        .catch(() => failures.push('fixture-discovery-failure'))
      return attachWorklistPool(runtime, () => failures.push('pool-failure'))
    }}
  >
    <Surface />
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
        fixture.calls.get &&
        fixture.calls.locks &&
        document.querySelector('[data-profile-id]') &&
        document.querySelector('[data-run-id]') &&
        !document.querySelector('[role="status"]') &&
        document.querySelector('[data-placement="available"]'),
    ),
  reset() {
    storeStats.reset()
    capture = storeStats.begin('feed')
  },
  async activity(count: number) {
    for (let step = 1; step <= count; step++)
      fixture.patch('session', `synthetic-session-${step % 12}`, {
        lastActiveAt: new Date(Date.now() + step).toISOString(),
      })
    await frame()
    storeStats.end(capture)
  },
  async update() {
    fixture.remove('issueProjection', 'synthetic-0')
    fixture.remove('session', 'synthetic-session-0')
    fixture.machines[0] = { ...fixture.machines[0]!, online: false }
    await referenceState(owner!).refreshRepos()
    await frame()
  },
  check: () => (pool && owner ? checkWorkflows(pool, referenceState(owner), fixture) : null),
  stats() {
    // The global ring evicts old owners as legacy sessionById records each
    // immutable array. A capture window retains the actual publishing runtime.
    const stats = storeStats.snapshot(),
      runtimes = stats.windows.at(-1)?.runtimes ?? []
    return {
      runtimes: runtimeOwners.size,
      publishingRuntimes: runtimes.filter((row) => row.publishes > 0).length,
      droppedOwners: stats.dropped,
      issues: owner?.replica.rowCount?.('issueProjections') ?? 0,
      sessions: owner?.replica.rowCount?.('sessions') ?? 0,
      profiles: fixture.profiles.length,
      runs: fixture.runs.length,
      pool: Boolean(pool),
      publishes: runtimes.reduce((sum, row) => sum + row.publishes, 0),
      selectors: runtimes.reduce((sum, row) => sum + row.selectorRuns, 0),
      legacyDerivations: runtimes.reduce(
        (sum, row) => sum + Object.values(row.slices).reduce((total, count) => total + count, 0),
        0,
      ),
      legacy: Object.fromEntries(
        ['workflows.machines', 'workflows.subject'].map((key) => [
          key,
          runtimes.reduce((sum, row) => sum + (row.slices[key] ?? 0), 0),
        ]),
      ),
      calls: fixture.calls,
      failures,
    }
  },
  snapshot(): SidebarSnapshot {
    return {
      pending: document.querySelectorAll('[role="status"]').length,
      sections: [...document.querySelectorAll('[data-proof-surface]')].map((node) => ({
        key: node.getAttribute('data-proof-surface')!,
        rows: [],
        fields: {
          text: node.textContent,
          labels: [...node.querySelectorAll('[aria-label]')].map((child) =>
            child.getAttribute('aria-label'),
          ),
          controls: [
            ...node.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select'),
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
Object.assign(window, { __workflowReaders: driver })
declare global {
  interface Window {
    __workflowReaders: typeof driver
  }
}
