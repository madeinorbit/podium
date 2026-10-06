import type { IssueProjection } from '@podium/model'
import type { ClientRuntime, Store, OverlayTarget } from '@podium/client-core/engine'
import { dedupeSessionsByResume, type SessionMeta } from '@podium/model'
import type { PendingRows } from '@podium/client-graph/shared/row-source'
import { foldRowOverlays } from '@podium/client-core/engine'
import type { ReplicaRows } from '@podium/client-core/replica'
import { sessionViews, type SessionView } from '@podium/client-core/session-values'
import { runInAction } from 'mobx'

export type ReferenceState<T extends import('@podium/client-core/api').PodiumClientApi = import('@podium/client-core/api').PodiumClientApi> = Store<T> & Omit<{ [K in keyof ReplicaRows]: ReplicaRows[K][] }, 'sessions' | 'repos' | 'machines'> & {
  sessions: SessionView[]
  pendingSpawnIds: ReadonlySet<string>
  pendingSpawnPrompts: Readonly<Record<string, string>>
}
/** Test oracle only. Production has no full record state or publication. */
export function referenceState<T extends import('@podium/client-core/api').PodiumClientApi>(runtime: { readonly access: Store<T>; readonly replica?: ClientRuntime['replica']; readonly principal?: { userId: string } }): ReferenceState<T> {
  return runInAction(() => {
  const access = runtime.access
  const replica = runtime.replica ?? access.replica
  // Plain component fixtures already supply their reference records.
  if (!replica?.rows) return access as unknown as ReferenceState<T>
  const userId = runtime.principal?.userId ?? 'operator'
  const log = (runtime as unknown as { poolWriter?: { pending: { byRow(entity: OverlayTarget): PendingRows }; spawnPrompts: ReadonlyMap<string, string> } }).poolWriter
  const read = <K extends keyof ReplicaRows>(kind: K): ReplicaRows[K][] => {
    const rows = replica.rows(kind)
    const pending = (['sessions', 'issueProjections', 'sessionUserStates', 'issueUserStates'].includes(kind) ? log?.pending.byRow(kind as OverlayTarget) : undefined)
    if (!pending) return rows
    const key = (row: ReplicaRows[K]) =>
      kind === 'sessions' || kind === 'sessionUserStates' ? (row as { sessionId: string }).sessionId
        : kind === 'issueUserStates' ? (row as { entityId: string }).entityId : (row as { id: string }).id
    const out = new Map(rows.map(row => [key(row), row]))
    for (const id of pending.keys()) {
      const overlays = pending.get(id)!
      const base = out.get(id) ?? (kind === 'issueUserStates'
        ? { userId, entityId: id, readAt: null, tuckedAt: null, pinned: false }
        : kind === 'sessionUserStates' ? { userId, sessionId: id, readAt: null, snoozedUntil: null } : undefined)
      const value = foldRowOverlays(base, overlays)
      if (value) out.set(id, value as ReplicaRows[K])
      else out.delete(id)
    }
    return [...out.values()]
  }
  const kinds = ['issueProjections','issueUserStates','issueGitStates','issueDeps','issueEvents','pendingInteractions','messageRecords','shipOrders','shipLanes','conversations','automations','automationRuns','sessionUserStates','userLayouts'] as const
  const records = Object.fromEntries(kinds.map(kind => [kind, read(kind)]))
  const sessions = dedupeSessions(sessionViews(read('sessions'), { userId, userStates: read('sessionUserStates'), repos: replica.rows('repos'), machines: replica.rows('machines'), userStatesLoaded: replica.sessionUserStatesLoaded?.() }))
  const prompts = log?.spawnPrompts ?? new Map<string,string>()
  return { ...access, ...records, sessions, pendingSpawnIds: new Set(prompts.keys()), pendingSpawnPrompts: Object.fromEntries(prompts) } as unknown as ReferenceState<T>
  })
}

export function dedupeSessions<T extends SessionMeta>(rows: T[]): T[] {
  return rows.length === 0 ? rows : dedupeSessionsByResume(rows)
}

export function watchReference(owner: ClientRuntime, changed: () => void): () => void {
  const stops = [owner.onLocals(Object.keys(owner.access).filter(key => !Object.hasOwn(owner.services, key)) as import('@podium/client-core/engine').LocalKey[], changed), owner.replica.subscribeRowBatch!(changed)]
  return () => stops.forEach(stop => stop())
}

export function issueActivityAt(
  issue: Pick<IssueProjection, 'id' | 'updatedAt'>,
  sessions: SessionView[],
  issues: readonly Pick<IssueProjection, 'id' | 'parentId' | 'updatedAt'>[] = [],
): string {
  const subtree = new Set<string>([issue.id])
  let grew = true
  while (grew) {
    grew = false
    for (const other of issues) {
      if (other.parentId && subtree.has(other.parentId) && !subtree.has(other.id)) {
        subtree.add(other.id)
        grew = true
      }
    }
  }
  let latest = issue.updatedAt
  for (const other of issues) {
    if (subtree.has(other.id) && other.updatedAt > latest) latest = other.updatedAt
  }
  for (const session of sessions) {
    if (session.issueId && subtree.has(session.issueId) && session.lastActiveAt > latest) {
      latest = session.lastActiveAt
    }
  }
  return latest
}
