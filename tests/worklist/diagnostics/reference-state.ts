import type { ClientRuntime, OverlayTarget, Store } from '@podium/client-core/engine'
import { foldRowOverlays } from '@podium/client-core/engine'
import type { ReplicaRows } from '@podium/client-core/replica'
import { type SessionView, sessionViews } from '@podium/client-core/session-values'
import {
  type ReferenceCommandAccess,
  referenceCommandAccess,
} from '@podium/client-core/test-support/reference-commands'
import type { PendingRows } from '@podium/client-graph/shared/row-source'
import type { IssueProjection } from '@podium/model'
import {
  dedupeSessionsByResume,
  repositoriesFromCheckouts,
  type SessionMeta,
  serverMoveEligibilityOf,
} from '@podium/model'
import { compareShallow, reaction, runInAction } from 'mobx'

export type ReferenceState<
  T extends
    import('@podium/client-core/api').PodiumClientApi = import('@podium/client-core/api').PodiumClientApi,
> = Store<T> &
  ReferenceCommandAccess<T> &
  Omit<{ [K in keyof ReplicaRows]: ReplicaRows[K][] }, 'sessions' | 'repos' | 'machines'> & {
    coarseNow: number
    sessions: SessionView[]
    /** Test inputs and oracle answers in the listing shape (POD-6644): the
     *  registered repositories (from checkout records) and my machines. */
    repos: import('@podium/model').CheckoutRepository[]
    machines: import('@podium/model').MachineFacts[]
    pendingSpawnIds: ReadonlySet<string>
    pendingSpawnPrompts: Readonly<Record<string, string>>
  }
const fixtureClocks = new WeakMap<object, () => number>()
export function setReferenceClock(runtime: object, read: () => number): void {
  fixtureClocks.set(runtime, read)
}

/** Test oracle only. Production has no full record state or publication. */
export function referenceState<T extends import('@podium/client-core/api').PodiumClientApi>(
  runtime: {
    readonly access: Store<T>
    readonly root?: import('@podium/client-core/runtime-root').RuntimeRoot<T>
    readonly replica?: ClientRuntime['root']['replica']
    readonly principal?: { userId: string }
  },
  options: { screen?: boolean } = {},
): ReferenceState<T> {
  return runInAction(() => {
    const access = runtime.access
    const replica: ClientRuntime['root']['replica'] | undefined =
      runtime.root?.replica ?? runtime.replica ?? Reflect.get(access, 'replica')
    // Plain component fixtures already supply their reference records.
    if (!replica?.rows) return access as unknown as ReferenceState<T>
    const userId = runtime.principal?.userId ?? 'operator'
    const log = (
      runtime as unknown as {
        poolWriter?: {
          pending: { byRow(entity: OverlayTarget): PendingRows }
          spawnPrompts: ReadonlyMap<string, string>
        }
      }
    ).poolWriter
    const read = <K extends keyof ReplicaRows>(kind: K): ReplicaRows[K][] => {
      const rows = replica.rows(kind)
      const pending = [
        'sessions',
        'issueProjections',
        'sessionUserStates',
        'issueUserStates',
      ].includes(kind)
        ? log?.pending.byRow(kind as OverlayTarget)
        : undefined
      if (!pending) return rows
      const key = (row: ReplicaRows[K]) =>
        kind === 'sessions' || kind === 'sessionUserStates'
          ? (row as { sessionId: string }).sessionId
          : kind === 'issueUserStates'
            ? (row as { entityId: string }).entityId
            : (row as { id: string }).id
      const out = new Map(rows.map((row) => [key(row), row]))
      for (const id of pending.keys()) {
        const overlays = pending.get(id)!
        const base =
          out.get(id) ??
          (kind === 'issueUserStates'
            ? { userId, entityId: id, readAt: null, tuckedAt: null }
            : kind === 'sessionUserStates'
              ? { userId, sessionId: id, readAt: null, snoozedUntil: null }
              : undefined)
        const value = foldRowOverlays(base, overlays)
        if (value) out.set(id, value as ReplicaRows[K])
        else out.delete(id)
      }
      return [...out.values()]
    }
    const kinds = [
      'issueProjections',
      'issueUserStates',
      'issueGitStates',
      'issueDeps',
      'issueEvents',
      'pendingInteractions',
      'messageRecords',
      'shipOrders',
      'shipLanes',
      'conversations',
      'automations',
      'automationRuns',
      'sessionUserStates',
      'userLayouts',
      'superagentThreads',
    ] as const
    const records = Object.fromEntries(kinds.map((kind) => [kind, read(kind)]))
    const sessions = dedupeSessions(
      sessionViews(read('sessions'), {
        userId,
        userStates: read('sessionUserStates'),
        repos: replica.rows('repos'),
        machines: replica.rows('machines'),
        userStatesLoaded: replica.sessionUserStatesLoaded?.(),
      }),
    )
    const prompts = log?.spawnPrompts ?? new Map<string, string>()
    // Machines and repositories are records (POD-6644): my machines joined with
    // my access rows, and the repositories derived from the checkouts.
    const live =
      runtime.root?.live ??
      (
        runtime as {
          live?: {
            conditionOf(id: string): { known: boolean; value?: { online: boolean } } | undefined
          }
        }
      ).live
    const access_ = new Map(
      replica.rows('machineAccess').map((row) => [String(row.machineId), row]),
    )
    const machines = replica.rows('machines').flatMap((machine) => {
      const mine = access_.get(String(machine.id))
      if (!mine) return []
      const { userId: _userId, machineId: _machineId, ...mineFacts } = mine
      // Online and presence are the LiveStore's condition (unknown reads offline).
      const reading = live?.conditionOf(String(machine.id))
      const condition = reading?.known ? reading.value : undefined
      const { since: _since, ...presence } = (condition ?? { online: false }) as Record<
        string,
        unknown
      >
      return [
        {
          ...mineFacts,
          ...machine,
          ...presence,
          id: machine.id,
          online: condition?.online === true,
          serverMoveEligibility: serverMoveEligibilityOf(
            { ...mineFacts, ...machine },
            condition?.online === true,
          ),
        },
      ]
    })
    const repos = [...repositoriesFromCheckouts(replica.rows('checkouts'))]
    return {
      ...(options.screen === false ? {} : access),
      ...(runtime.root ? referenceCommandAccess(runtime.root) : {}),
      coarseNow: fixtureClocks.get(runtime)?.() ?? Date.now(),
      ...records,
      repos,
      machines,
      sessions,
      pendingSpawnIds: new Set(prompts.keys()),
      pendingSpawnPrompts: Object.fromEntries(prompts),
    } as unknown as ReferenceState<T>
  })
}

export function dedupeSessions<T extends SessionMeta>(rows: T[]): T[] {
  return rows.length === 0 ? rows : dedupeSessionsByResume(rows)
}

export function watchReference(owner: ClientRuntime, changed: () => void): () => void {
  const stops = [
    reaction(() => Object.values(owner.ui.screen), changed, { equals: compareShallow }),
    owner.root.replica.subscribeRowBatch!(changed),
  ]
  return () =>
    stops.forEach((stop) => {
      stop()
    })
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
