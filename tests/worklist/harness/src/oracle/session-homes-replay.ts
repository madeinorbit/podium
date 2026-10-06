import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
/** S2 operator evidence. Read-only, ludovico only, input stays in memory.
 * Run with a timeout and emit counts/opaque ids only; never print errors/rows. */
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { HttpBootstrapSource } from '@podium/client-core/sync-stream'
import { sessionValues, sessionViews } from '@podium/client-core/session-values'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { sessionUserStateRowId, type GitRepositoryWire, type MachineWire } from '@podium/model'
import { createWorklistPool } from '@podium/client-graph/create'
import { createRowSource } from '../../../shared/src/row-source'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { poolSidebarSnapshot } from '@podium/client-graph/diagnostics/sidebar-check'
import { runInAction } from 'mobx'
import { ScenarioCache, seedCacheFromCorpus } from '../../../shared/src/scenarios'
import { corpusFromLive, type LiveCollections } from '../fixture/live-snapshot'
import { fixtureSessionHomes, stripSessionLegacy } from '../fixture/session-homes'
import { sidebarReplayStore } from './sidebar-replay'
import { snapshotFromStore } from './oracle'


async function main() {
  if (hostname() !== 'ludovico') throw new Error('Restricted host')
  const origin =
    process.argv.find((arg) => arg.startsWith('--origin='))?.slice(9) ?? 'http://127.0.0.1:18787'
  const { token } = JSON.parse(
    readFileSync(join(homedir(), '.podium/cli-session.json'), 'utf8'),
  ) as { token: string }
  const cookie = `podium_session=${token}`
  const query = async <T>(path: string, input: object = {}): Promise<T> => {
    const response = await fetch(
      `${origin}/trpc/${path}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: input }))}`,
      {
        headers: { cookie },
        signal: AbortSignal.timeout(30000),
      },
    )
    const body = (await response.json()) as { result?: { data: T } }[]
    if (!response.ok || !body[0]?.result) throw new Error('Read failed')
    return body[0].result.data
  }
  const byEntity = new Map<string, Map<string, unknown>>()
  const counts: Record<string, number> = {}
  const source = new HttpBootstrapSource({
    origin,
    streamingFetch: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.timeout(60000),
          headers: { ...(init.headers as object), cookie },
        }),
    },
  })
  for await (const chunk of source.bootstrap())
    for (const change of chunk.changes) {
      counts[change.entity] = (counts[change.entity] ?? 0) + 1
      let rows = byEntity.get(change.entity)
      if (!rows) {
        rows = new Map()
        byEntity.set(change.entity, rows)
      }
      if (change.op === 'upsert') rows.set(change.entityId, change.payload)
      else rows.delete(change.entityId)
    }
  const rows = <T>(kind: string): T[] => [...(byEntity.get(kind)?.values() ?? [])] as T[]
  const [machines, pins] = await Promise.all([
    query<MachineWire[]>('machines.list'),
    query<LiveCollections['pins']>('pins.list'),
  ])
  const scans = await Promise.all(
    machines.map((machine) =>
      query<{ repositories?: GitRepositoryWire[] } | null>('discovery.lastMachineScan', {
        machineId: machine.id,
      }),
    ),
  )
  const operationalRepos = scans.flatMap((scan) => scan?.repositories ?? [])
  const raw = {
    issues: rows('issue'),
    issueProjections: rows('issueProjection'),
    sessions: rows('session'),
    repoProjections: rows('repo'),
    issueDeps: rows('issueDep'),
    repos: operationalRepos,
    machines,
    pins,
  } as LiveCollections
  const corpus = corpusFromLive(raw, Date.now())
  // Use persisted registry roots if no finished machine scan is available.
  if (!corpus.repos.length)
    corpus.repos = corpus.repoProjections
      .filter((repo) => repo.repoPath)
      .map(
        (repo) =>
          ({
            path: repo.repoPath!,
            repoId: repo.id,
            worktrees: [],
            machines: [],
          }) as unknown as GitRepositoryWire,
      )
  const nativeUserId = rows<{ userId: string }>('sessionUserState')[0]?.userId
  const homes = fixtureSessionHomes(corpus, nativeUserId ?? 'operator')
  const userId = homes.userId
  // Native kinds win if the running server already publishes S1. An older
  // server gets a separate, explicitly labelled in-memory fixture upgrade.
  const nativeUsers = rows<(typeof homes.userStates)[number]>('sessionUserState')
  const nativeMachines = rows<(typeof homes.machines)[number]>('machine')
  const upgraded = {
    ...homes,
    userStates: nativeUsers.length ? nativeUsers : homes.userStates,
    machines: nativeMachines.length ? nativeMachines : homes.machines,
  }
  function replay(stripped: boolean) {
    const sessions = stripped ? upgraded.sessions.map(stripSessionLegacy) : upgraded.sessions
    const cache: ScenarioCache = seedCacheFromCorpus({ ...corpus, sessions })
    for (const state of upgraded.userStates)
      cache.put('sessionUserState', sessionUserStateRowId(state.userId, state.sessionId), state)
    for (const machine of upgraded.machines) cache.put('machine', machine.id, machine)
    const replica = createKernelReplica({
      cache,
      side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    })
    const store = {
      ...sidebarReplayStore(corpus, replica),
      sessions: sessionViews(replica.rows('sessions'), { ...upgraded, userId }),
    }
    const runtime = withKeyedInputs({
      principal: { userId },
      getSnapshot: () => store,
      subscribe: () => () => {},

    })
    const feed = createRowSource(runtime, replica, { mode: 'pooled' })
    const locals = createEngineLocals(runtime)
    const handle = createWorklistPool(feed.source, locals.source)
    try {
      let sidebar: ReturnType<typeof poolSidebarSnapshot> | undefined
      for (let round = 0; round < 64; round++) {
        sidebar = runInAction(() => poolSidebarSnapshot(handle.pool))
        if (!handle.pool.hydrate()) break
      }
      return {
        values: store.sessions.map((row) => ({ id: row.sessionId, ...sessionValues(row) })),
        graph: feed.source
          .snapshot('session')
          .map((record) => ({ id: record.id, ...sessionValues(record.value as never) })),
        models: snapshotFromStore(store, { selectedIssueId: null, coarseNow: corpus.fixedNow }),
        sidebar,
      }
    } finally {
      handle.dispose()
      feed.dispose()
      locals.dispose()
    }
  }
  const before = replay(false),
    after = replay(true)
  const valueDifferences = before.values.filter(
    (row, index) => !isDeepStrictEqual(row, after.values[index]),
  ).length
  const graphDifferences = before.graph.filter(
    (row, index) => !isDeepStrictEqual(row, after.graph[index]),
  ).length
  const modelDifferences = isDeepStrictEqual(before.models, after.models) ? 0 : 1
  const sidebarDifferences = isDeepStrictEqual(before.sidebar, after.sidebar) ? 0 : 1
  const fallbackDifferences = sessionViews(corpus.sessions, {
    userId,
    userStates: [],
    repos: [],
    machines: [],
  }).filter((row, index) => row !== corpus.sessions[index]).length
  console.log(
    JSON.stringify({
      inputKindCounts: counts,
      sessions: corpus.sessions.length,
      issues: corpus.issues.length,
      inMemoryUpgradeCounts: {
        userStates: nativeUsers.length ? 0 : homes.userStates.length,
        machines: nativeMachines.length ? 0 : homes.machines.length,
      },
      valueDifferences,
      graphDifferences,
      modelDifferences,
      sidebarDifferences,
      fallbackDifferences,
      differingIds: before.values
        .filter((row, index) => !isDeepStrictEqual(row, after.values[index]))
        .slice(0, 20)
        .map((row) => row.id),
    }),
  )
  if (
    valueDifferences ||
    graphDifferences ||
    modelDifferences ||
    sidebarDifferences ||
    fallbackDifferences
  )
    process.exitCode = 1
}
if (import.meta.main)
  main().catch(() => {
    console.log(JSON.stringify({ replayFailed: 1 }))
    process.exitCode = 1
  })
