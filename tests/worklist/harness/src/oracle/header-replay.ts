/** Read-only operator replay. Raw rows and errors stay in memory on ludovico.
 * Output is counts, field positions and opaque IDs; no export file is made.
 * timeout 180 bun --conditions=@podium/source .../header-replay.ts
 */
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { ReferenceState as Store } from '../../../diagnostics/reference-state'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { HttpBootstrapSource } from '@podium/client-core/sync-stream'
import { parseServerOrigin } from '@podium/client-core/transport'
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { checkHeader, legacyHeaderSnapshot, poolHeaderSnapshot } from '../../../diagnostics/header-check'
import type { HeaderRows } from '@podium/client-graph/header-schema'
import type { HostMetricsWire } from '@podium/model/browser'
import { compareStructural, runInAction } from 'mobx'
import { corpusFromLive, type LiveCollections } from '../fixture/live-snapshot'
import { ScenarioCache } from '../../../shared/src/scenarios'
import { sidebarReplayStore } from './sidebar-replay'

let phase = 0
async function main() {
  if (hostname() !== 'ludovico') throw new Error('Replay is restricted to ludovico')
  const origin = process.argv.find((arg) => arg.startsWith('--origin='))?.slice(9) ?? 'http://127.0.0.1:18787'
  phase = 1
  const { token } = JSON.parse(readFileSync(join(homedir(), '.podium/cli-session.json'), 'utf8')) as { token: string }
  const cookie = `podium_session=${token}`
  const call = async <T>(path: string, method = 'GET'): Promise<T> => {
    const response = await fetch(`${origin}/trpc/${path}?batch=1${method === 'GET' ? '&input=%7B%7D' : ''}`, {
      method, headers: { cookie, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
      ...(method === 'POST' ? { body: '{}' } : {}),
    })
    const body = await response.json() as { result?: { data: T } }[]
    if (!response.ok || !body[0]?.result) throw new Error('Read failed')
    return body[0].result.data
  }
  phase = 2
  const metrics = await new Promise<HostMetricsWire[]>((resolve, reject) => {
    // Bun's native client supports cookie headers. This connection sends no
    // command, subscription or write; it reads the host bootstrap frame once.
    const address = new URL(parseServerOrigin(origin)!.wsClientUrl)
    address.searchParams.append('cap', 'sync.http.v1')
    const socket = new WebSocket(address, { headers: { Cookie: cookie, Origin: origin } } as unknown as string[])
    const timer = setTimeout(() => { socket.close(); reject(new Error('No metric frame')) }, 15000)
    socket.onerror = () => { clearTimeout(timer); socket.close(); reject(new Error('Metric read failed')) }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      const frame = JSON.parse(event.data) as { type: string; hosts?: HostMetricsWire[] }
      if (frame.type === 'hostMetricsChanged' && frame.hosts) { clearTimeout(timer); socket.close(); resolve(frame.hosts) }
    }
  })
  phase = 3
  const source = new HttpBootstrapSource({ origin, streamingFetch: { fetch: (input, init) => fetch(input, { ...init, headers: { ...(init.headers as object), cookie } }) } })
  const cache = new ScenarioCache(), byEntity = new Map<string, unknown[]>()
  for await (const chunk of source.bootstrap()) {
    for (const change of chunk.changes) {
      if (change.op !== 'upsert') continue
      cache.put(change.entity as Parameters<ScenarioCache['put']>[0], change.entityId, change.payload)
      const rows = byEntity.get(change.entity) ?? []
      rows.push(change.payload); byEntity.set(change.entity, rows)
    }
  }
  phase = 4
  const [scan, pins, quotas, history, lifecycle] = await Promise.all([
    call<{ repositories: LiveCollections['repos']; machines: LiveCollections['machines'] }>('discovery.refreshRepos', 'POST'),
    call<LiveCollections['pins']>('pins.list'), call<HeaderRows['quota'][]>('quota.summary'),
    call<HeaderRows['history']>('sessions.concurrencyHistory'), call<HeaderRows['lifecycle']>('settings.get'),
  ])
  const raw = { issues: byEntity.get('issue') ?? [], issueProjections: byEntity.get('issueProjection') ?? [],
    sessions: byEntity.get('session') ?? [], repoProjections: byEntity.get('repo') ?? [], issueDeps: byEntity.get('issueDep') ?? [],
    repos: scan.repositories, machines: scan.machines, pins } as LiveCollections
  phase = 5
  const corpus = corpusFromLive(raw, Date.now())
  const replica = createKernelReplica({ cache, side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  let store = { ...sidebarReplayStore(corpus, replica), view: 'workspace', paneA: null, fileTabs: [], outboxSize: 0,
    shipOrders: replica.rows('shipOrders'), trpc: { quota: { summary: { query: async () => quotas } },
      sessions: { concurrencyHistory: { query: async () => history } }, settings: { get: { query: async () => lifecycle } } } } as unknown as Store<PodiumClientApi>
  const listeners = new Set<() => void>(), health = { status: 'ok', rttMs: null, since: corpus.fixedNow } as const
  const runtime = { replica, getSnapshot: () => store, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
 hostMetrics: { getSnapshot: () => metrics, subscribe: () => () => {} },
    hub: { connectionHealth: () => health, onConnectionHealth: () => () => {} } }
  phase = 6
  const handle = createRuntimeWorklistPool(runtime as unknown as Parameters<typeof createRuntimeWorklistPool>[0], { header: true })
  try {
    await Promise.resolve(); await Promise.resolve()
    const inputs = { metrics, quotas, history, lifecycle, connection: health }
    phase = 7
    const selections = [null, ...replica.rows('issueProjections').slice(0, 32).map((row) => row.id)]
    let differences = 0, pending = 0, checks = 0
    let first: { check: number; sectionIndex: number; field: string } | null = null
    const locations: { check: number; sectionIndex: number; field: string }[] = []
    for (const selectedIssueId of selections) {
      store = { ...store, selectedIssueId }
      for (const listener of listeners) listener()
      // Locals publish at the existing bridge's microtask boundary.
      await Promise.resolve()
      for (let turn = 0; turn < 64; turn++) {
        runInAction(() => poolHeaderSnapshot(handle.pool))
        if (handle.pool.hydrate() === 0) break
      }
      const result = runInAction(() => checkHeader(handle.pool, store, inputs))
      checks++; differences += result.differences; pending += result.pending
      if (!first && result.first) first = { check: checks, sectionIndex: result.first.sectionIndex, field: result.first.field }
      if (result.differences) {
        const expected = legacyHeaderSnapshot(store, inputs, handle.pool.clock.current)
        const actual = runInAction(() => poolHeaderSnapshot(handle.pool))
        for (let index = 0; index < expected.sections.length; index++) {
          const a = actual.sections[index]?.fields.value as Record<string, unknown> | null
          const b = expected.sections[index]?.fields.value as Record<string, unknown> | null
          if (compareStructural(a, b)) continue
          for (const field of ['id', 'title', 'seq', 'stage', 'displayRef', 'color', 'root', 'progress', 'live', 'working', 'needs', 'unfinishedCount', 'decisionCount']) {
            if (locations.length < 32 && !compareStructural(a?.[field], b?.[field])) locations.push({ check: checks, sectionIndex: index, field })
          }
        }
      }
    }
    console.log(JSON.stringify({ issues: corpus.issues.length, sessions: corpus.sessions.length, machines: corpus.machines.length,
      metricRows: metrics.length, quotaRows: quotas.length, checks, differences, pending, first, locations }))
    if (differences || pending) process.exitCode = 1
  } finally { handle.dispose() }
}
if (import.meta.main) main().catch((error: unknown) => {
  const kinds = ['Error', 'TypeError', 'SyncFormatError', 'SyncCorruptContentError', 'SyncNetworkError', 'SyncAuthExpiredError']
  const reasons = ['http-401', 'http-403', 'unsupported-version', 'unexpected-content-type', 'streaming-body-required', 'invalid-record', 'invalid-json', 'snapshot-meta-required', 'unsupported-sync-version']
  const kind = error instanceof Error ? kinds.indexOf(error.name) : -1
  const reason = reasons.indexOf((error as { reason?: string })?.reason ?? '')
  console.error(JSON.stringify({ failed: 1, phase, kind, reason })); process.exitCode = 1
})
