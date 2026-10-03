/** Ludovico-only read-only replay. Payloads/auth stay in memory, never logs. */
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { dedupeSessions, type Store } from '@podium/client-core/engine'
import {
  allIssueViewModels,
  createKernelReplica,
  createSideCache,
  memoryStorage,
} from '@podium/client-core/replica'
import { sessionViews } from '@podium/client-core/session-values'
import { NdjsonLineReader, readSyncStream } from '@podium/client-core/sync-stream'
import { inBoardCheck } from '@podium/client-graph/diagnostics/issue-board-check'
import {
  ISSUE_BOARD_ENTITIES,
  ISSUE_BOARD_SOURCE_KEY,
  ISSUE_BOARD_SUMMARIES,
} from '@podium/client-graph/issue-board-schema'
import { createIssueBoardSource } from '@podium/client-graph/issue-board-source'
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { CLIENT_WIRE_VERSION } from '@podium/protocol'
import { ScenarioCache } from '../../../packages/worklist-proto/shared/src/scenarios'
import { DEFAULT_DISPLAY } from '../src/features/issues/issues-display'
import { checkBoard, checkExplorer } from './board-control'

let phase = 0
async function main() {
  if (hostname() !== 'ludovico') throw new Error('Replay host')
  phase = 1
  const origin =
    process.argv.find((arg) => arg.startsWith('--origin='))?.slice(9) ?? 'http://127.0.0.1:18787'
  const { token } = JSON.parse(
    readFileSync(join(homedir(), '.podium/cli-session.json'), 'utf8'),
  ) as { token: string }
  const response = await fetch(`${origin}/sync/bootstrap`, {
    headers: { cookie: `podium_session=${token}` },
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok || !response.body) throw new Error('Bootstrap unavailable')
  const cache = new ScenarioCache()
  async function* lines() {
    for await (const line of NdjsonLineReader(response.body!)) {
      const record = JSON.parse(line)
      yield record.type === 'syncMeta'
        ? JSON.stringify({ ...record, wireVersion: CLIENT_WIRE_VERSION })
        : line
    }
  }
  for await (const chunk of readSyncStream(lines()))
    if (chunk.type === 'feedBootstrap')
      for (const change of chunk.changes) {
        if (change.op === 'upsert')
          cache.put(
            change.entity as Parameters<ScenarioCache['put']>[0],
            change.entityId,
            change.value,
          )
      }
  phase = 2
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  const users = replica.rows('sessionUserStates')
  if (new Set(users.map((row) => row.userId)).size > 1) throw new Error('Ambiguous principal')
  const sessions = dedupeSessions(
    sessionViews(replica.rows('sessions'), {
      userId: users[0]?.userId ?? '',
      userStatesLoaded: true,
      userStates: users,
      repos: replica.rows('repos'),
      machines: replica.rows('machines'),
    }),
  )
  const issues = allIssueViewModels(replica),
    now = Date.now()
  const state = {
    sessions,
    machines: replica.rows('machines'),
    repos: [],
    coarseNow: now,
    selectedIssueId: null,
    openIssueId: null,
    issueProjections: replica.rows('issueProjections'),
    issueUserStates: replica.rows('issueUserStates'),
    pins: { repos: [], worktrees: [] },
    sidebarSettings: { repoOrder: [] },
  } as unknown as Store
  const runtime = {
    replica,
    getSnapshot: () => state,
    subscribe: () => () => {},
    pendingOverlaysByRow: () => new Map(),
  }
  const handle = createRuntimeWorklistPool(runtime as never, { summaries: ISSUE_BOARD_SUMMARIES })
  await handle.pool.sources.ensure(ISSUE_BOARD_SOURCE_KEY, ISSUE_BOARD_ENTITIES, () =>
    createIssueBoardSource(handle.pool, runtime),
  )
  try {
    phase = 3
    const before = handle.pool.tables.issue.size
    const reports = []
    for (const filter of [
      {},
      { stage: 'planning' as const },
      { status: 'ready' as const },
      { archived: true },
      { deleted: true },
    ]) {
      for (const layout of ['board', 'list'] as const)
        reports.push(
          inBoardCheck(() =>
            checkBoard(runtime as never, handle.pool, {
              display: { ...DEFAULT_DISPLAY, layout },
              filter,
              expanded: [],
              isMobile: false,
              openIssueId: null,
              now,
            }),
          ),
        )
    }
    for (const tab of [null, 'needs', 'in_progress', 'planning', 'done', 'cancelled'] as const)
      reports.push(inBoardCheck(() => checkExplorer(runtime as never, handle.pool, tab, '')))
    console.log(
      JSON.stringify({
        phase,
        issues: issues.length,
        sessions: sessions.length,
        comparisons: reports.length,
        differences: reports.reduce((n, report) => n + report.differences, 0),
        pending: reports.reduce((n, report) => n + report.pending, 0),
        first: reports.find((report) => report.first)?.first ?? null,
        residentBefore: before,
        residentAfter: handle.pool.tables.issue.size,
        cold: handle.pool.residency?.ids('issue', true).length,
      }),
    )
    if (
      !issues.length ||
      reports.some((report) => report.differences || report.pending) ||
      before !== handle.pool.tables.issue.size
    )
      process.exitCode = 1
  } finally {
    handle.dispose()
  }
}
if (import.meta.main)
  main().catch(() => {
    console.log(JSON.stringify({ phase, failed: true }))
    process.exitCode = 1
  })
