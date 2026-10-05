import type { Store } from '@podium/client-core/engine'
import type { ConnectionHealth } from '@podium/client-core/socket-transport'
import type { HostMetricsWire, MachineQuotaWire, MachineWire } from '@podium/model/browser'
import type { ShipOrderProjection } from '@podium/model/shipping-projection'

/** Pool-only extension. The prototype's frozen EntityName and SCHEMA stay four
 * entities. Samples are separate rows, so sampling cannot invalidate machines,
 * sessions, quota, or window state. All extension relations are declared here. */
export interface HeaderRows {
  machine: MachineWire
  repository: Store['repos'][number]
  hostMetric: HostMetricsWire
  quota: MachineQuotaWire
  connection: ConnectionHealth
  shipOrder: ShipOrderProjection
  history: {
    sampledAt: string
    bucketMs: number
    peak: number
    buckets: { start: string; count: number }[]
  }
  lifecycle: Awaited<ReturnType<Store['trpc']['settings']['get']['query']>>
  window: Pick<Store, 'view' | 'paneA' | 'fileTabs' | 'outboxSize'>
}
export type HeaderEntity = keyof HeaderRows
export interface ShippingCounts {
  readonly unfinishedCount: number
  readonly decisionCount: number
}
export interface HeaderRecord<E extends HeaderEntity = HeaderEntity> {
  kind: E
  id: string
  value: HeaderRows[E] | undefined
}

export const HEADER_SCHEMA = {
  machine: { key: 'id', source: 'engine:machines', model: 'MachineWire', cold: 'never' },
  repository: {
    key: 'machineId,path',
    source: 'engine:repos',
    model: 'GitRepositoryWire',
    cold: 'never',
  },
  hostMetric: {
    key: 'machineId ?? hostname',
    source: 'runtime:hostMetrics',
    model: 'HostMetricsWire',
    cold: 'never',
  },
  quota: {
    key: 'machineId',
    source: 'api:quota.summary',
    model: 'MachineQuotaWire',
    cold: 'never',
  },
  shipOrder: {
    key: 'id',
    source: 'replica:shipOrders',
    model: 'ShipOrderProjection',
    cold: 'never',
    counts: {
      by: 'repoId',
      unfinished: ['needs_you', 'in_progress', 'waiting'],
      decision: 'needs_you',
    },
  },
  history: { key: 'fleet', source: 'api:sessions.concurrencyHistory', cold: 'never' },
  lifecycle: { key: 'hosts', source: 'api:settings.get', cold: 'never' },
  connection: {
    key: 'server',
    source: 'hub:connectionHealth',
    model: 'ConnectionHealth',
    cold: 'never',
  },
  window: {
    key: 'window',
    source: 'engine:locals',
    fields: ['view', 'paneA', 'fileTabs', 'outboxSize'],
    cold: 'never',
  },
} as const satisfies Record<HeaderEntity, object>

/** belongsTo and inverse hasMany use one generic maintenance path. Session
 * edges index resident rows only; cold session detail uses the pool loader. */
export const HEADER_RELATIONS = [
  { from: 'session', name: 'machine', key: 'machineId', to: 'machine', inverse: 'sessions' },
  { from: 'hostMetric', name: 'machine', key: 'machineId', to: 'machine', inverse: 'metrics' },
  { from: 'quota', name: 'machine', key: 'machineId', to: 'machine', inverse: 'quotas' },
  { from: 'repository', name: 'repo', key: 'repoId', to: 'repo', inverse: 'scans' },
] as const

export function isHeaderEntity(entity: string): entity is HeaderEntity {
  return Object.hasOwn(HEADER_SCHEMA, entity)
}

/** Declared summaries for unloaded rows used by reclaim counts and the rail. */
export const HEADER_ISSUE_SUMMARY_FIELDS = [
  'worktreePath',
  'closedAt',
  'closedReason',
  'machineId',
  'repoId',
  'seq',
] as const
export const HEADER_SESSION_SUMMARY_FIELDS = [
  'sessionId',
  'cwd',
  'machineId',
  'archived',
  'status',
  'lastActiveAt',
  'agentState',
  'title',
  'name',
  'displayRef',
  'agentKind',
  'resumable',
] as const
