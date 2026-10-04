import type { ClientRuntime, Store, OverlayTarget } from '@podium/client-core/engine'
import { dedupeSessionsByResume, type SessionMeta } from '@podium/model'
import type { PendingRows } from '../src/shared/row-source'
import { foldRowOverlays } from '@podium/client-core/engine'
import type { ReplicaRows } from '@podium/client-core/replica'
import { sessionViews, type SessionView } from '@podium/client-core/session-values'

export type ReferenceState<T extends import('@podium/client-core/api').PodiumClientApi = import('@podium/client-core/api').PodiumClientApi> = Store<T> & Omit<{ [K in keyof ReplicaRows]: ReplicaRows[K][] }, 'sessions' | 'repos' | 'machines'> & {
  sessions: SessionView[]
  pendingSpawnIds: ReadonlySet<string>
  pendingSpawnPrompts: Readonly<Record<string, string>>
}
/** Test oracle only. Production has no full record state or publication. */
export function referenceState<T extends import('@podium/client-core/api').PodiumClientApi>(runtime: { readonly access: Store<T>; readonly replica?: ClientRuntime['replica']; readonly principal?: { userId: string } }): ReferenceState<T> {
  const replica = runtime.replica ?? runtime.access.replica
  const log = (runtime as unknown as { poolWriter?: { pending: { byRow(entity: OverlayTarget): PendingRows }; spawnPrompts: ReadonlyMap<string, string> } }).poolWriter
  const read = <K extends keyof ReplicaRows>(kind: K): ReplicaRows[K][] => {
    const rows = replica.rows(kind)
    const pending = (['sessions', 'issueProjections', 'sessionUserStates', 'issueUserStates'].includes(kind) ? log?.pending.byRow(kind as OverlayTarget) : undefined)
    if (!pending?.size) return rows
    const key = (row: ReplicaRows[K]) => kind === 'sessions' ? (row as ReplicaRows['sessions']).sessionId : (row as {id: string}).id
    const out = new Map(rows.map(row => [key(row), row]))
    for (const [id, overlays] of pending) {
      const value = foldRowOverlays(out.get(id), overlays)
      if (value) out.set(id, value as ReplicaRows[K])
      else out.delete(id)
    }
    return [...out.values()]
  }
  const kinds = ['issueProjections','issueUserStates','issueGitStates','issueDeps','issueEvents','pendingInteractions','messageRecords','shipOrders','shipLanes','conversations','automations','automationRuns','sessionUserStates','userLayouts'] as const
  const records = Object.fromEntries(kinds.map(kind => [kind, read(kind)]))
  const sessions = dedupeSessions(sessionViews(read('sessions'), { userId: runtime.principal?.userId ?? 'operator', userStates: read('sessionUserStates'), repos: replica.rows('repos'), machines: replica.rows('machines'), userStatesLoaded: replica.sessionUserStatesLoaded?.() }))
  const prompts = log?.spawnPrompts ?? new Map<string,string>()
  return { ...runtime.access, ...records, sessions, pendingSpawnIds: new Set(prompts.keys()), pendingSpawnPrompts: Object.fromEntries(prompts) } as ReferenceState<T>
}

export function dedupeSessions<T extends SessionMeta>(rows: T[]): T[] {
  return rows.length === 0 ? rows : dedupeSessionsByResume(rows)
}

export function watchReference(owner: ClientRuntime, changed: () => void): () => void {
  const stops = [owner.onLocals(Object.keys(owner.access).filter(key => !Object.hasOwn(owner.services, key)) as import('@podium/client-core/engine').LocalKey[], changed), owner.replica.subscribeRowBatch!(changed)]
  return () => stops.forEach(stop => stop())
}
