import type { ScreenState } from '@podium/client-core/ui'
import type { GitRepositoryWire } from '@podium/model/browser'
import type { ShipOrderProjection } from '@podium/model/shipping-projection'
import type { PoolRows } from './pool'

/** Header source declarations. Machine storage is the shared schema table.
 * Live readings (host metrics, quota, the connection) are LiveStore
 * conditions (POD-5798), read through the machine model and the store, never
 * copied into rows here. All extension relations are declared here. */
export interface HeaderRows {
  /** The machine record joined with my access row; a fact not mine is absent. */
  machine: Pick<PoolRows['machine'], 'id' | 'name'> & Partial<PoolRows['machine']>
  /** A registered repository and its worktrees, from the checkout records. */
  repository: GitRepositoryWire
  shipOrder: ShipOrderProjection
  window: Pick<ScreenState, 'view' | 'paneA' | 'fileTabs'>
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
  machine: { key: 'id', source: 'replica:machines', model: 'MachineProjection', cold: 'never' },
  repository: {
    key: 'machineId,path',
    source: 'replica:checkouts',
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
    source: 'ui:screen',
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
