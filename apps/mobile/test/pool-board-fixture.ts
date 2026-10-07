/** Literal board and screening fixtures read through the production pool only. */
import type { IssueViewModel } from '@podium/client-core/replica'
import { createMobileInboxViews } from '@podium/client-graph/mobile-inbox-views'
import { attachMobileScreens } from '@podium/client-graph/mobile-screens'
import type { MobileTasksOptions } from '@podium/client-graph/mobile-screens-schema'
import { MobxPool } from '@podium/client-graph/pool'
import { readMobileTaskSnapshot } from '../../../tests/worklist/diagnostics/mobile-task-snapshot'
import { LOADING } from '@podium/client-graph/worklist/rollup'

const at = '2026-06-01T12:00:00.000Z'
function fixture(issues: readonly IssueViewModel[], workers: ReadonlyMap<string, number>) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(at) })
  const repos = new Map(
    issues.map((issue) => [
      issue.repoPath,
      {
        id: `repo:${issue.repoPath}`,
        repoPath: issue.repoPath,
        prefix: issue.displayRef?.match(/^(.+)-[0-9]+$/)?.[1],
      },
    ]),
  )
  pool.apply({
    type: 'replace',
    rows: [
      // The canonical feed carries a logical repo as a worktree record without a path.
      ...[...repos.values()].map((value) => ({
        kind: 'worktree' as const,
        id: value.id,
        value: value as never,
      })),
      ...issues.map((issue) => ({
        kind: 'issue' as const,
        id: issue.id,
        value: { ...issue, repoId: repos.get(issue.repoPath)?.id } as never,
      })),
      ...[...workers].flatMap(([issueId, count]) =>
        Array.from({ length: count }, (_, index) => {
          const sessionId = `worker:${issueId}:${index}`
          return {
            kind: 'session' as const,
            id: sessionId,
            value: {
              sessionId,
              issueId,
              cwd: issues.find((issue) => issue.id === issueId)?.repoPath,
              agentKind: 'codex',
              status: 'live',
              archived: false,
              createdAt: at,
              lastActiveAt: at,
              agentState: { phase: 'working', since: at },
            } as never,
          }
        }),
      ),
    ],
  })
  return pool
}

export async function readPoolTasks(
  issues: readonly IssueViewModel[],
  options: Partial<MobileTasksOptions> = {},
  workers: ReadonlyMap<string, number> = new Map(),
) {
  const pool = fixture(issues, workers)
  try {
    await attachMobileScreens(pool)
    const reader = pool.row('mobileScreenReader', 'reader')
    if (!reader || reader === LOADING) throw new Error('Resident task reader did not attach')
    const data = readMobileTaskSnapshot(pool, {
      showDone: false,
      expanded: [],
      filter: {},
      ordering: 'priority',
      showAgentTasks: false,
      ...options,
    })
    if (data === LOADING) throw new Error('Resident task fixture unexpectedly cold')
    return data
  } finally {
    pool.dispose()
  }
}

export function readPoolScreening(issues: readonly IssueViewModel[]) {
  const opened = openScreeningPool(issues)
  try {
    const data = opened.views.screening()
    if (data.booting) throw new Error('Resident screening fixture unexpectedly cold')
    return data.queue
  } finally {
    opened.dispose()
  }
}

/** A screening pool held open across publications, for incrementality guards:
 * one baseline read warms the keeper, then each update re-reads only the
 * changed keys instead of every proposal's summary. */
export function openScreeningPool(issues: readonly IssueViewModel[]) {
  const pool = fixture(issues, new Map())
  pool.sources.register(['mobileInboxState'], {
    read: () => ({ hasCursor: true }),
    dispose() {},
  })
  const views = createMobileInboxViews(pool)
  return {
    pool,
    views,
    issues,
    dispose() {
      views.dispose()
      pool.dispose()
    },
  }
}
