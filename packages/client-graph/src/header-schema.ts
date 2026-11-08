import type { Store } from '@podium/client-core/engine'
import type { MachineWire } from '@podium/model/browser'
import type { ShipOrderProjection } from '@podium/model/shipping-projection'

/** Header source declarations. Machine storage is the shared schema table.
 * Live readings (host metrics, quota, the connection) are LiveStore
 * conditions (POD-5798), read through the machine model and the store, never
 * copied into rows here. All extension relations are declared here. */
export interface HeaderRows {
  machine: MachineWire
  repository: Store['repos'][number]
  shipOrder: ShipOrderProjection
  window: Pick<Store, 'view' | 'paneA' | 'fileTabs'>
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
    revisionFields: { paths: 'path' },
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
  window: {
    key: 'window',
    source: 'engine:locals',
    fields: ['view', 'paneA', 'fileTabs'],
    cold: 'never',
  },
} as const satisfies Record<HeaderEntity, object>

/** belongsTo and inverse hasMany use one generic maintenance path. Session
 * edges index resident rows only; cold session detail uses the pool loader. */
export const HEADER_RELATIONS = [
  { from: 'session', name: 'machine', key: 'machineId', to: 'machine', inverse: 'sessions' },
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
