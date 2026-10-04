/** Read-only replay restricted to ludovico. Cookies, records, comparison values
 * and native error messages stay in memory; only counts and positions leave. */

import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { PodiumClientApi } from '@podium/client-core/api'
import { type Store, withKeyedInputs } from '@podium/client-core/engine'
import { storeStats } from '@podium/client-core/perf'
import {
  createKernelReplica,
  createSideCache,
  issueViewModelProjectionStats,
  memoryStorage,
} from '@podium/client-core/replica'
import { NdjsonLineReader, readSyncStream, SyncStreamFailed } from '@podium/client-core/sync-stream'
import { missionRootFor } from '@podium/client-core/viewmodels'
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
import type { MobileScreenInput } from './mobile-screens-snapshot'

const MAX_CHECKS_PER_POOL = 100
let phase = 0
async function main() {
  if (hostname() !== 'ludovico') throw new Error('Replay is restricted to ludovico')
  storeStats.enable()
  storeStats.reset()
  const { poolMobileScreensSnapshot } = await import('./mobile-screens-snapshot')
  const { mostRelevantSession } = await import('../../../apps/mobile/src/lib/mission-session')
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
  const store = {
    ...sidebarReplayStore(corpus, replica),
    sessions: [],
    openIssueId: null,
  } as unknown as Store<PodiumClientApi>
  const runtime = withKeyedInputs({
    replica,
    getSnapshot: () => store,
    pendingOverlaysByRow: () => new Map(),
    subscribe: () => () => {},
  })
  let poolBatches = 0
  async function openPool() {
    const handle = createRuntimeWorklistPool(
      runtime as unknown as Parameters<typeof createRuntimeWorklistPool>[0],
      { summaries: MOBILE_SCREEN_SUMMARIES },
    )
    try {
      await attachMobileScreens(
        handle.pool,
        runtime as unknown as Parameters<typeof attachMobileScreens>[1],
      )
      poolBatches++
      return handle
    } catch (error) {
      handle.dispose()
      throw error
    }
  }
  let handle = await openPool()
  try {
    phase = 3
    const issues = store.issueProjections
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
      pending = 0
    const tasks: NonNullable<MobileScreenInput['tasks']> = {
      showDone: false,
      expanded: [],
      filter: {},
      ordering: 'priority',
      showAgentTasks: false,
    }
    const inputs: MobileScreenInput[] = [null, ...roots].flatMap((selectedId) =>
      (['full', 'working', 'needs-you'] as const).map((mode) => ({
        selectSession: mostRelevantSession,
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
      inputs.push({ selectSession: mostRelevantSession, tasks: option, selectedId: roots[0] ?? null, mode: 'full' })
    for (const input of inputs) {
      // The offline walk opens every mission. Release its diagnostic pool
      // periodically while preserving the captured replica and mutation owner.
      if (checks > 0 && checks % MAX_CHECKS_PER_POOL === 0) {
        handle.dispose()
        handle = await openPool()
      }
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
        const output = runInAction(() => poolMobileScreensSnapshot(handle.pool, input))
        checks++
        if (typeof output === 'symbol') pending++
        else {
          pending += output.pending
          positions += output.sections.reduce((count, section) => count + section.rows.length, 0)
        }
        if (checks % 100 === 0) console.log(JSON.stringify({ phase, checks, positions, pending }))
        if (pending) break
      } finally {
        stop()
      }
    }
    const legacyRows = issueViewModelProjectionStats(replica).rowBuilds
    console.log(
      JSON.stringify({
        issues: issues.length,
        sessions: replica.rows('sessions').length,
        roots: roots.length,
        operatorWireVersion,
        checks,
        plannedChecks: inputs.length,
        poolBatches,
        maxChecksPerPool: MAX_CHECKS_PER_POOL,
        positions,
        pending,
        legacyIssueRowBuilds: legacyRows,
      }),
    )
    if (pending || legacyRows || !positions || checks !== inputs.length) process.exitCode = 1
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
