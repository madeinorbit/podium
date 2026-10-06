import { allIssueViewModels } from '../../../../tests/worklist/diagnostics/reference/issue-view-models'
/** Convert older test inputs at the fixture boundary, then exercise real joins. */

import { createReplicaFixture } from '@podium/client-core/test-support/replica'
import type {
  IssueGitStateProjection,
  IssueProjection,
  IssueUserStateWire,
  RepoProjection,
  SessionMeta,
} from '@podium/model'
import { actorUser, asUserId } from '@podium/model'

type FixtureStore = {
  issues?: readonly unknown[]
  sessions?: readonly unknown[]
  repos?: readonly { path: string; repoId?: string | null }[]
}
const cache = new WeakMap<
  object,
  { sessions: readonly unknown[] | undefined; value: ReturnType<typeof make> }
>()

function make(store: FixtureStore) {
  const replica = createReplicaFixture()
  const repos = new Map<string, RepoProjection>()
  const projections: IssueProjection[] = []
  const markers: IssueUserStateWire[] = []
  const git: IssueGitStateProjection[] = []
  const deps: Array<{ id: string; fromId: string; toId: string; type: string }> = []
  // Historical fixtures sometimes supplied only a precomputed unread flag.
  // Materialize a marker at their latest activity instead of carrying that flag.
  const latestActivity = [...(store.issues ?? []), ...(store.sessions ?? [])].reduce<string>(
    (latest, value) => {
      const row = value as Record<string, unknown>
      const stamp =
        [row.updatedAt, row.lastActiveAt, row.createdAt]
          .filter((value): value is string => typeof value === 'string')
          .sort()
          .at(-1) ?? ''
      return stamp > latest ? stamp : latest
    },
    '',
  )
  for (const row of store.issues ?? []) {
    // biome-ignore lint/suspicious/noExplicitAny: one test-only adapter accepts historical synthetic input shapes
    const input = row as Record<string, any>
    const {
      readAt,
      tuckedAt,
      pinned,
      gitState,
      repoPath,
      prefix,
      humanQuestion,
      humanQuestionOptions,
      humanQuestionAskedAt,
      humanQuestionAskedBy,
      origin,
      draft,
      deps: outgoing,
      dependents: _incoming,
      comments: _comments,
      sessions: _sessions,
      sessionSummary: _summary,
      unread: _unread,
      ready: _ready,
      blocked: _blocked,
      deferred: _deferred,
      childCount: _children,
      childDoneCount: _doneChildren,
      memberSessionIds: _members,
      ...durable
    } = input
    const repoId =
      input.repoId ??
      store.repos?.find((repo) => repo.path === repoPath)?.repoId ??
      repoPath ??
      'fixture-repo'
    const refPrefix =
      prefix ?? /^(.+)-\d+$/.exec(input.displayRef ?? '')?.[1] ?? repos.get(repoId)?.prefix
    repos.set(repoId, { id: repoId, repoPath: repoPath ?? '', prefix: refPrefix } as RepoProjection)
    // Explicit undefined exercises historical absence instead of fixture defaults.
    projections.push({
      ...durable,
      owner: 'owner' in durable ? durable.owner : asUserId('fixture-user'),
      visibility: 'visibility' in durable ? durable.visibility : 'personal',
      createdBy:
        'createdBy' in durable
          ? durable.createdBy
          : {
              actor: actorUser(asUserId('fixture-user')),
              onBehalfOf: asUserId('fixture-user'),
            },
      repoId,
      description:
        typeof input.description === 'string'
          ? { value: input.description }
          : (input.description ?? { value: '' }),
      notes: typeof input.notes === 'string' ? { value: input.notes } : input.notes,
      intentOrigin: input.intentOrigin ?? origin ?? 'human',
      isDraftVessel: input.isDraftVessel ?? draft ?? false,
      asked:
        input.asked ??
        (humanQuestion
          ? {
              question: humanQuestion,
              options: humanQuestionOptions,
              at: humanQuestionAskedAt,
              by: humanQuestionAskedBy,
            }
          : undefined),
    } as IssueProjection)
    markers.push({
      userId: 'fixture-user',
      entityId: input.id,
      readAt: readAt ?? (input.unread === false ? latestActivity || null : null),
      tuckedAt: tuckedAt ?? null,
      pinned: pinned ?? false,
    } as IssueUserStateWire)
    if (gitState) git.push({ ...gitState, id: input.id })
    for (const dep of outgoing ?? [])
      deps.push({
        id: `dep:${input.id}:${dep.id}:${dep.type}`,
        fromId: input.id,
        toId: dep.id,
        type: dep.type,
      })
  }
  replica.applySnapshot('repos', [...repos.values()])
  replica.applySnapshot('issueProjections', projections)
  replica.applySnapshot('issueUserStates', markers)
  replica.applySnapshot('issueGitStates', git)
  replica.applySnapshot('issueDeps', deps as never)
  replica.applySnapshot('sessions', (store.sessions ?? []) as SessionMeta[])
  return { replica, issueProjections: projections, issueUserStates: markers, issueGitStates: git }
}

/** The store's retained issue rows stay empty, including in published slices. */
export function poolFixtureStore<T extends FixtureStore>(
  store: T,
): T & ReturnType<typeof make> {
  const key = store.issues ?? store
  let hit = cache.get(key)
  if (!hit || hit.sessions !== store.sessions) {
    hit = { sessions: store.sessions, value: make(store) }
    cache.set(key, hit)
  }
  return { ...store, issues: [], ...hit.value }
}

export function poolFixtureIssues(store: FixtureStore) {
  const normalized = poolFixtureStore(store)
  return allIssueViewModels(normalized.replica, normalized.issueProjections, normalized.issueUserStates)
}
