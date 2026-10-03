/** Synthetic data, the real StoreProvider/runtime/replica attachment and panel.
 * The single observer row exercises measurement hooks, not POD-4955's future
 * shipping renderer. No server, outbox replacement or pool snapshot. */
import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime } from '@podium/client-core/engine'
import { reportSidebarCheck } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import type { IssueModel, MobxPool } from '@podium/client-graph'
import { observer } from '@podium/client-graph/react'
import { asIssueId, asUserId } from '@podium/model'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { buildCorpus } from '../../../packages/worklist-proto/harness/src/fixture'
import { attachWorklistPool, useWorklistPool } from '../src/app/store-worklist-pool'
import { SidebarPerfPanel } from '../src/features/worklist/SidebarPerfPanel'
import { measureSidebarRow } from '../src/features/worklist/sidebar-measurements'
import '../src/index.css'
import '../src/styles.css'
document.documentElement.classList.add('dark')
document.documentElement.dataset.theme = 'podium'

const original = buildCorpus(1).issueProjections.find(
  (row) =>
    row.audience === 'human' && row.stage === 'in_progress' && !row.closedAt && !row.parentId,
)!
let issue = { ...original, title: 'Synthetic pool row' }
let seq = 1
let runtime: ClientRuntime | undefined
let rowReads = 0
let redraw: (() => void) | undefined
let timer: ReturnType<typeof setInterval> | undefined
const failures: string[] = []
const records = [
  { entity: 'issueProjection', entityId: issue.id, value: issue, provenance: { seq } },
]
const replica = createKernelReplica({
  cache: {
    readCursor: () => null,
    readEntities: () => records,
    read: (entity, entityId) =>
      records.find((row) => row.entity === entity && row.entityId === entityId),
    durability: () => 'durable',
  },
  side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
})

const SyntheticRow = observer(
  measureSidebarRow(function SyntheticRow({ model }: { model: IssueModel }) {
    const [tick, setTick] = useState(0)
    useEffect(() => {
      redraw = () => setTick((value) => value + 1)
      return () => {
        redraw = undefined
      }
    }, [])
    return (
      <button
        data-testid="pool-row"
        type="button"
        data-tick={tick}
        className="m-4 rounded border border-border p-3 text-left"
        onClick={() => runtime?.getSnapshot().setSelectedIssueId(asIssueId(model.id))}
      >
        {model.title}
      </button>
    )
  }),
)

function Fixture() {
  const pool = useWorklistPool()
  useEffect(() => {
    if (!pool) return
    const originalRead = pool.row
    pool.row = function (this: MobxPool, ...args: unknown[]) {
      rowReads++
      return Reflect.apply(originalRead, this, args)
    } as typeof pool.row
    return () => {
      pool.row = originalRead
    }
  }, [pool])
  if (!pool) return <p>Loading the app-owned pool</p>
  const model = pool.issue(issue.id)
  if (!model) throw new Error('Synthetic pool issue did not become resident')
  return (
    <main className="min-h-screen bg-background p-5 text-foreground">
      <h1 className="text-lg font-semibold">App-runtime pool · synthetic evidence</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        One resident row. The shipping pool renderer and checker are follow-ups.
      </p>
      <div data-sidebar-shell>
        <SyntheticRow model={model} />
      </div>
      <SidebarPerfPanel />
    </main>
  )
}

const fixture = {
  ready: () => !!runtime && !!redraw && !!globalThis.__podiumSidebarPerf,
  rowReads: () => rowReads,
  failures: () => [...failures],
  update() {
    issue = { ...issue, title: 'Updated synthetic pool row' }
    records[0] = {
      entity: 'issueProjection',
      entityId: issue.id,
      value: issue,
      provenance: { seq: ++seq },
    }
    replica.onKernelEvent({ type: 'upserted', record: records[0], readmitted: false })
  },
  startRedraw() {
    if (timer) throw new Error('Planted redraw is already running')
    timer = setInterval(() => redraw?.(), 1000)
  },
  stopRedraw() {
    if (timer) clearInterval(timer)
    timer = undefined
  },
  // The named S5 seam, exercised without claiming a real checker exists.
  check(state: 'waiting' | 'different') {
    if (!runtime) throw new Error('Runtime missing')
    reportSidebarCheck(runtime, {
      state,
      differences: state === 'different' ? 1 : 0,
      checkedAt: null,
    })
  },
}
Object.assign(window, { __poolPerfFixture: fixture })
declare global {
  interface Window {
    __poolPerfFixture: typeof fixture
  }
}

createRoot(document.getElementById('root')!).render(
  <StoreProvider
    principal={asClientPrincipal(asUserId('synthetic-panel'))}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={{} as PodiumClientApi}
    createReplicaFn={() => replica}
    networkEnabled={false}
    onFatalError={(message) => failures.push(message)}
    attachRuntime={(owner) => {
      runtime = owner
      return attachWorklistPool(owner, (error) => failures.push(error.message))
    }}
  >
    <Fixture />
  </StoreProvider>,
)
