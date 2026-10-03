/** Read-only replay restricted to ludovico. Cookies, records, comparison values
 * and native error messages stay in memory; only counts and positions leave. */

import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { PodiumClientApi } from '@podium/client-core/api'
import { dedupeSessions, type Store } from '@podium/client-core/engine'
import {
  allIssueViewModels,
  createKernelReplica,
  createSideCache,
  memoryStorage,
} from '@podium/client-core/replica'
import { sessionViews } from '@podium/client-core/session-values'
import { NdjsonLineReader, readSyncStream, SyncStreamFailed } from '@podium/client-core/sync-stream'
import { missionRootFor } from '@podium/client-core/viewmodels'
import { ISSUE_STATUS_LABELS } from '@podium/model/browser'
import { CLIENT_WIRE_VERSION } from '@podium/protocol'
import { reaction, runInAction } from 'mobx'
import {
  corpusFromLive,
  type LiveCollections,
} from '../../worklist-proto/harness/src/fixture/live-snapshot'
import { sidebarReplayStore } from '../../worklist-proto/harness/src/oracle/sidebar-replay'
import { ScenarioCache } from '../../worklist-proto/shared/src/scenarios'
import { attachMobileScreens } from '../src/mobile-screens'
import { MOBILE_SCREEN_SUMMARIES } from '../src/mobile-screens-schema'
import { createRuntimeWorklistPool } from '../src/runtime-pool'
import type { MobileLegacyReads, MobileScreenCheck } from './mobile-screens-check'

interface ReplayLoader {
  onLoad(options: { filter: RegExp }, load: () => { contents: string; loader: 'js' }): void
}
const { plugin } = (
  globalThis as unknown as {
    Bun: { plugin(options: { name: string; setup(build: ReplayLoader): void }): void }
  }
).Bun

let phase = 0
async function main() {
  if (hostname() !== 'ludovico') throw new Error('Replay is restricted to ludovico')
  // The actual legacy phone board imports its label through a native palette.
  // Supply that palette's identical model labels in this CLI process only;
  // the board, filtering, proposal and session-selection code stays actual.
  plugin({
    name: 'phone-labels-without-native-renderer',
    setup(build) {
      build.onLoad({ filter: /apps\/mobile\/src\/theme\/stage\.ts$/ }, () => ({
        contents: `export const STAGE_LABEL = ${JSON.stringify(ISSUE_STATUS_LABELS)}`,
        loader: 'js',
      }))
    },
  })
  const { checkMobileScreens, poolMobileScreensSnapshot } = await import('./mobile-screens-check')
  const [selection, screening, board] = await Promise.all(
    ['mission-session', 'screening', 'task-board'].map(
      (name) => import(new URL(`../../../apps/mobile/src/lib/${name}.ts`, import.meta.url).href),
    ),
  )
  const legacy: MobileLegacyReads = {
    mostRelevantSession: selection.mostRelevantSession,
    buildScreeningQueue: screening.buildScreeningQueue,
    taskBoardSections: board.taskBoardSections,
    taskBoardProgress: board.taskBoardProgress,
  }
  const origin =
    process.argv.find((arg) => arg.startsWith('--origin='))?.slice(9) ?? 'http://127.0.0.1:18787'
  phase = 1
  const { token } = JSON.parse(
    readFileSync(join(homedir(), '.podium/cli-session.json'), 'utf8'),
  ) as { token: string }
  const cookie = `podium_session=${token}`
  const cache = new ScenarioCache(),
    byEntity = new Map<string, unknown[]>()
  const response = await fetch(`${origin}/sync/bootstrap`, {
    headers: { cookie },
    signal: AbortSignal.timeout(120000),
  })
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get('content-type')?.startsWith('application/x-ndjson')
  )
    throw new Error('Bootstrap unavailable')
  let operatorWireVersion = 0
  async function* fixtureLines() {
    for await (const line of NdjsonLineReader(response.body!)) {
      const record = JSON.parse(line)
      if (record.type === 'syncMeta') {
        operatorWireVersion = record.wireVersion
        yield JSON.stringify({ ...record, wireVersion: CLIENT_WIRE_VERSION })
      } else yield line
    }
  }
  for await (const chunk of readSyncStream(fixtureLines())) {
    if (chunk.type !== 'feedBootstrap') continue
    for (const change of chunk.changes) {
      if (change.op !== 'upsert') continue
      cache.put(change.entity as Parameters<ScenarioCache['put']>[0], change.entityId, change.value)
      const rows = byEntity.get(change.entity) ?? []
      rows.push(change.value)
      byEntity.set(change.entity, rows)
    }
  }
  phase = 2
  const raw = {
    issues: byEntity.get('issue') ?? [],
    issueProjections: byEntity.get('issueProjection') ?? [],
    issueUserStates: byEntity.get('issueUserState') ?? [],
    issueGitStates: byEntity.get('issueGitState') ?? [],
    sessions: byEntity.get('session') ?? [],
    repoProjections: byEntity.get('repo') ?? [],
    issueDeps: byEntity.get('issueDep') ?? [],
    repos: [],
    machines: [],
    pins: { repos: [], worktrees: [], panels: [] },
  } as LiveCollections
  const corpus = corpusFromLive(raw, Date.now())
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  const userStates = replica.rows('sessionUserStates')
  if (new Set(userStates.map((row) => row.userId)).size > 1)
    throw new Error('Ambiguous replay principal')
  const sessions = dedupeSessions(
    sessionViews(replica.rows('sessions'), {
      userId: userStates[0]?.userId ?? '',
      userStatesLoaded: replica.sessionUserStatesLoaded?.() ?? true,
      userStates,
      repos: replica.rows('repos'),
      machines: replica.rows('machines'),
    }),
  )
  const store = {
    ...sidebarReplayStore(corpus, replica),
    sessions,
    openIssueId: null,
  } as unknown as Store<PodiumClientApi>
  const runtime = {
    replica,
    getSnapshot: () => store,
    pendingOverlaysByRow: () => new Map(),
    subscribe: () => () => {},
  }
  const handle = createRuntimeWorklistPool(
    runtime as unknown as Parameters<typeof createRuntimeWorklistPool>[0],
    { summaries: MOBILE_SCREEN_SUMMARIES },
  )
  await attachMobileScreens(
    handle.pool,
    runtime as unknown as Parameters<typeof attachMobileScreens>[1],
  )
  try {
    phase = 3
    const issues = allIssueViewModels(replica, store.issueProjections, store.issueUserStates)
    const roots = [
      ...new Set(
        issues.flatMap((issue) => {
          const root = missionRootFor(issues, issue.id)
          return root && !root.archived && !root.deletedAt && !root.isDraftVessel ? [root.id] : []
        }),
      ),
    ]
    let checks = 0,
      positions = 0,
      differences = 0,
      pending = 0
    let first: {
      check: number
      sectionIndex: number
      rowIndex: number | null
      field: string
    } | null = null
    const tasks: NonNullable<MobileScreenCheck['tasks']> = {
      showDone: false,
      expanded: [],
      filter: {},
      ordering: 'priority',
      showAgentTasks: false,
    }
    const inputs: MobileScreenCheck[] = [null, ...roots].flatMap((selectedId) =>
      (['full', 'working', 'needs-you'] as const).map((mode) => ({
        legacy,
        tasks: selectedId === null ? tasks : null,
        selectedId,
        mode,
      })),
    )
    for (const option of [
      { ...tasks, showDone: true, expanded: roots.slice(0, 8), showAgentTasks: true },
      { ...tasks, filter: { stage: 'review' as const }, ordering: 'updated' as const },
      { ...tasks, filter: { archived: true }, showDone: true },
    ])
      inputs.push({ legacy, tasks: option, selectedId: roots[0] ?? null, mode: 'full' })
    for (const input of inputs) {
      const stop = reaction(
        () => poolMobileScreensSnapshot(handle.pool, input),
        () => {},
        { fireImmediately: true },
      )
      try {
        for (let round = 0; round < 64; round++) {
          runInAction(() => poolMobileScreensSnapshot(handle.pool, input))
          if (!handle.pool.hydrate()) break
        }
        const result = runInAction(() => checkMobileScreens(handle.pool, issues, sessions, input))
        checks++
        positions += result.rows
        differences += result.differences
        pending += result.pending
        if (!first && result.first)
          first = {
            check: checks,
            sectionIndex: result.first.sectionIndex,
            rowIndex: result.first.rowIndex,
            field: result.first.field,
          }
        if (checks % 100 === 0)
          console.log(JSON.stringify({ phase, checks, positions, differences, pending, first }))
      } finally {
        stop()
      }
    }
    console.log(
      JSON.stringify({
        issues: issues.length,
        sessions: sessions.length,
        roots: roots.length,
        operatorWireVersion,
        checks,
        positions,
        differences,
        pending,
        first,
      }),
    )
    if (differences || pending || !positions) process.exitCode = 1
  } finally {
    handle.dispose()
  }
}
if (import.meta.main)
  main().catch((error) => {
    const reason =
      error instanceof SyncStreamFailed
        ? error.reason
        : error instanceof Error &&
            ['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError'].includes(error.name)
          ? error.name
          : 'replay-failed'
    console.error(JSON.stringify({ failed: 1, phase, reason }))
    process.exitCode = 1
  })
