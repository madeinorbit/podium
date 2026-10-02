/** Fixture-only page: the real StoreProvider and attachment, with a private
 * kernel facade seeded from the pilot corpus. No app UI or live endpoint. */
import type { PodiumClientApi } from '@podium/client-core/api'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import type { MobxPool } from '@podium/client-graph'
import { asUserId } from '@podium/model'
import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { RuntimePoolFixture } from '../../../packages/worklist-proto/harness/browser/runtime-pool-fixture'
import { buildCorpus } from '../../../packages/worklist-proto/harness/src/fixture'
import {
  attachWorklistPool,
  useWorklistPool,
  worklistPoolSurvivors,
} from '../src/app/store-worklist-pool'
import { sidebarDataLayer } from '../src/lib/sidebar-data-layer'
import { chipsDataLayer } from '../src/lib/chips-data-layer'
import { IssueChipLiveness } from '../src/features/chat/IssueChipLiveness'

const corpus = buildCorpus(1)
const issue = corpus.issues.find(
  (row) =>
    row.audience === 'human' && row.stage === 'in_progress' && !row.closedAt && !row.parentId,
)!
const projection = corpus.issueProjections.find((row) => row.id === issue.id)!
const id = issue.id
const coldId = 'iss_offline_reference'
const coldRepo = 'repo_offline_reference'
let serverCalls = 0
const api = { issues: { resolveRefs: { query() {
  serverCalls++
  throw new Error('A chip called the server reference resolver')
} } } } as unknown as PodiumClientApi
let config = { httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }
let current: MobxPool | null = null
let currentReplica: ReturnType<typeof createKernelReplica> | undefined
let observed: MobxPool | null = null
let replicas = 0
let attachments = 0
const failures: string[] = []
const models: WeakRef<object>[] = []
const root = createRoot(document.getElementById('root')!)

function replica() {
  replicas += 1
  const records = [
    { entity: 'issueProjection', entityId: id, value: projection, provenance: { seq: 1 } },
    { entity: 'repo', entityId: coldRepo,
      value: { id: coldRepo, path: '/offline-reference', prefix: 'POD' }, provenance: { seq: 1 } },
    { entity: 'issueProjection', entityId: coldId,
      value: { ...projection, id: coldId, repoId: coldRepo, seq: 1234, title: 'Cold offline issue',
        archived: true, deletedAt: null, stage: 'done', closedAt: '2026-01-01T00:00:00.000Z' }, provenance: { seq: 1 } },
  ]
  const cache = {
    readCursor: () => null,
    readEntities: () => records,
    read: (entity: string, entityId: string) =>
      records.find((row) => row.entity === entity && row.entityId === entityId),
    durability: () => 'durable' as const,
  }
  return currentReplica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
}

function Probe(): null {
  const pool = useWorklistPool()
  current = pool
  useEffect(() => {
    if (pool === null) return
    let gone = false
    let stop: (() => void) | undefined
    void import('../../../packages/worklist-proto/harness/browser/runtime-pool-observe').then(
      ({ observePool }) => {
        if (gone) return
        stop = observePool(pool, id)
        observed = pool
      },
    )
    return () => {
      gone = true
      stop?.()
      if (observed === pool) observed = null
    }
  }, [pool])
  return null
}

function ReferenceProbe() {
  const pool = useWorklistPool()
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  if (pool === null || chipsDataLayer() !== 'pool') return null
  // A missing sentinel proves the asynchronous production watcher is attached
  // before the driver goes offline, without reading or warming the cold issue.
  return <><div id="offline-reference-host" ref={setHost}>
    <a className="ref-link--issue" data-ref="POD-0">Watcher ready</a>
  </div><IssueChipLiveness root={host} /></>
}

function show(name: string | null, rebuild = false): void {
  if (current !== null) {
    const model = current.model('issue', id)
    if (model === undefined) throw new Error('fixture issue is not resident')
    models.push(new WeakRef(model))
  }
  current = null
  if (rebuild) config = { ...config }
  flushSync(() =>
    root.render(
      <StoreProvider
        principal={name === null ? null : asClientPrincipal(asUserId(name))}
        config={config}
        api={api}
        createReplicaFn={replica}
        networkEnabled={false}
        onFatalError={(message) => failures.push(message)}
        attachRuntime={(runtime) => {
          attachments += 1
          return attachWorklistPool(runtime, (error) => failures.push(error.message))
        }}
      >
        <Probe />
        <ReferenceProbe />
      </StoreProvider>,
    ),
  )
}

const fixture = {
  show,
  ready: () =>
    sidebarDataLayer() === 'legacy' ? attachments > 0 : current !== null && observed === current,
  state: () => ({ replicas, attachments, pool: current !== null, failures }),
  survivors: () => [
    ...worklistPoolSurvivors(),
    ...models.flatMap((ref, index) => (ref.deref() === undefined ? [] : [`model.${index}`])),
  ],
  mountReference(): void {
    const host = document.getElementById('offline-reference-host')
    if (!host || !current?.residency?.isCold('issue', coldId))
      throw new Error('offline reference must begin with a cold issue')
    const anchor = document.createElement('a')
    anchor.className = 'ref-link--issue'
    anchor.dataset.ref = 'POD-1234'
    anchor.href = '#POD-1234'
    anchor.textContent = 'POD-1234'
    host.append(anchor)
  },
  referenceState: () => ({
    online: navigator.onLine,
    cold: current?.residency?.isCold('issue', coldId) ?? false,
    resident: current?.tables.issue.has(coldId) ?? false,
    issueId: currentReplica?.issueIdByRef('POD-1234'),
    serverCalls,
  }),
} satisfies RuntimePoolFixture
Object.assign(window, { __poolFixture: fixture })
show('fixture-alice')
