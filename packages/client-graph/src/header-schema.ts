import type { ConnectionHealth } from '@podium/client-core/socket-transport'
import type { Store } from '@podium/client-core/engine'
import type { HostMetricsWire, MachineQuotaWire, MachineWire } from '@podium/model/browser'

/** Pool-only extension. The prototype's frozen EntityName and SCHEMA stay four
 * entities. Samples are separate rows, so sampling cannot invalidate machines,
 * sessions, quota, or window state. All extension relations are declared here. */
export interface HeaderRows {
  machine: MachineWire
  hostMetric: HostMetricsWire
  quota: MachineQuotaWire
  connection: ConnectionHealth
  window: Pick<Store, 'view' | 'paneA' | 'fileTabs' | 'outboxSize' | 'shipOrders'>
}
export type HeaderEntity = keyof HeaderRows
export interface HeaderRecord<E extends HeaderEntity = HeaderEntity> {
  kind: E
  id: string
  value: HeaderRows[E] | undefined
}

export const HEADER_SCHEMA = {
  machine: { key: 'id', source: 'engine:machines', model: 'MachineWire', cold: 'never' },
  hostMetric: { key: 'machineId ?? hostname', source: 'runtime:hostMetrics', model: 'HostMetricsWire', cold: 'never' },
  quota: { key: 'machineId', source: 'api:quota.summary', model: 'MachineQuotaWire', cold: 'never' },
  connection: { key: 'server', source: 'hub:connectionHealth', model: 'ConnectionHealth', cold: 'never' },
  window: { key: 'window', source: 'engine:locals', fields: ['view', 'paneA', 'fileTabs', 'outboxSize', 'shipOrders'], cold: 'never' },
} as const satisfies Record<HeaderEntity, object>

/** belongsTo and inverse hasMany use one generic maintenance path. Session
 * edges index resident rows only; cold session detail uses the pool loader. */
export const HEADER_RELATIONS = [
  { from: 'session', name: 'machine', key: 'machineId', to: 'machine', inverse: 'sessions' },
  { from: 'hostMetric', name: 'machine', key: 'machineId', to: 'machine', inverse: 'metrics' },
  { from: 'quota', name: 'machine', key: 'machineId', to: 'machine', inverse: 'quotas' },
] as const

export function isHeaderEntity(entity: string): entity is HeaderEntity {
  return Object.hasOwn(HEADER_SCHEMA, entity)
}

/** Declared summaries for unloaded rows used by reclaim counts and the rail. */
export const HEADER_ISSUE_SUMMARY_FIELDS = ['worktreePath', 'closedAt', 'closedReason', 'machineId', 'repoId', 'seq'] as const
export const HEADER_SESSION_SUMMARY_FIELDS = ['cwd', 'machineId', 'archived'] as const
