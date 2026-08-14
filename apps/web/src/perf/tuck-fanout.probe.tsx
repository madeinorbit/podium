/**
 * TUCK FAN-OUT PROBE (POD-1053) — throwaway diagnostic, not a CI gate.
 *
 * POD-1052's `tuck-latency.probe.tsx` measured the three COMPONENTS of a press
 * in isolation (`foldOverlays`, `issueViewModelsFromReplica`, the worklist
 * derivation). This one measures the PIPELINE the app actually runs, because
 * that is where POD-1053's fixes live: the shared view-model cache and the slice
 * publisher's dependency guard. Neither is visible from a component benchmark.
 *
 * A press is TWO folds, not one — the optimistic paint, then the server echo
 * that lands the same values as truth. Both are measured.
 *
 * The BEFORE column is a reconstruction rather than a checkout: it runs exactly
 * what the old code ran, on the same data, in the same process —
 *
 *   - `issueViewModelsFromReplica` per worklist derivation (the duplicate,
 *     uncached build `published.ts::issuesOf` used to do), plus
 *   - `buildIssueViewModels` over the whole project for `useReplicaIssues`, plus
 *   - the whole worklist derivation, unconditionally, because the old
 *     `sourceEqual` named `previous.issues === next.issues` and every fold hands
 *     it a new array.
 *
 * Run: bunx vitest run --root apps/web --config apps/web/vitest.tuck-fanout-probe.config.ts
 */
// RELATIVE IMPORTS, DELIBERATELY. A git worktree here carries no `node_modules`
// of its own, so `@podium/client-core/*` resolves up the tree to the MAIN
// checkout's sources — which would measure the code this branch is changing
// AWAY from. Reaching into the workspace by path is what makes the number
// belong to the working tree it is run in.

import type { IssueProjection } from '@podium/model'
import {
  type GitRepositoryWire,
  ISSUE_STAGES,
  type IssueWire,
  type SessionMeta,
} from '@podium/model/browser'
import { describe, it } from 'vitest'
import {
  foldOverlays,
  type PendingOverlay,
} from '../../../../packages/client-core/src/engine/overlay'
import { allIssueViewModels } from '../../../../packages/client-core/src/replica/issue-view-cache'
import {
  buildIssueViewModels,
  deriveIssueViewsSnapshot,
  issueViewModelsFromReplica,
} from '../../../../packages/client-core/src/replica/issue-view-models'
import { createReplica, memoryStorage } from '../../../../packages/client-core/src/replica/replica'
import { createSlicePublisher } from '../../../../packages/client-core/src/viewmodels/slices/publish'
import { worklistSlice } from '../../../../packages/client-core/src/viewmodels/slices/worklist/published'

/** Live Ludovico cardinalities as of 2026-08-14 (`podium issue list --json`). */
const SCALE = {
  issues: 1026,
  sessions: 530,
  repositories: 12,
  worktreesPerRepository: 8,
} as const

const NOW = Date.parse('2026-08-14T18:00:00.000Z')
const PRESSES = 9

function worktreePath(index: number): string {
  const repo = Math.floor(index / SCALE.worktreesPerRepository)
  const slot = index % SCALE.worktreesPerRepository
  return slot === 0 ? `/srv/repos/repo-${repo}` : `/srv/worktrees/wt-${index}`
}

function issueAt(index: number): IssueWire {
  const stage = ISSUE_STAGES[index % ISSUE_STAGES.length] ?? 'backlog'
  const worktree = index % (SCALE.repositories * SCALE.worktreesPerRepository)
  return {
    id: `issue-${String(index).padStart(4, '0')}`,
    displayRef: `POD-${10_000 + index}`,
    repoPath: `/srv/repos/repo-${Math.floor(worktree / SCALE.worktreesPerRepository)}`,
    seq: 10_000 + index,
    title: `Generated benchmark task ${index}`,
    description: `Anonymized deterministic task ${index % 17}`,
    stage,
    worktreePath: worktreePath(worktree),
    branch: `issue/${10_000 + index}-generated`,
    parentBranch: 'main',
    defaultAgent: index % 2 === 0 ? 'codex' : 'claude-code',
    blockedByNotes: [],
    createdAt: `2026-07-${String((index % 17) + 1).padStart(2, '0')}T08:00:00.000Z`,
    updatedAt: `2026-07-${String((index % 17) + 1).padStart(2, '0')}T12:00:00.000Z`,
    archived: false,
    needsHuman: index % 19 === 0,
    origin: index % 7 === 0 ? 'agent' : 'human',
    audience: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    priority: index % 5,
    type: index % 23 === 0 ? 'bug' : 'task',
    pinned: false,
    labels: [`area-${index % 8}`, `lane-${index % 3}`],
    deps: [],
    dependents: [],
    comments: [],
    ready: true,
    blocked: false,
    deferred: false,
    readAt: null,
    tuckedAt: null,
  } as unknown as IssueWire
}

function projectionOf(issue: IssueWire): IssueProjection {
  return {
    id: issue.id,
    seq: issue.seq,
    parentId: null,
    repoId: `repo_${issue.repoPath}`,
    stage: issue.stage,
    updatedAt: issue.updatedAt,
    createdAt: issue.createdAt,
    description: { value: issue.description },
    worktreePath: issue.worktreePath,
    branch: issue.branch,
    title: issue.title,
    priority: issue.priority,
    labels: issue.labels,
    archived: issue.archived,
    type: issue.type,
    intentOrigin: 'human',
    audience: 'human',
    isDraftVessel: false,
  } as unknown as IssueProjection
}

function sessionAt(index: number): SessionMeta {
  const worktree = index % (SCALE.repositories * SCALE.worktreesPerRepository)
  return {
    sessionId: `session-${String(index).padStart(4, '0')}`,
    agentKind: index % 2 === 0 ? 'codex' : 'claude-code',
    cwd: `${worktreePath(worktree)}/apps/web`,
    title: `Generated session ${index}`,
    status: 'live',
    controllerId: `controller-${index % 12}`,
    geometry: { cols: 120, rows: 36 },
    epoch: 1,
    clientCount: 1,
    createdAt: '2026-07-18T08:00:00.000Z',
    lastActiveAt: `2026-07-18T${String(8 + (index % 10)).padStart(2, '0')}:00:00.000Z`,
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: index % 11 === 0,
    issueId: index % 3 === 0 ? `issue-${String(index).padStart(4, '0')}` : undefined,
    agentState: { phase: 'working', since: '2026-07-18T08:00:00.000Z' },
  } as unknown as SessionMeta
}

function repositories(): GitRepositoryWire[] {
  return Array.from({ length: SCALE.repositories }, (_, repoIndex) => ({
    path: `/srv/repos/repo-${repoIndex}`,
    branch: 'main',
    originUrl: `github.com/anonymized/repo-${repoIndex}`,
    machineId: `machine-${repoIndex % 3}`,
    worktrees: Array.from({ length: SCALE.worktreesPerRepository - 1 }, (_, child) => {
      const worktree = repoIndex * SCALE.worktreesPerRepository + child + 1
      return { path: `/srv/worktrees/wt-${worktree}`, branch: `issue/${worktree}-generated` }
    }),
  })) as unknown as GitRepositoryWire[]
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const round = (value: number): number => Math.round(value * 100) / 100

function report(name: string, values: Record<string, number>): void {
  console.info(`[tuck-fanout] ${JSON.stringify({ name, ...values })}`)
}

describe('tuck fan-out probe', () => {
  it('costs one row per press instead of one project', () => {
    const replica = createReplica({ storage: memoryStorage() })
    const issues = Array.from({ length: SCALE.issues }, (_, index) => issueAt(index))
    const sessions = Array.from({ length: SCALE.sessions }, (_, index) => sessionAt(index))
    const repos = repositories()
    replica.applySnapshot('issues', issues)
    replica.applySnapshot('issueProjections', issues.map(projectionOf))
    replica.applySnapshot('sessions', sessions)
    replica.applySnapshot(
      'repos',
      repos.map((repo) => ({ id: `repo_${repo.path}`, path: repo.path, prefix: 'POD' })) as never[],
    )

    const machines: never[] = []
    const pins = { panels: [], worktrees: [], repos: [] }
    const baseIssues = replica.rows('issues')
    const baseProjections = replica.rows('issueProjections')
    // biome-ignore lint/suspicious/noExplicitAny: probe fixture — the slice reads a documented subset
    const storeWith = (rows: readonly IssueWire[], projections = baseProjections): any => ({
      repos,
      machines,
      sessions,
      pins,
      issues: rows,
      issueProjections: projections,
      replica,
      coarseNow: NOW,
      selectedIssueId: null,
    })

    let store = storeWith(baseIssues)
    const publisher = createSlicePublisher(() => store)

    // Warm the JIT the way a real session is warm by the time you press.
    for (let i = 0; i < 3; i++) {
      publisher.read(worklistSlice)
      allIssueViewModels(replica, baseProjections, baseIssues)
      issueViewModelsFromReplica(replica, baseProjections, baseIssues)
    }

    const tuckOverlay = (index: number): PendingOverlay[] => [
      {
        op: 'patch',
        entity: 'issues',
        id: `issue-${String(index).padStart(4, '0')}`,
        key: `mutation-${index}`,
        patch: { tuckedAt: new Date(NOW).toISOString() },
        coveredBy: () => false,
      } as PendingOverlay,
    ]

    // ------------------------------------------------------------------ NOW
    const paintModels: number[] = []
    const paintSlice: number[] = []
    const echoModels: number[] = []
    const echoSlice: number[] = []
    for (let press = 0; press < PRESSES; press++) {
      const target = 500 + press
      const pressBase = replica.rows('issues')
      const projections = replica.rows('issueProjections')
      const { rows } = foldOverlays(pressBase as IssueWire[], tuckOverlay(target), (r) => r.id)

      // THE OPTIMISTIC PAINT. The overlay fold hands the store a new array with
      // one new row; a row genuinely moved, so the worklist genuinely re-derives.
      store = storeWith(rows, projections)
      const paintModelsStarted = performance.now()
      allIssueViewModels(replica, projections, rows) // what `useReplicaIssues` reads
      paintModels.push(performance.now() - paintModelsStarted)
      const paintSliceStarted = performance.now()
      publisher.read(worklistSlice)
      paintSlice.push(performance.now() - paintSliceStarted)

      // THE ECHO. Server truth lands the same values as fresh replica rows, so
      // the replica-derived world is rebuilt and every model with it — and
      // NOTHING VISIBLE MOVED, which is the half the slice must now skip. Timed
      // from after the replica write: that is the authority's cost, not the
      // projection's.
      replica.applySnapshot(
        'issues',
        rows.map((row) => ({ ...row })),
      )
      store = storeWith(replica.rows('issues'), replica.rows('issueProjections'))
      const echoModelsStarted = performance.now()
      allIssueViewModels(replica, store.issueProjections, store.issues)
      echoModels.push(performance.now() - echoModelsStarted)
      const echoSliceStarted = performance.now()
      publisher.read(worklistSlice)
      echoSlice.push(performance.now() - echoSliceStarted)
    }

    // ------------------------------------------------------------- BEFORE
    // The same two folds, costed the way the old code costed them.
    const beforePaint: number[] = []
    for (let press = 0; press < PRESSES; press++) {
      const target = 500 + press
      const { rows } = foldOverlays(
        replica.rows('issues') as IssueWire[],
        tuckOverlay(target),
        (r) => r.id,
      )
      const started = performance.now()
      // `useReplicaIssues` rebuilt every model for the new array identity…
      const projections = replica.rows('issueProjections')
      buildIssueViewModels(deriveIssueViewsSnapshot(replica), projections, rows)
      // …and `published.ts::issuesOf` built them all again, uncached…
      const models = issueViewModelsFromReplica(replica, projections, rows)
      // …and the slice re-derived, because `previous.issues !== next.issues`.
      worklistSlice.derive(storeWith([...models.values()] as unknown as IssueWire[], projections))
      beforePaint.push(performance.now() - started)
    }

    report('press-now', {
      issues: SCALE.issues,
      sessions: SCALE.sessions,
      // The paint: one model rebuilt, and a worklist derivation that is real
      // work — a row moved, so the sidebar has to be re-laid out.
      paintModelsMsMedian: round(median(paintModels)),
      paintSliceMsMedian: round(median(paintSlice)),
      // The echo: the replica-derived world is re-derived whole, but POD-1055
      // hands each unchanged issue back its previous `IssueView`, so the models
      // reuse row by row and the slice sees that nothing moved and skips.
      echoModelsMsMedian: round(median(echoModels)),
      echoSliceMsMedian: round(median(echoSlice)),
      pressMsMedian: round(
        median(paintModels) + median(paintSlice) + median(echoModels) + median(echoSlice),
      ),
    })
    report('press-before', {
      issues: SCALE.issues,
      sessions: SCALE.sessions,
      paintMsMedian: round(median(beforePaint)),
      paintMsMax: round(Math.max(...beforePaint)),
      // Both halves of the press paid the same price.
      pressMsMedian: round(median(beforePaint) * 2),
    })
  })
})
