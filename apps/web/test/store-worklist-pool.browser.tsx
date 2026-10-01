/** Fixture-only page: the real StoreProvider and attachment, with a private
 * kernel facade seeded from the pilot corpus. No app UI or live endpoint. */
import type { PodiumClientApi } from '@podium/client-core/api'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import type { MobxPool } from '@podium/client-graph'
import { asUserId } from '@podium/model'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { buildCorpus } from '../../../packages/worklist-proto/harness/src/fixture'
import type { RuntimePoolFixture } from '../../../packages/worklist-proto/harness/browser/runtime-pool-fixture'
import { attachWorklistPool, useWorklistPool, worklistPoolSurvivors } from '../src/app/store-worklist-pool'
import { sidebarDataLayer } from '../src/lib/sidebar-data-layer'

const corpus = buildCorpus(1)
const issue = corpus.issues.find((row) => row.audience === 'human' && row.stage === 'in_progress' && !row.closedAt && !row.parentId)!
const projection = corpus.issueProjections.find((row) => row.id === issue.id)!
const id = issue.id
const api = {} as PodiumClientApi
let config = { httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }
let current: MobxPool | null = null
let replicas = 0
let attachments = 0
const failures: string[] = []
const models: WeakRef<object>[] = []
const root = createRoot(document.getElementById('root')!)

function replica() {
  replicas += 1
  const records = [
    { entity: 'issue', entityId: id, value: issue, provenance: { seq: 1 } },
    { entity: 'issueProjection', entityId: id, value: projection, provenance: { seq: 1 } },
  ]
  const cache = {
    readCursor: () => null,
    readEntities: () => records,
    read: (entity: string, entityId: string) => records.find((row) => row.entity === entity && row.entityId === entityId),
    durability: () => 'durable' as const,
  }
  return createKernelReplica({ cache, side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
}

function Probe(): null {
  current = useWorklistPool()
  return null
}

function show(name: string | null, rebuild = false): void {
  if (current !== null) {
    const model = current.model('issue', id)
    if (model === undefined) throw new Error('fixture issue is not resident')
    models.push(new WeakRef(model))
  }
  current = null
  if (rebuild) config = { ...config }
  flushSync(() => root.render(
    <StoreProvider
      principal={name === null ? null : asClientPrincipal(asUserId(name))}
      config={config} api={api} createReplicaFn={replica}
      networkEnabled={false} onFatalError={(message) => failures.push(message)}
      attachRuntime={(runtime) => {
        attachments += 1
        return attachWorklistPool(runtime, (error) => failures.push(error.message))
      }}
    ><Probe /></StoreProvider>,
  ))
}

const fixture = {
  show,
  ready: () => sidebarDataLayer() === 'legacy' ? attachments > 0 : current !== null,
  state: () => ({ replicas, attachments, pool: current !== null, failures }),
  survivors: () => [
    ...worklistPoolSurvivors(),
    ...models.flatMap((ref, index) => ref.deref() === undefined ? [] : [`model.${index}`]),
  ],
} satisfies RuntimePoolFixture
Object.assign(window, { __poolFixture: fixture })
show('fixture-alice')
